import { spawn } from 'node:child_process'
import { createHash, randomUUID, X509Certificate } from 'node:crypto'
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createServer as createTlsServer } from 'node:https'
import { homedir } from 'node:os'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeContextEntry, retrieveContext } from './server/context-store.mjs'
import { runCodexCli } from './server/codex-executor.mjs'
import { runCodexAppServer } from './server/codex-app-server-executor.mjs'
import { inspectCodexHarness, inspectDeepSeekHarness } from './server/harness-discovery.mjs'
import { runClaudeCode } from './server/claude-code-executor.mjs'
import { deepSeekApiUrl, deepSeekDefaultModel, isOfficialDeepSeekUrl, runDeepSeekApi } from './server/deepseek-executor.mjs'
import { runPi } from './server/pi-executor.mjs'
import { createExecutorRegistry } from './server/executor-registry.mjs'
import { assertWorkflowDataIntegrity, createSerializedWriter, CURRENT_WORKFLOW_SCHEMA_VERSION, migrateWorkflowData } from './server/workflow-store.mjs'
import { deterministicOccurrenceId, nextScheduleAt, normalizeRecurrence } from './server/scheduler.mjs'
import { deliveryEvents, nextDeliveryState, transmitBot, transmitInboundReply, validateBotUrl } from './server/delivery.mjs'
import { decodeInboundPayload, extractInboundMessage, identityAllowed, inboundEventRecordId, normalizeInboundSettings, parseInboundCommand, publicInboundEvent, publicInboundTarget } from './server/inbound-delivery.mjs'
import { createLocalAuth } from './server/local-auth.mjs'
import { projectForRun, projectForTask, publicMember, updateMember, viewerProjectIds, viewerRun } from './server/project-access.mjs'
import { createCredentialVault, isVaultCiphertext } from './server/credential-vault.mjs'
import { httpsHostAllowed, httpsRequestAllowed, loadTlsOptions, loadWorkbenchAssets, parseHttpsOrigin } from './server/https-workbench.mjs'
import { auditAction, auditFileSizes, createAuditLog } from './server/audit-log.mjs'
import { assertPrivateCredentials, assertPrivateOrigin, clientAddressAllowed, resolveDeploymentConfig } from './server/deployment-config.mjs'
import { lockDataDirectory, releaseDataLock } from './server/data-lock.mjs'
import { createDesktopRequestGuard } from './server/desktop-guard.mjs'

const desktopMode = process.env.ZHIDIAN_DESKTOP_MODE === '1'
const desktopToken = process.env.ZHIDIAN_DESKTOP_TOKEN
// The desktop token is inherited by this process only to initialize the HTTP guard.
// Never pass it onward to a Harness or other child process through process.env.
if (desktopMode) delete process.env.ZHIDIAN_DESKTOP_TOKEN
const deployment = desktopMode ? resolveDeploymentConfig({}) : resolveDeploymentConfig()
const host = desktopMode ? '127.0.0.1' : deployment.host
const port = Number(process.env.ZHIDIAN_API_PORT ?? (desktopMode ? 0 : 8787))
let boundPort = port
const uiPort = Number(process.env.ZHIDIAN_UI_PORT ?? 5173)
if (!Number.isInteger(port) || port < (desktopMode ? 0 : 1) || port > 65535 || !Number.isInteger(uiPort) || uiPort < 1 || uiPort > 65535) throw new Error('Invalid Zhidian API or UI port.')
if (desktopMode && (!desktopToken || !/^[A-Za-z0-9_-]{43}$/.test(desktopToken))) throw new Error('Desktop mode requires an ephemeral 32-byte application token.')
const desktopRequestAllowed = desktopMode ? createDesktopRequestGuard(desktopToken) : null
const dataDir = process.env.ZHIDIAN_DATA_DIR ?? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Zhidian')

let harnessStatusCache = null
let harnessStatusCacheUntil = 0
let harnessStatusCheck = null

async function getHarnessStatuses() {
  if (harnessStatusCache && Date.now() < harnessStatusCacheUntil) return harnessStatusCache
  if (harnessStatusCheck) return harnessStatusCheck
  harnessStatusCheck = Promise.all([inspectCodexHarness(), inspectDeepSeekHarness()]).then(([codex, deepseek]) => {
    harnessStatusCache = [codex, deepseek]
    harnessStatusCacheUntil = Date.now() + 15_000
    return harnessStatusCache
  }).finally(() => { harnessStatusCheck = null })
  return harnessStatusCheck
}
const checkPilot = process.argv.includes('--check-pilot')
const checkData = checkPilot || process.argv.includes('--check-data')
const rotateCredentials = process.argv.includes('--rotate-credentials')
if (checkData && (!process.env.ZHIDIAN_DATA_DIR || !isAbsolute(dataDir) || rotateCredentials)) throw new Error('Data checking requires an explicit absolute ZHIDIAN_DATA_DIR and cannot be combined with credential rotation.')
if (checkPilot && process.argv.includes('--check-data')) throw new Error('Use only one check mode.')
const configPath = join(dataDir, 'providers.json')
const maxBodyBytes = 64 * 1024
const runsPath = join(dataDir, 'runs.json')
const workflowPath = join(dataDir, 'workflow.json')
const sqlitePath = join(dataDir, 'workflow.sqlite')
const maxProjectFiles = 180
const maxSnapshotBytes = 45 * 1024
const members = new Map()
const httpsOrigin = parseHttpsOrigin(process.env.ZHIDIAN_HTTPS_ORIGIN)
if (checkPilot && !httpsOrigin) throw new Error('Pilot preflight requires ZHIDIAN_HTTPS_ORIGIN.')
assertPrivateOrigin(deployment, httpsOrigin, port)
const auth = createLocalAuth(process.env.ZHIDIAN_OWNER_KEY_HASH, { findMember: (id) => members.get(id), secure: Boolean(httpsOrigin) })
let sqliteStore
let credentialVault
const allowedTextExtensions = new Set(['.js', '.jsx', '.ts', '.tsx', '.json', '.css', '.html', '.md', '.mjs', '.cjs', '.yml', '.yaml', '.toml'])

const providerDefinitions = {
  OpenAI: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', keyRequired: true, kind: 'openai' },
  Anthropic: { label: 'Anthropic / Claude', baseUrl: 'https://api.anthropic.com', keyRequired: true, kind: 'anthropic' },
  DeepSeek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', keyRequired: true, kind: 'openai' },
  'OpenAI Compatible': { label: '兼容 OpenAI API', baseUrl: '', keyRequired: true, kind: 'openai' },
  Local: { label: '本地模型', baseUrl: 'http://localhost:11434/v1', keyRequired: false, kind: 'openai' },
}

const providers = new Map(Object.entries(providerDefinitions).map(([id, definition]) => [id, {
  baseUrl: id === 'DeepSeek' ? deepSeekApiUrl : definition.baseUrl,
  apiKey: '',
}]))
const runs = new Map()
const runControllers = new Map()
const workflow = {
  projects: new Map(),
  sessions: new Map(),
  tasks: new Map(),
  reviews: new Map(),
  contextEntries: new Map(),
  threads: new Map(),
  messages: new Map(),
  schedules: new Map(),
  occurrences: new Map(),
  deliveryTargets: new Map(),
  deliveries: new Map(),
  inboundTargets: new Map(),
  inboundEvents: new Map(),
}
const eventClients = new Map()
const sessionStreams = new Map()
const viewerStreams = new WeakSet()
const summaryStreams = new WeakSet()
const pendingSubmissions = new Map()
const auditRequests = new WeakMap()
const queue = []
let queuePromise = null
let shuttingDown = false
let shutdownPromise = null
let schedulerTimer
let schedulerPromise = null
let deliveryTimer
let deliveryPromise = null
const workflowEpoch = randomUUID()
let workflowRevision = 0
const executionDefaults = {
  maxFiles: 12,
  maxFileBytes: 48 * 1024,
  maxOutputBytes: 24 * 1024,
  commandTimeoutMs: 120_000,
}

function powershell(operation) {
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security | Out-Null; $inputValue=[Console]::In.ReadToEnd(); $bytes=[Convert]::FromBase64String($inputValue); ${operation === 'protect'
    ? '$result=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);'
    : '$result=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);'} [Console]::Out.Write([Convert]::ToBase64String($result))`
  const encodedScript = Buffer.from(script, 'utf16le').toString('base64')

  return (payload) => new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      reject(new Error('当前版本使用 Windows 用户级凭据加密；此系统暂不支持保存 API Key。'))
      return
    }
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => reject(new Error(`Windows 凭据加密失败：${error.message}`)))
    child.on('close', (code) => {
      if (code !== 0 || !stdout.trim()) {
        reject(new Error(`Windows 凭据加密失败：${stderr.trim() || 'PowerShell 未返回结果'}`))
        return
      }
      resolve(stdout.trim())
    })
    child.stdin.end(operation === 'protect' ? Buffer.from(payload, 'utf8').toString('base64') : payload)
  })
}

const protect = powershell('protect')
const unprotect = powershell('unprotect')

function sealCredential(scope, value) {
  return credentialVault ? credentialVault.seal(scope, value) : protect(value)
}

async function readCredential(scope, value) {
  if (isVaultCiphertext(value)) {
    if (!credentialVault) throw new Error('Instance credential keyring is required.')
    return credentialVault.open(scope, value)
  }
  return Buffer.from(await unprotect(value), 'base64').toString('utf8')
}

async function readDeliveryCredential(target) {
  const { url, secret } = JSON.parse(await readCredential(`delivery:${target.id}`, target.encryptedCredentials))
  if (typeof secret !== 'string' || secret.length > 512) throw new Error('Invalid delivery signing credential.')
  return { url: validateBotUrl(target.channel, url), secret }
}

async function readInboundCredential(target) {
  const value = JSON.parse(await readCredential(`inbound:${target.projectId}`, target.encryptedCredentials))
  if (typeof value.verificationToken !== 'string' || value.verificationToken.length < 1 || value.verificationToken.length > 512 || typeof value.encryptKey !== 'string' || value.encryptKey.length < 1 || value.encryptKey.length > 512) {
    throw new Error('Invalid inbound delivery credential.')
  }
  if (value.appSecret !== undefined && (typeof value.appSecret !== 'string' || value.appSecret.length > 512)) throw new Error('Invalid inbound app secret.')
  return value
}

async function loadProviders() {
  try {
    const stored = JSON.parse(await readFile(configPath, 'utf8'))
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw new Error('Invalid provider configuration.')
    for (const [id, value] of Object.entries(stored)) {
      if (!providers.has(id) || !value || typeof value !== 'object') continue
      const current = providers.get(id)
      current.baseUrl = typeof value.baseUrl === 'string' ? value.baseUrl : current.baseUrl
      if (typeof value.encryptedApiKey === 'string' && value.encryptedApiKey) {
        current.apiKey = await readCredential(`provider:${id}`, value.encryptedApiKey)
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Could not read instance provider settings and credentials.')
  }
}

const persistProviders = createSerializedWriter(async () => {
  await mkdir(dataDir, { recursive: true })
  const stored = {}
  for (const [id, provider] of providers) {
    stored[id] = {
      baseUrl: provider.baseUrl,
      encryptedApiKey: provider.apiKey ? await sealCredential(`provider:${id}`, provider.apiKey) : '',
    }
  }
  await writeJsonAtomically(configPath, stored)
})

async function loadRuns() {
  try {
    const stored = JSON.parse(await readFile(runsPath, 'utf8'))
    if (!Array.isArray(stored)) throw new Error('Legacy run store must be an array.')
    for (const run of stored) {
      if (run && typeof run.id === 'string') runs.set(run.id, run)
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

async function writeJsonAtomically(filePath, value) {
  await mkdir(dataDir, { recursive: true })
  const tempPath = `${filePath}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}.tmp`
  await writeFile(tempPath, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
  await rename(tempPath, filePath)
}

async function loadWorkflow() {
  let original
  try {
    const dbState = sqliteStore?.read()
    if (checkData && sqliteStore && !dbState) throw new Error('No initialized workflow in SQLite; will not fall back to stale JSON.')
    original = dbState ?? JSON.parse(await readFile(workflowPath, 'utf8'))
    const stored = migrateWorkflowData(original)
    if (original.schemaVersion < 3 || original.schemaVersion === undefined) await loadRuns()
    for (const run of stored.runs) runs.set(run.id, run)
    for (const run of runs.values()) run.threadId ??= stored.tasks.find((task) => task.id === run.taskId)?.threadId
    for (const project of stored.projects) if (project?.id) workflow.projects.set(project.id, project)
    for (const session of stored.sessions) if (session?.id) workflow.sessions.set(session.id, session)
    for (const task of stored.tasks) if (task?.id) workflow.tasks.set(task.id, task)
    for (const review of stored.reviews) if (review?.id) workflow.reviews.set(review.id, review)
    for (const entry of stored.contextEntries) if (entry?.id) workflow.contextEntries.set(entry.id, entry)
    for (const thread of stored.threads) if (thread?.id) workflow.threads.set(thread.id, thread)
    for (const message of stored.messages) if (message?.id) workflow.messages.set(message.id, message)
    for (const schedule of stored.schedules) workflow.schedules.set(schedule.id, schedule)
    for (const occurrence of stored.occurrences) workflow.occurrences.set(occurrence.id, occurrence)
    for (const target of stored.deliveryTargets) workflow.deliveryTargets.set(target.id, target)
    for (const delivery of stored.deliveries) workflow.deliveries.set(delivery.id, delivery)
    for (const target of stored.inboundTargets ?? []) workflow.inboundTargets.set(target.id, target)
    for (const event of stored.inboundEvents ?? []) workflow.inboundEvents.set(event.id, event)
    for (const member of stored.members) members.set(member.id, member)
    if (members.size && !auth.enabled) throw new Error('A store with configured members requires ZHIDIAN_OWNER_KEY_HASH.')
    // Authenticate delivery envelopes before migration or rotation writes any records.
    const rotated = []
    for (const target of workflow.deliveryTargets.values()) {
      if (!checkData && !credentialVault && !isVaultCiphertext(target.encryptedCredentials)) continue
      const scope = `delivery:${target.id}`
      let credential
      try { credential = await readDeliveryCredential(target) } catch { throw new Error('Could not read instance delivery credentials.') }
      if (rotateCredentials) rotated.push([target, credentialVault.seal(scope, JSON.stringify(credential))])
    }
    for (const target of workflow.inboundTargets.values()) {
      if (!checkData && !credentialVault && !isVaultCiphertext(target.encryptedCredentials)) continue
      const scope = `inbound:${target.projectId}`
      let credential
      try { credential = await readInboundCredential(target) } catch { throw new Error('Could not read instance inbound delivery credentials.') }
      if (rotateCredentials) rotated.push([target, credentialVault.seal(scope, JSON.stringify(credential))])
    }
    if (checkData) return
    if (sqliteStore && !dbState) {
      await persistWorkflow()
      console.log('Imported workflow into SQLite; legacy JSON files were preserved.')
    } else if (!dbState && original.schemaVersion !== CURRENT_WORKFLOW_SCHEMA_VERSION) {
      const backupPath = `${workflowPath}.backup-v${original.schemaVersion ?? 1}-${Date.now()}.json`
      await copyFile(workflowPath, backupPath)
      await persistWorkflow()
      console.log(`Migrated workflow data to schema v${CURRENT_WORKFLOW_SCHEMA_VERSION}; original backup: ${backupPath}`)
    }
    for (const [target, envelope] of rotated) target.encryptedCredentials = envelope
  } catch (error) {
    if (checkData || error.code !== 'ENOENT' || original) throw new Error(`Could not load workflow state: ${error.message}`, { cause: error })
    await loadRuns()
  }
}

const writeWorkflow = createSerializedWriter(async () => {
  await mkdir(dataDir, { recursive: true })
  const stored = {
    schemaVersion: CURRENT_WORKFLOW_SCHEMA_VERSION,
    projects: [...workflow.projects.values()],
    sessions: [...workflow.sessions.values()],
    tasks: [...workflow.tasks.values()],
    reviews: [...workflow.reviews.values()],
    contextEntries: [...workflow.contextEntries.values()],
    threads: [...workflow.threads.values()],
    messages: [...workflow.messages.values()],
    runs: [...runs.values()],
    schedules: [...workflow.schedules.values()],
    occurrences: [...workflow.occurrences.values()],
    deliveryTargets: [...workflow.deliveryTargets.values()],
    deliveries: [...workflow.deliveries.values()],
    inboundTargets: [...workflow.inboundTargets.values()],
    inboundEvents: [...workflow.inboundEvents.values()],
    members: [...members.values()],
  }
  assertWorkflowDataIntegrity(stored)
  try {
    if (sqliteStore) sqliteStore.write(stored)
    else await writeJsonAtomically(workflowPath, stored)
  } catch (error) {
    console.error(`Workflow persistence failed; stopping before more work can run: ${error.message}`)
    process.exit(1)
  }
})

function persistWorkflow() {
  workflowRevision += 1
  return writeWorkflow()
}
const persistRuns = persistWorkflow

function id(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function now() {
  return new Date().toISOString()
}

function projectPathIsInside(projectPath, candidatePath) {
  const root = resolve(projectPath)
  const candidate = resolve(candidatePath)
  const relativePath = relative(root, candidate)
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
}

async function assertProjectPath(project, candidatePath) {
  if (!project?.path || !projectPathIsInside(project.path, candidatePath)) {
    throw Object.assign(new Error('目标路径不在已授权项目目录内。'), { status: 403 })
  }

  const root = resolve(project.path)
  let rootReal
  try {
    rootReal = await realpath(root)
  } catch {
    throw Object.assign(new Error('授权项目目录已不存在或无法访问。'), { status: 403 })
  }
  if (!projectPathIsInside(root, rootReal) || !projectPathIsInside(rootReal, root)) {
    throw Object.assign(new Error('授权项目目录的真实路径已改变，请重新授权。'), { status: 403 })
  }

  const candidate = resolve(candidatePath)
  const parts = relative(root, candidate).split(sep).filter(Boolean)
  let current = root
  for (const [index, part] of parts.entries()) {
    current = join(current, part)
    let info
    try {
      info = await lstat(current)
    } catch (error) {
      if (error.code === 'ENOENT') break
      throw error
    }
    if (info.isSymbolicLink()) {
      throw Object.assign(new Error('项目路径包含符号链接或目录联接，已拒绝访问。'), { status: 403 })
    }
    const currentReal = await realpath(current)
    if (!projectPathIsInside(rootReal, currentReal)) {
      throw Object.assign(new Error('目标路径解析后超出授权项目目录。'), { status: 403 })
    }
    if (index < parts.length - 1 && !info.isDirectory()) {
      throw Object.assign(new Error('目标路径的父级不是目录。'), { status: 400 })
    }
  }
  return candidate
}

function addEvent(runId, event) {
  const run = runs.get(runId)
  const recorded = { id: id('event'), at: now(), ...event }
  if (run) {
    run.events = [...(run.events ?? []), recorded].slice(-100)
    workflowRevision += 1
  }
  const clients = eventClients.get(runId) ?? []
  const payload = eventFrame(runId, recorded)
  for (const response of clients) {
    if (response.writableEnded) continue
    const body = viewerStreams.has(response) ? `data: ${JSON.stringify({ type: 'run.snapshot', run: viewerRun(run) })}\n\n` : summaryStreams.has(response) ? summaryEventFrame(run, recorded) : payload
    if (!response.write(body) && response.writableLength > 256 * 1024) response.destroy()
  }
}

function summaryEventFrame(run, event) {
  const nextRun = event.nextRunId && runs.get(event.nextRunId)
  return eventFrame(run.id, { id: event.id, at: event.at, type: event.type, message: event.message?.slice(0, 500),
    run: runSummary(run), nextRunId: nextRun?.id, nextRun: nextRun ? runSummary(nextRun) : undefined })
}

function eventFrame(runId, event) {
  const cursor = typeof event.id === 'string' && /^[\w-]{1,100}$/.test(event.id) ? `id: ${event.id}\n` : ''
  return `${cursor}data: ${JSON.stringify({ runId, ...event })}\n\n`
}

function revokeStreams(key) {
  for (const stream of sessionStreams.get(key) ?? []) stream.end()
  sessionStreams.delete(key)
}

function subscribeRun(runId, response, authSession) {
  const clients = eventClients.get(runId) ?? []
  clients.push(response)
  eventClients.set(runId, clients)
  if (authSession?.role === 'viewer') viewerStreams.add(response)
  const streams = authSession ? sessionStreams.get(authSession.key) ?? new Set() : null
  streams?.add(response)
  if (authSession) sessionStreams.set(authSession.key, streams)
  const expiry = authSession && setTimeout(() => response.end(), Math.max(1, authSession.expiresAt - Date.now()))
  const heartbeat = setInterval(() => {
    if (!response.writableEnded && !response.write(': keepalive\n\n') && response.writableLength > 256 * 1024) response.destroy()
  }, 15_000)
  response.on('close', () => {
    const current = eventClients.get(runId) ?? []
    const next = current.filter((item) => item !== response)
    if (next.length) eventClients.set(runId, next)
    else eventClients.delete(runId)
    clearTimeout(expiry)
    clearInterval(heartbeat)
    streams?.delete(response)
    if (authSession && !streams.size) sessionStreams.delete(authSession.key)
  })
}

function writeRunEvents(run, response, authSession, lastEventId, summary = false) {
  if (authSession && (sessionStreams.get(authSession.key)?.size ?? 0) >= 16) {
    sendJson(response, 429, { error: '此会话打开的实时连接过多。' })
    return
  }
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' })
  const observer = authSession?.role === 'viewer'
  const snapshot = `data: ${JSON.stringify({ type: 'run.snapshot', run: observer ? viewerRun(run) : summary ? runSummary(run) : publicRun(run) })}\n\n`
  const events = run.events ?? []
  const afterCursor = typeof lastEventId === 'string' ? events.findIndex(({ id }) => id === lastEventId) + 1 : 0
  if (!summary) response.write(snapshot)
  if (!observer) for (const event of events.slice(afterCursor)) response.write(summary ? summaryEventFrame(run, event) : eventFrame(run.id, event))
  if (summary) { response.write(snapshot); summaryStreams.add(response) }
  subscribeRun(run.id, response, authSession)
}

async function listProjectFiles(root, current = root, result = []) {
  if (result.length >= maxProjectFiles) return result
  const entries = await readdir(current, { withFileTypes: true })
  for (const entry of entries) {
    if (result.length >= maxProjectFiles) break
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'build' || entry.isSymbolicLink()) continue
    const fullPath = join(current, entry.name)
    if (entry.isDirectory()) {
      await listProjectFiles(root, fullPath, result)
    } else if (entry.isFile()) {
      result.push(relative(root, fullPath))
    }
  }
  return result
}

async function projectSnapshot(project) {
  const files = await listProjectFiles(project.path)
  let bytes = 0
  const textFiles = []
  for (const file of files) {
    if (!allowedTextExtensions.has(extname(file).toLowerCase())) continue
    const fullPath = join(project.path, file)
    const fileInfo = await lstat(fullPath).catch(() => null)
    if (!fileInfo?.isFile() || fileInfo.nlink > 1) continue
    const content = await assertProjectPath(project, fullPath).then((safePath) => readFile(safePath, 'utf8')).catch(() => '')
    if (!content || bytes + content.length > maxSnapshotBytes) continue
    textFiles.push({ path: file, content })
    bytes += content.length
  }
  return { files, textFiles }
}

async function projectFileFingerprints(project) {
  const fingerprints = new Map()
  const files = await listProjectFiles(project.path)
  let totalBytes = 0
  for (const file of files) {
    const fullPath = join(project.path, file)
    const info = await lstat(fullPath).catch(() => null)
    if (!info?.isFile() || info.nlink > 1 || info.size > 1024 * 1024 || totalBytes + info.size > 16 * 1024 * 1024) continue
    try {
      const safePath = await assertProjectPath(project, fullPath)
      fingerprints.set(file, createHash('sha256').update(await readFile(safePath)).digest('hex'))
      totalBytes += info.size
    } catch {
      // Ignore paths that become unsafe or unavailable during execution.
    }
  }
  return fingerprints
}

function changedProjectFiles(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => before.get(path) !== after.get(path))
    .slice(0, executionDefaults.maxFiles)
}

function normalizeProjectInput(body) {
  const projectPath = typeof body.path === 'string' ? body.path.trim() : ''
  if (!projectPath || !isAbsolute(projectPath)) throw Object.assign(new Error('项目目录必须是绝对路径。'), { status: 400 })
  const accessMode = body.accessMode === 'execute' ? 'execute' : body.accessMode === 'write' ? 'write' : 'read-only'
  const allowedCommands = Array.isArray(body.allowedCommands)
    ? body.allowedCommands.filter((command) => typeof command === 'string' && command.trim()).map((command) => command.trim()).slice(0, 12)
    : []
  const verificationCommands = body.accessMode === 'execute' && Array.isArray(body.verificationCommands)
    ? body.verificationCommands.filter((command) => typeof command === 'string' && command.trim()).map((command) => command.trim().slice(0, 300)).slice(0, 8)
    : []
  return { path: resolve(projectPath), name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : projectPath.split(/[\\/]/).filter(Boolean).pop() ?? '项目', accessMode, allowedCommands, verificationCommands }
}

async function registerProject(body) {
  const input = normalizeProjectInput(body)
  const info = await stat(input.path).catch(() => null)
  if (!info?.isDirectory()) throw Object.assign(new Error('项目目录不存在，或不是文件夹。'), { status: 400 })
  const canonicalPath = await realpath(input.path)
  const canonicalInput = { ...input, path: canonicalPath }
  const existing = [...workflow.projects.values()].find((project) => project.path === canonicalPath)
  const project = existing
    ? { ...existing, ...canonicalInput, updatedAt: now() }
    : { id: id('project'), ...canonicalInput, createdAt: now(), updatedAt: now() }
  workflow.projects.set(project.id, project)
  await persistWorkflow()
  return project
}

function publicRun(run) {
  if (!run) return null
  return {
    id: run.id,
    taskId: run.taskId,
    sessionId: run.sessionId,
    threadId: run.threadId,
    phase: run.phase,
    status: run.status,
    mode: run.mode,
    agentName: run.agentName,
    provider: run.provider,
    model: run.model,
    executor: run.executor ?? 'model-api',
    harnessThreadId: run.harnessThreadId,
    harnessTurnId: run.harnessTurnId,
    agentId: run.agentId,
    subtask: run.subtask,
    taskTitle: run.taskTitle,
    skillNames: run.skillNames ?? [],
    createdAt: run.createdAt,
    completedAt: run.completedAt,
    output: run.output,
    error: run.error,
    plan: run.plan,
    execution: run.execution,
    review: run.review,
    events: run.events ?? [],
  }
}

function publicThread(thread) {
  if (!thread) return null
  return {
    id: thread.id,
    projectId: thread.projectId,
    projectName: workflow.projects.get(thread.projectId)?.name ?? '未知项目',
    title: thread.title,
    status: thread.status,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  }
}

function publicWorkflow() {
  return {
    projects: [...workflow.projects.values()],
    sessions: [...workflow.sessions.values()],
    tasks: [...workflow.tasks.values()],
    runs: [...runs.values()].map(publicRun),
    reviews: [...workflow.reviews.values()],
    threads: [...workflow.threads.values()].map(publicThread).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  }
}

const isActiveRun = (run) => run.status === 'queued' || run.status === 'running'
const taskStage = (status) => status === 'approved' ? 'approved' : ['reviewing', 'executed', 'awaiting-approval'].includes(status) ? 'review' : ['executing', 'needs-fix', 'failed', 'planned'].includes(status) ? 'writing' : 'research'
const stageOwners = { approved: '林同学', review: '测试 Agent', writing: '专业 Agent', research: 'CEO Agent' }

function taskSummary(task) {
  const project = workflow.projects.get(workflow.sessions.get(task.sessionId)?.projectId)
  return {
    id: task.id, threadId: task.threadId, title: task.title, brief: task.brief?.slice(0, 240) ?? '',
    status: task.status, executionMode: task.executionMode, updatedAt: task.updatedAt,
    projectId: project?.id, projectPath: project?.path, filesWritten: task.execution?.writtenFiles?.length ?? 0,
  }
}

function runSummary(run) {
  return { id: run.id, taskId: run.taskId, taskTitle: run.taskTitle, status: run.status, phase: run.phase, agentId: run.agentId, agentName: run.agentName, projectId: projectForRun(run, workflow) || undefined }
}

const compareHistory = (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)

function historyPage(records, params, matches, summarize) {
  const cursor = params.get('after')
  const anchor = cursor && records.get(cursor)
  if (cursor && !anchor) return null
  const query = (params.get('q') ?? '').trim().toLowerCase().slice(0, 400)
  const matching = [...records.values()].filter((record) => (!anchor || compareHistory(anchor, record) < 0) && matches(record, query))
  matching.sort(compareHistory)
  const items = matching.slice(0, 40)
  return { items: items.map(summarize), next: matching.length > items.length ? items.at(-1).id : null }
}

const deliveryHistoryLimit = 100

function* recentDeliveries(projectId, perProject = false) {
  const shownByProject = new Map()
  let shown = 0
  const items = [...workflow.deliveries.values()]
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (projectId && item.projectId !== projectId) continue
    if (perProject) {
      if (!workflow.projects.has(item.projectId)) continue
      const count = shownByProject.get(item.projectId) ?? 0
      if (count >= deliveryHistoryLimit) continue
      shownByProject.set(item.projectId, count + 1)
    }
    yield item
    if (!perProject && ++shown >= deliveryHistoryLimit) break
  }
}

function deliveryAlerts() {
  const alerts = new Map()
  for (const { projectId, status } of recentDeliveries(null, true)) {
    if (status !== 'failed' && status !== 'unknown') continue
    const summary = alerts.get(projectId) ?? { projectId, failed: 0, unknown: 0 }
    summary[status] += 1
    alerts.set(projectId, summary)
  }
  return [...alerts.values()]
}

function workbenchSummary() {
  const active = [...runs.values()].filter((run) => isActiveRun(run) && workflow.tasks.has(run.taskId))
  const recentRuns = [...runs.values()].reverse().filter((run) => workflow.tasks.has(run.taskId)).slice(0, 32)
  const tasks = [...workflow.tasks.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || compareHistory(a, b))
  const awaiting = tasks.filter((task) => task.status === 'awaiting-approval')
  const recent = new Map(tasks.slice(0, 40).map((task) => [task.id, task]))
  for (const run of active) recent.set(run.taskId, workflow.tasks.get(run.taskId))
  const latestThread = [...workflow.threads.values()].reduce((latest, thread) => !latest || thread.updatedAt > latest.updatedAt ? thread : latest, null)
  return {
    projects: [...workflow.projects.values()], tasks: [...recent.values()].map(taskSummary), activeRuns: active.map(runSummary), recentRuns: recentRuns.map(runSummary),
    activeTaskCount: tasks.filter((task) => task.status !== 'approved').length,
    approvalQueue: { count: awaiting.length, preview: awaiting.slice(0, 3).map(taskSummary) },
    threadCount: workflow.threads.size, latestThreadId: latestThread?.id ?? null,
    hasScheduleSources: tasks.some((task) => task.agents?.ceo && task.agents?.qa),
    deliveryAlerts: deliveryAlerts(),
  }
}

function sendWorkflowState(request, response, view, build) {
  const tag = `W/"${workflowEpoch}-${workflowRevision}${view}"`
  if (!sendNotModified(request, response, tag)) sendJson(response, 200, build())
}

function sendNotModified(request, response, tag) {
  const validators = request.headers['if-none-match']?.split(',').map((part) => part.trim()) ?? []
  response.setHeader('etag', tag)
  if (!validators.some((value) => value === tag || value === tag.slice(2) || value === '*')) return false
  response.writeHead(304, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  response.end()
  return true
}

function redactThreadSecrets(value) {
  return String(value ?? '')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|ds-[A-Za-z0-9_-]{12,})\b/g, '[已脱敏凭据]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~-]{12,}/gi, '$1[已脱敏凭据]')
    .replace(/\b(api[_-]?key|token|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[已脱敏]')
}

function buildThreadContextSnapshot(threadId) {
  const messages = [...workflow.messages.values()]
    .filter((message) => message.threadId === threadId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-8)
    .map((message) => ({ role: message.role, content: redactThreadSecrets(message.content).slice(0, 1_200) }))
  const taskSummaries = [...workflow.tasks.values()]
    .filter((task) => task.threadId === threadId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-5)
    .map((task) => ({ title: task.title, status: task.status, summary: redactThreadSecrets(task.execution?.summary || task.plan?.summary || '').slice(0, 600) }))
  return { messages, taskSummaries }
}

function formatThreadContext(snapshot) {
  if (!snapshot) return '这是该线程的第一轮任务。'
  const parts = []
  for (const message of snapshot.messages ?? []) parts.push(`[${message.role}] ${message.content}`)
  for (const task of snapshot.taskSummaries ?? []) parts.push(`[既往任务：${task.status}] ${task.title}\n${task.summary}`)
  return parts.join('\n\n').slice(0, 8_000) || '这是该线程的第一轮任务。'
}

function saveThreadAssistantMessage(task, content, runId) {
  const thread = workflow.threads.get(task.threadId)
  if (!thread || !content) return
  const existing = task.assistantMessageId ? workflow.messages.get(task.assistantMessageId) : null
  const message = existing
    ? { ...existing, content: redactThreadSecrets(content).slice(0, 2_000), runId, updatedAt: now() }
    : { id: id('message'), threadId: thread.id, taskId: task.id, role: 'assistant', content: redactThreadSecrets(content).slice(0, 2_000), runId, createdAt: now(), updatedAt: now() }
  task.assistantMessageId = message.id
  workflow.messages.set(message.id, message)
  thread.updatedAt = now()
}

function publicThreadMessage(message) {
  return { ...message, content: redactThreadSecrets(message.content) }
}

function threadDetail(threadId) {
  const thread = workflow.threads.get(threadId)
  if (!thread) return null
  const tasks = [...workflow.tasks.values()].filter((task) => task.threadId === threadId).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const taskIds = new Set(tasks.map((task) => task.id))
  const taskRuns = [...runs.values()].filter((run) => taskIds.has(run.taskId)).map(publicRun).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const reviews = [...workflow.reviews.values()].filter((review) => taskIds.has(review.taskId))
  const messages = [...workflow.messages.values()].filter((message) => message.threadId === threadId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(publicThreadMessage)
  return { thread: publicThread(thread), messages, tasks, runs: taskRuns, reviews }
}

function sendJson(response, status, value) {
  const entry = auditRequests.get(response)
  if (entry) {
    auditRequests.delete(response)
    const resourceId = status < 300 ? (value.task?.id ?? value.run?.id ?? value.project?.id ?? value.member?.id ?? value.schedule?.id ?? value.occurrence?.id ?? value.entry?.id ?? value.target?.projectId ?? entry.resourceId) : undefined
    auditLog.record(entry, 'result', { status, resourceId })
  }
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(JSON.stringify(value))
}

function auditResource(response, resourceId) {
  const entry = auditRequests.get(response)
  if (entry) entry.resourceId = resourceId
}

const allowedUiOrigins = new Set([
  `http://127.0.0.1:${uiPort}`,
  `http://localhost:${uiPort}`,
])

function allowedApiHosts() {
  return new Set([
    '127.0.0.1:' + boundPort,
    'localhost:' + boundPort,
    '[::1]:' + boundPort,
  ])
}

function isAllowedUiOrigin(value) {
  if (typeof value !== 'string') return false
  try {
    const origin = new URL(value)
    return origin.origin === value && allowedUiOrigins.has(origin.origin)
  } catch {
    return false
  }
}

function isAllowedApiHost(value) {
  return typeof value === 'string' && allowedApiHosts().has(value.toLowerCase())
}

function providerUrlAllowed(id, url) {
  if (!httpsOrigin) return true
  if (id === 'DeepSeek') return isOfficialDeepSeekUrl(url)
  return ['OpenAI', 'Anthropic'].includes(id) && url === providerDefinitions[id].baseUrl
}

function requireProviderUrl(id, url) {
  if (!providerUrlAllowed(id, url)) throw Object.assign(new Error('HTTPS 试点仅允许内置服务商的官方 API 地址。'), { status: 403 })
  return url
}

async function readJson(request) {
  let size = 0
  const chunks = []
  for await (const chunk of request) {
    size += chunk.length
    if (size > maxBodyBytes) throw Object.assign(new Error('请求内容过大。'), { status: 413 })
    chunks.push(chunk)
  }
  try {
    return size ? JSON.parse(Buffer.concat(chunks, size).toString('utf8')) : {}
  } catch {
    throw Object.assign(new Error('请求内容不是有效 JSON。'), { status: 400 })
  }
}

function normalizeBaseUrl(value, allowBlank = false) {
  const baseUrl = typeof value === 'string' ? value.trim().replace(/\/+$/, '') : ''
  if (!baseUrl && allowBlank) return ''
  let parsed
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw Object.assign(new Error('请输入有效的服务商 API 地址。'), { status: 400 })
  }
  const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
    throw Object.assign(new Error('API 地址必须使用 HTTPS；仅本机地址允许 HTTP。'), { status: 400 })
  }
  return baseUrl
}

async function testProvider(id, body) {
  const definition = providerDefinitions[id]
  const saved = providers.get(id)
  const baseUrl = requireProviderUrl(id, normalizeBaseUrl(body.baseUrl ?? saved.baseUrl))
  const apiKey = typeof body.apiKey === 'string' && body.apiKey.trim() ? body.apiKey.trim() : saved.apiKey
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  if (!model) throw Object.assign(new Error('请填写用于连接测试的 Model ID。'), { status: 400 })
  if (definition.keyRequired && !apiKey) throw Object.assign(new Error('请先填写并保存 API Key，或在连接测试时临时填写。'), { status: 400 })

  if (id === 'DeepSeek') {
    const started = Date.now()
    await runDeepSeekApi({ baseUrl, apiKey, model, agentName: '连接测试', system: 'You are a connectivity check.', prompt: 'Reply with exactly OK.', maxTokens: 16, timeoutMs: 20_000 })
    return { message: 'DeepSeek 执行器已收到模型文本。', latencyMs: Date.now() - started }
  }

  const endpoint = definition.kind === 'anthropic'
    ? `${baseUrl.replace(/\/v1$/, '')}/v1/messages`
    : `${baseUrl}/chat/completions`
  const headers = { 'content-type': 'application/json' }
  const payload = { model, max_tokens: 8, messages: [{ role: 'user', content: 'Reply with exactly OK.' }] }
  if (definition.kind === 'anthropic') {
    headers['x-api-key'] = apiKey
    headers['anthropic-version'] = '2023-06-01'
  } else if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`
  }

  const started = Date.now()
  let upstream
  try {
    upstream = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    })
  } catch (error) {
    if (error.name === 'TimeoutError') throw Object.assign(new Error('连接超时，请检查地址、网络或本地模型服务。'), { status: 504 })
    throw Object.assign(new Error(`无法连接服务商：${error.message}`), { status: 502 })
  }

  if (!upstream.ok) {
    const responseBody = await upstream.json().catch(() => ({}))
    const detail = responseBody?.error?.message ?? responseBody?.message
    const safeDetail = typeof detail === 'string' ? (apiKey ? detail.replaceAll(apiKey, '[已隐藏]') : detail).slice(0, 320) : `服务商返回 HTTP ${upstream.status}。`
    throw Object.assign(new Error(safeDetail), { status: 502 })
  }

  return { message: '连接成功，模型已返回响应。', latencyMs: Date.now() - started }
}

function getTextContent(payload, kind) {
  if (kind === 'anthropic') {
    return Array.isArray(payload?.content)
      ? payload.content.filter((item) => item?.type === 'text').map((item) => item.text).join('\n').trim()
      : ''
  }
  const content = payload?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) return content.map((item) => typeof item === 'string' ? item : item?.text ?? '').join('').trim()
  return ''
}

async function callPlanningModel(body) {
  const providerId = typeof body.provider === 'string' ? body.provider : ''
  const definition = providerDefinitions[providerId]
  const saved = providers.get(providerId)
  if (!definition || !saved) throw Object.assign(new Error('未找到该 Agent 的模型服务商配置。'), { status: 400 })
  requireProviderUrl(providerId, saved.baseUrl)

  const model = typeof body.model === 'string' ? body.model.trim() : ''
  const title = typeof body.task?.title === 'string' ? body.task.title.trim() : ''
  const brief = typeof body.task?.brief === 'string' ? body.task.brief.trim() : ''
  const channel = typeof body.task?.channel === 'string' ? body.task.channel.trim() : ''
  const agentName = typeof body.agentName === 'string' ? body.agentName.trim() : 'Agent'
  const skills = Array.isArray(body.skills)
    ? body.skills.filter((skill) => skill && typeof skill.name === 'string').slice(0, 12)
    : []
  if (!model || !title) throw Object.assign(new Error('任务标题和 Model ID 不能为空。'), { status: 400 })
  if (definition.keyRequired && !saved.apiKey) throw Object.assign(new Error(`请先在模型接入页保存 ${definition.label} 的 API Key。`), { status: 400 })

  const skillContext = skills.length
    ? skills.map((skill, index) => `${index + 1}. ${skill.name}：${skill.description ?? ''}；验证：${skill.verification ?? ''}`).join('\n')
    : '当前岗位没有绑定 Skills，请明确标注需要补充的能力。'
  const system = `你是“织点”中的 ${agentName}。当前处于只读规划模式：只能分析需求、拆分任务、提出验证步骤，不能修改文件、运行命令、访问外部项目或声称已经完成执行。请基于岗位 Skills 输出一份可交接的执行计划，包含：目标理解、子任务、风险、验收标准、需要的工具权限。不要编造已经存在的文件或测试结果。`
  const prompt = `任务标题：${title}\n任务方向：${channel}\n任务背景与验收要求：${brief || '未提供'}\n\n岗位 Skills：\n${skillContext}\n\n请用中文输出结构化计划，使用清晰的小标题和编号列表。`
  if (providerId === 'DeepSeek') {
    const { output } = await runDeepSeekApi({ baseUrl: saved.baseUrl, apiKey: saved.apiKey, model, agentName, system, prompt, maxTokens: 1400, timeoutMs: 45_000 })
    return { output, provider: providerId, model }
  }
  const endpoint = definition.kind === 'anthropic'
    ? `${saved.baseUrl.replace(/\/v1$/, '')}/v1/messages`
    : `${saved.baseUrl}/chat/completions`
  const headers = { 'content-type': 'application/json' }
  const payload = definition.kind === 'anthropic'
    ? { model, max_tokens: 1400, system, messages: [{ role: 'user', content: prompt }] }
    : { model, temperature: 0.2, max_tokens: 1400, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }
  if (definition.kind === 'anthropic') {
    headers['x-api-key'] = saved.apiKey
    headers['anthropic-version'] = '2023-06-01'
  } else if (saved.apiKey) {
    headers.authorization = `Bearer ${saved.apiKey}`
  }

  let upstream
  try {
    upstream = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(45_000) })
  } catch (error) {
    if (error.name === 'TimeoutError') throw Object.assign(new Error('规划请求超时，请检查服务商地址或网络。'), { status: 504 })
    throw Object.assign(new Error(`无法连接模型服务商：${error.message}`), { status: 502 })
  }
  const responseBody = await upstream.json().catch(() => ({}))
  if (!upstream.ok) {
    const detail = responseBody?.error?.message ?? responseBody?.message
    const safeDetail = typeof detail === 'string' ? (saved.apiKey ? detail.replaceAll(saved.apiKey, '[已隐藏]') : detail).slice(0, 320) : `服务商返回 HTTP ${upstream.status}。`
    throw Object.assign(new Error(safeDetail), { status: 502 })
  }
  const output = getTextContent(responseBody, definition.kind)
  if (!output) throw Object.assign(new Error('模型返回了空的规划结果。'), { status: 502 })
  return { output, provider: providerId, model }
}

function agentIsConfigured(agent) {
  const executorId = typeof agent?.executor === 'string' && agent.executor ? agent.executor : 'model-api'
  return executorRegistry.isConfigured(executorId, agent, { providers, providerDefinitions })
}

function makeWorkflowRun(body, task, agentName, phase) {
  const executorId = typeof body.executor === 'string' && body.executor ? body.executor : 'model-api'
  if (!executorRegistry.has(executorId)) throw Object.assign(new Error(`未注册执行器“${executorId}”；已拒绝运行。`), { status: 400, code: 'UNKNOWN_EXECUTOR' })
  executorRegistry.authorize(executorId, { phase, accessMode: body.executionMode ?? task.executionMode })
  return {
    id: id('run'),
    taskId: task.id,
    sessionId: task.sessionId,
    threadId: task.threadId,
    phase,
    status: 'queued',
    mode: body.executionMode ?? 'read-only',
    agentName,
    provider: executorRegistry.get(executorId).provider || body.provider || '',
    model: body.model ?? '',
    taskTitle: task.title,
    skillNames: Array.isArray(body.skills) ? body.skills.map((skill) => skill.name).filter(Boolean).slice(0, 12) : [],
    executor: typeof body.executor === 'string' && body.executor ? body.executor : 'model-api',
    agentId: body.id ?? body.agentId,
    subtask: body.subtask,
    events: [],
    createdAt: now(),
  }
}

async function requestAgentModel({ providerId, model, agentName, system, prompt, maxTokens = 1600, timeoutMs = 60_000, signal }) {
  const definition = providerDefinitions[providerId]
  const saved = providers.get(providerId)
  if (!definition || !saved) throw Object.assign(new Error(`未找到 ${agentName} 的服务商配置。`), { status: 400 })
  requireProviderUrl(providerId, saved.baseUrl)
  if (!model) throw Object.assign(new Error(`${agentName} 没有填写 Model ID。`), { status: 400 })
  if (definition.keyRequired && !saved.apiKey) throw Object.assign(new Error(`请先在模型接入页保存 ${definition.label} 的 API Key。`), { status: 400 })
  if (providerId === 'DeepSeek') {
    const { output } = await runDeepSeekApi({ baseUrl: saved.baseUrl, apiKey: saved.apiKey, model, agentName, system, prompt, maxTokens, timeoutMs, signal })
    return output
  }
  const endpoint = definition.kind === 'anthropic' ? `${saved.baseUrl.replace(/\/v1$/, '')}/v1/messages` : `${saved.baseUrl}/chat/completions`
  const headers = { 'content-type': 'application/json' }
  const payload = definition.kind === 'anthropic'
    ? { model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt }] }
    : { model, temperature: 0.15, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }
  if (definition.kind === 'anthropic') {
    headers['x-api-key'] = saved.apiKey
    headers['anthropic-version'] = '2023-06-01'
  } else if (saved.apiKey) {
    headers.authorization = `Bearer ${saved.apiKey}`
  }
  let upstream
  try {
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
    upstream = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload), redirect: 'error', signal: requestSignal })
  } catch (error) {
    if (signal?.aborted) throw Object.assign(new Error(`${agentName} 模型请求已取消。`), { name: 'AbortError', code: 'ABORT_ERR', status: 499 })
    if (error.name === 'TimeoutError') throw Object.assign(new Error(`${agentName} 模型请求超时。`), { name: 'TimeoutError', code: 'EXECUTOR_TIMEOUT', status: 504 })
    throw new Error(`${agentName} 无法连接模型服务商：${error.message}`)
  }
  const responseBody = await upstream.json().catch(() => ({}))
  if (!upstream.ok) {
    const detail = responseBody?.error?.message ?? responseBody?.message
    const safeDetail = typeof detail === 'string' ? (saved.apiKey ? detail.replaceAll(saved.apiKey, '[已隐藏]') : detail).slice(0, 320) : `服务商返回 HTTP ${upstream.status}。`
    throw new Error(`${agentName} 请求失败：${safeDetail}`)
  }
  const output = getTextContent(responseBody, definition.kind)
  if (!output) throw new Error(`${agentName} 返回空结果。`)
  return output
}

const executorRegistry = createExecutorRegistry([
  {
    id: 'model-api', name: '模型 API（受控文件补丁）', description: '使用所选模型服务商分析快照或返回文件补丁；命令由织点白名单检查。', modelPlaceholder: '填写服务商要求的 Model ID',
    timeoutMs: 60_000,
    capabilities: { projectRead: 'bounded-snapshot', workspaceAccess: 'patch', fileWrite: 'proposed-patch-after-project-check', commandExecution: 'exact-project-allowlist', networkAccess: 'configured-provider-api', readOnlySpecialist: 'snapshot-result-only' },
    isConfigured: (agent) => {
      const definition = providerDefinitions[agent?.provider]
      const saved = providers.get(agent?.provider)
      return Boolean(typeof agent?.model === 'string' && agent.model.trim() && definition && saved?.baseUrl && providerUrlAllowed(agent.provider, saved.baseUrl) && (!definition.keyRequired || saved.apiKey))
    },
    run: ({ run, agentName, system, prompt, maxTokens, timeoutMs, signal }) => requestAgentModel({ providerId: run.provider, model: run.model, agentName, system, prompt, maxTokens, timeoutMs, signal }),
  },
  {
    id: 'deepseek-api', name: 'DeepSeek API（专用执行器）', description: '直连已配置的 DeepSeek API，分析快照或返回受控文件补丁。', provider: 'DeepSeek', defaultModel: deepSeekDefaultModel, modelPlaceholder: `DeepSeek Model ID，例如 ${deepSeekDefaultModel}`,
    timeoutMs: 60_000,
    capabilities: { projectRead: 'bounded-snapshot', workspaceAccess: 'patch', fileWrite: 'proposed-patch-after-project-check', commandExecution: 'exact-project-allowlist', networkAccess: 'deepseek-api-only', readOnlySpecialist: 'snapshot-result-only' },
    isConfigured: (agent) => {
      const deepSeek = providers.get('DeepSeek')
      return Boolean(typeof agent?.model === 'string' && agent.model.trim() && deepSeek?.baseUrl && providerUrlAllowed('DeepSeek', deepSeek.baseUrl) && deepSeek.apiKey)
    },
    run: ({ run, agentName, system, prompt, maxTokens, timeoutMs, onEvent, signal }) => {
      const saved = providers.get('DeepSeek')
      return runDeepSeekApi({ baseUrl: requireProviderUrl('DeepSeek', saved?.baseUrl), apiKey: saved?.apiKey, model: run.model, agentName, system, prompt, maxTokens, timeoutMs, onEvent, signal })
    },
  },
  {
    id: 'codex-app-server', name: '本机 Codex App Server', description: '使用本机登录态与官方 app-server 协议；工具权限按项目授权和 Codex 沙箱设置。', modelPlaceholder: '可选：留空使用 Codex 默认模型',
    timeoutMs: 600_000,
    capabilities: { projectRead: 'authorized-workspace', workspaceAccess: 'direct', fileWrite: 'direct-when-project-authorized', commandExecution: 'codex-workspace-sandbox', networkAccess: 'not-enforced-by-zhidian-prompt-only' },
    isConfigured: () => true,
    run: ({ run, system, prompt, project, readOnly, onEvent, onHarnessThread, harnessThreadId, signal, timeoutMs }) => runCodexAppServer({ prompt: `${system}\n\n${prompt}`, cwd: project.path, model: run.model || undefined, readOnly, onEvent, onHarnessThread, harnessThreadId, signal, timeoutMs }),
  },
  {
    id: 'codex-cli', name: '本机 Codex CLI（沙箱）', description: '使用本机登录态直接操作授权工作区；沙箱不是 OS 级隔离。', modelPlaceholder: '可选：留空使用 Codex CLI 默认模型',
    timeoutMs: 600_000,
    capabilities: { projectRead: 'authorized-workspace', workspaceAccess: 'direct', fileWrite: 'direct-when-project-authorized', commandExecution: 'codex-workspace-sandbox', networkAccess: 'not-enforced-by-zhidian-prompt-only' },
    isConfigured: () => true,
    run: ({ run, system, prompt, project, readOnly, onEvent, signal, timeoutMs }) => runCodexCli({ prompt: `${system}\n\n${prompt}`, cwd: project.path, model: run.model || undefined, readOnly, onEvent, signal, timeoutMs }),
  },
  {
    id: 'claude-code', name: '本机 Claude Code CLI（受限文件工具）', description: '使用本机登录态和受限文件工具；不开放 Shell，但不是 OS 级隔离。', modelPlaceholder: '可选：留空使用 Claude Code 默认模型',
    timeoutMs: 600_000,
    capabilities: { projectRead: 'authorized-workspace', workspaceAccess: 'direct', fileWrite: 'direct-file-tools-when-project-authorized', commandExecution: 'disabled-shell-tools', networkAccess: 'not-enforced-by-zhidian-prompt-only' },
    isConfigured: () => true,
    run: ({ run, system, prompt, project, readOnly, onEvent, signal, timeoutMs }) => runClaudeCode({ prompt: `${system}\n\n${prompt}`, cwd: project.path, model: run.model || undefined, readOnly, onEvent, signal, timeoutMs }),
  },
  ...(process.env.ZHIDIAN_ENABLE_PI === '1' ? [{
    id: 'pi-cli', name: '本机 Pi CLI（受限文件工具）', description: '显式开启后使用 Pi JSON 模式；关闭会话、扩展、技能、MCP、项目上下文和 Shell 工具。不是 OS 级隔离。', modelPlaceholder: '可选：留空使用 Pi 默认模型',
    timeoutMs: 600_000,
    capabilities: { projectRead: 'authorized-workspace', workspaceAccess: 'direct', fileWrite: 'direct-file-tools-when-project-authorized', commandExecution: 'disabled-shell-tools', networkAccess: 'not-enforced-by-zhidian-prompt-only' },
    isConfigured: () => process.env.ZHIDIAN_ENABLE_PI === '1',
    run: ({ run, system, prompt, project, readOnly, onEvent, signal, timeoutMs }) => runPi({ prompt: `${system}\n\n${prompt}`, cwd: project.path, model: run.model || undefined, readOnly, onEvent, signal, timeoutMs }),
  }] : []),
])

function extractJsonObject(text) {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i)?.[1] ?? text
  const start = fenced.indexOf('{')
  const end = fenced.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(fenced.slice(start, end + 1))
  } catch {
    return null
  }
}

async function runCommand(command, cwd, timeoutMs, signal) {
  if (signal?.aborted) throw Object.assign(new Error('命令已取消。'), { name: 'AbortError', code: 'ABORT_ERR', status: 499 })
  return new Promise((resolveResult, rejectResult) => {
    const windows = process.platform === 'win32'
    const shell = windows ? 'powershell.exe' : 'sh'
    const shellArgs = windows
      ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `${command}\nif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }`]
      : ['-lc', command]
    const child = spawn(shell, shellArgs, {
      cwd,
      windowsHide: true,
      detached: !windows,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const terminate = () => {
      if (windows && child.pid) {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        killer.unref()
      } else if (child.pid) {
        try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
      } else child.kill('SIGTERM')
    }
    const onAbort = () => {
      terminate()
      if (settled) return
      settled = true
      clearTimeout(timer)
      rejectResult(Object.assign(new Error('白名单命令已取消。'), { name: 'AbortError', code: 'ABORT_ERR', status: 499 }))
    }
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolveResult(result)
    }
    const append = (current, chunk) => `${current}${chunk}`.slice(-executionDefaults.maxOutputBytes)
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout = append(stdout, chunk) })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr = append(stderr, chunk) })
    const timer = setTimeout(() => {
      terminate()
      finish({ exitCode: null, timedOut: true, stdout, stderr: `${stderr}\n命令超时。` })
    }, timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) { onAbort(); return }
    child.on('error', (error) => finish({ exitCode: null, timedOut: false, stdout, stderr: error.message }))
    child.on('close', (exitCode) => finish({ exitCode, timedOut: false, stdout, stderr }))
  })
}

function commandIsAllowed(command, project) {
  return project.accessMode === 'execute' && project.allowedCommands.includes(command)
}

async function assertSafeWriteTarget(project, target) {
  await assertProjectPath(project, target)
  try {
    const info = await lstat(target)
    if (!info.isFile()) throw Object.assign(new Error('写入目标必须是普通文件。'), { status: 400 })
    if (info.nlink > 1) throw Object.assign(new Error('写入目标是硬链接文件；为避免修改授权目录外的同一文件，已拒绝写入。'), { status: 403 })
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

async function writeAgentFiles(project, files, signal) {
  if (project.accessMode !== 'write' && project.accessMode !== 'execute') throw new Error('当前项目授权为只读，Agent 不能写入文件。')
  if (!Array.isArray(files) || files.length === 0) return []
  const pending = []
  for (const file of files.slice(0, executionDefaults.maxFiles)) {
    throwIfAborted(signal)
    if (!file || typeof file.path !== 'string' || typeof file.content !== 'string') continue
    if (!file.path.trim() || isAbsolute(file.path)) throw Object.assign(new Error('Agent 文件路径必须是非空相对路径。'), { status: 400 })
    const target = resolve(project.path, file.path)
    if (target === resolve(project.path)) throw Object.assign(new Error('Agent 不能将项目根目录作为文件目标。'), { status: 400 })
    if (Buffer.byteLength(file.content, 'utf8') > executionDefaults.maxFileBytes) throw new Error(`文件 ${file.path} 超过单文件大小限制。`)
    await assertSafeWriteTarget(project, target)
    pending.push({ target, relativePath: file.path, content: file.content })
  }

  const written = []
  for (const file of pending) {
    throwIfAborted(signal)
    await mkdir(dirname(file.target), { recursive: true })
    throwIfAborted(signal)
    await assertSafeWriteTarget(project, file.target)
    throwIfAborted(signal)
    await writeFile(file.target, file.content, 'utf8')
    written.push(file.relativePath)
  }
  return written
}

function throwIfAborted(signal, message = '工作流运行已取消。') {
  if (signal?.aborted) throw Object.assign(new Error(message), { name: 'AbortError', code: 'ABORT_ERR', status: 499 })
}

async function invokeAgent(run, context) {
  const executorId = run.executor ?? 'model-api'
  const task = context.task
  const workflowThread = task ? workflow.threads.get(task.threadId) : null
  const harnessThreadKey = `${executorId}:${run.phase}:${run.agentId ?? run.agentName}`
  const result = await executorRegistry.run(executorId, {
    ...context,
    run,
    harnessThreadId: workflowThread?.harnessThreads?.[harnessThreadKey],
    onHarnessThread: async (threadId) => {
      if (!task || typeof threadId !== 'string' || !threadId) return
      if (!workflowThread) return
      workflowThread.harnessThreads ??= {}
      workflowThread.harnessThreads[harnessThreadKey] = threadId
      run.harnessThreadId = threadId
      workflowThread.updatedAt = now()
      task.updatedAt = workflowThread.updatedAt
      await persistWorkflow()
    },
    phase: run.phase,
    accessMode: context.project?.accessMode ?? run.mode,
    onEvent: (event) => addEvent(run.id, { type: 'executor.event', ...event }),
  })
  if (result.harnessThreadId) run.harnessThreadId = result.harnessThreadId
  if (result.harnessTurnId) run.harnessTurnId = result.harnessTurnId
  return result.output
}

async function runWorkflow(runId) {
  const run = runs.get(runId)
  if (!run || run.status !== 'queued') return
  const task = run ? workflow.tasks.get(run.taskId) : null
  const session = task ? workflow.sessions.get(task.sessionId) : null
  const registeredProject = session ? workflow.projects.get(session.projectId) : null
  // A queued or resumed read-only task must not gain permissions after project re-registration.
  const project = registeredProject && task?.executionMode === 'read-only'
    ? { ...registeredProject, accessMode: 'read-only', allowedCommands: [], verificationCommands: [] }
    : registeredProject
  if (!run) return
  if (!task || !session || !project) {
    run.status = 'failed'
    run.error = '工作流上下文不完整，无法执行。'
    run.completedAt = now()
    addEvent(runId, { type: 'run.failed', message: run.error })
    await persistRuns()
    return
  }

  const controller = new AbortController()
  const { signal } = controller
  runControllers.set(runId, controller)

  const occurrence = workflow.occurrences.get(task.occurrenceId)
  const scheduled = occurrence && workflow.schedules.get(occurrence.scheduleId)
  const deadline = scheduled ? setTimeout(() => controller.abort(new Error('定时任务阶段超时。')), scheduled.timeoutMs) : null
  const specialistOrder = Array.isArray(task.specialistOrder)
    ? task.specialistOrder
    : Array.isArray(task.agents?.specialists) ? task.agents.specialists : task.agents?.specialist ? [task.agents.specialist] : []
  const currentIndex = task.currentSpecialistIndex ?? 0
  const currentSpecialist = specialistOrder[currentIndex]
  const agent = run.phase === 'ceo-plan'
    ? task.agents?.ceo ?? task.agent ?? {}
    : run.phase === 'specialist-execute'
      ? task.agents?.specialists?.find((candidate) => candidate.id === run.agentId) ?? currentSpecialist ?? task.agents?.specialist ?? {}
      : task.agents?.qa ?? {}
  const skills = Array.isArray(agent.skills) ? agent.skills : []
  run.status = 'running'
  addEvent(runId, { type: 'run.started', phase: run.phase, message: `${run.agentName} 开始${run.phase === 'ceo-plan' ? '拆解任务' : run.phase === 'specialist-execute' ? '执行任务' : '独立验收'}` })
  await persistRuns()
  try {
    if (occurrence) {
      if (!scheduled || projectGrant(registeredProject) !== occurrence.grant || await realpath(project.path) !== project.path) throw Object.assign(new Error('项目授权已变更；请重新确认计划权限。'), { status: 403 })
    }
    const snapshot = await projectSnapshot(project)
    throwIfAborted(signal)
    addEvent(runId, { type: 'context.loaded', message: `已读取项目目录，发现 ${snapshot.files.length} 个文件，文本上下文 ${snapshot.textFiles.length} 个文件。` })
    const skillContext = skills.map((skill, index) => `${index + 1}. ${skill.name}：${skill.description ?? ''}；验证：${skill.verification ?? ''}`).join('\n') || '没有绑定 Skills。'
    const memoryContext = (task.contextSnapshot ?? []).map((entry) => `[${entry.scope}] ${entry.title}\n${entry.content}`).join('\n\n') || '没有检索到项目资料或个人偏好。'

    if (run.phase === 'ceo-plan') {
      const system = `你是织点的 CEO Agent。你处于只读规划阶段，只能拆解任务，不得声称修改文件或运行测试。必须只输出 JSON：{"summary":"...","steps":[{"title":"...","owner":"岗位 id 或名称","acceptance":"..."}],"risks":["..."],"recommendedCommands":["..."]}。`
      const prompt = `任务：${task.title}\n背景：${task.brief}\n同线程历史：${formatThreadContext(task.threadContextSnapshot)}\n项目文件：${snapshot.files.slice(0, 120).join(', ')}\n相关长期上下文：${memoryContext}\nCEO Skills：${skillContext}\n可派发岗位：${specialistOrder.map((item) => `${item.id ?? ''} ${item.name ?? ''}`).join('；')}`
      const output = await invokeAgent(run, { agentName: run.agentName, system, prompt, project, task, readOnly: true, maxTokens: 1800, signal })
      throwIfAborted(signal)
      const plan = extractJsonObject(output) ?? { summary: output, steps: [], risks: ['模型没有返回可解析 JSON'], recommendedCommands: [] }
      task.plan = plan
      task.status = 'planned'
      task.updatedAt = now()
      run.output = output
      run.plan = plan
      addEvent(runId, { type: 'plan.created', message: 'CEO 已生成结构化任务计划。', plan })

      const steps = Array.isArray(plan.steps) ? plan.steps : []
      const ownerIndex = (specialist) => steps.findIndex((step) => {
        const owner = String(step?.owner ?? '').toLocaleLowerCase()
        const name = String(specialist.name ?? '').toLocaleLowerCase()
        const agentId = String(specialist.id ?? '').toLocaleLowerCase()
        return Boolean(owner) && (owner === agentId || owner === name || name.includes(owner) || owner.includes(name))
      })
      task.specialistOrder = specialistOrder.map((specialist, index) => ({ specialist, index, order: ownerIndex(specialist) }))
        .sort((a, b) => (a.order < 0 ? Number.MAX_SAFE_INTEGER : a.order) - (b.order < 0 ? Number.MAX_SAFE_INTEGER : b.order) || a.index - b.index)
        .map(({ specialist }) => specialist)
      task.currentSpecialistIndex = 0
      const firstSpecialist = task.specialistOrder[0]
      if (firstSpecialist) {
        if (!agentIsConfigured(firstSpecialist)) throw new Error(`${firstSpecialist.name ?? '专业 Agent'} 缺少执行器或模型配置。`)
        task.status = 'executing'
        const nextRun = makeWorkflowRun({ ...firstSpecialist, executionMode: task.executionMode }, task, firstSpecialist.name ?? '专业 Agent', 'specialist-execute')
        nextRun.subtask = firstSpecialist.name
        runs.set(nextRun.id, nextRun)
        queue.push(nextRun.id)
        task.nextRunId = nextRun.id
        addEvent(runId, { type: 'handoff.created', message: `CEO 已交接给 ${nextRun.agentName}。`, nextRunId: nextRun.id })
      }
    } else if (run.phase === 'specialist-execute') {
      const executor = executorRegistry.get(run.executor ?? 'model-api')
      if (!executor) throw Object.assign(new Error(`未注册执行器“${run.executor ?? ''}”；已拒绝运行。`), { code: 'UNKNOWN_EXECUTOR' })
      const isWorkspaceCli = executor.capabilities.workspaceAccess === 'direct'
      const readOnly = project.accessMode === 'read-only'
      const step = (task.plan?.steps ?? []).find((candidate) => {
        const owner = String(candidate?.owner ?? '').toLocaleLowerCase()
        const name = run.agentName.toLocaleLowerCase()
        return Boolean(owner) && (owner === String(agent.id ?? '').toLocaleLowerCase() || owner === name || name.includes(owner) || owner.includes(name))
      })
      const priorResults = task.execution?.specialists ?? []
      const subtask = step ? `${step.title ?? ''}\n验收：${step.acceptance ?? '按总体验收标准完成'}` : task.title
      const basePrompt = `总任务：${task.title}\n本岗位子任务：${subtask}\n背景：${task.brief}${task.reworkNote ? `\n人工退回原因：${task.reworkNote}` : ''}\n同线程历史：${formatThreadContext(task.threadContextSnapshot)}\nCEO 计划：${JSON.stringify(task.plan ?? {})}\n之前岗位交接记录：${JSON.stringify(priorResults)}\n相关长期上下文：${memoryContext}\n岗位：${run.agentName}\nSkills：${skillContext}\n项目文件：${snapshot.files.slice(0, 180).join(', ')}`
      const system = isWorkspaceCli
        ? `你是织点的专业 Coding Agent。直接在当前授权项目目录内完成本岗位子任务并实际修改需要的文件。只在当前工作区内读写，不要访问工作区外内容，不要联网，不要提交 Git。只执行用户已授权的精确命令：${project.allowedCommands.join(' | ') || '没有获准命令'}。如果没有合适的授权命令，不要执行命令。最后用中文简要报告改了什么、验证命令及真实结果；没有执行就明确说明。`
        : readOnly
          ? '你是织点的专业执行 Agent。当前为只读分析。只根据给定项目快照分析，不得提出文件修改或执行命令。只返回 JSON：{"summary":"分析结论","files":[],"commands":[],"acceptanceNotes":["快照中的证据"]}。'
          : `你是织点的专业执行 Agent。你只能在授权项目目录内工作。根据任务和 Skills 返回 JSON，不要返回 Markdown：{"summary":"...","files":[{"path":"相对路径","content":"完整文件内容"}],"commands":["必须是用户已白名单授权的命令"],"acceptanceNotes":["..."]}。没有必要修改时 files 返回空数组。`
      const prompt = isWorkspaceCli
        ? `${basePrompt}\n项目权限：${project.accessMode}；允许命令：${project.allowedCommands.join(' | ') || '无'}`
        : `${basePrompt}\n当前项目权限：${project.accessMode}；白名单命令：${readOnly ? '无' : project.allowedCommands.join(' | ') || '无'}\n当前项目文本文件：${snapshot.textFiles.map((file) => `--- ${file.path}\n${file.content}`).join('\n').slice(0, maxSnapshotBytes)}`
      const before = isWorkspaceCli ? await projectFileFingerprints(project) : null
      throwIfAborted(signal)
      const output = await invokeAgent(run, { agentName: run.agentName, system, prompt, project, task, readOnly, maxTokens: 2600, signal })
      throwIfAborted(signal)
      let writtenFiles = []
      let commandResults = []
      let summary = output.slice(0, 1200)
      let acceptanceNotes = []
      if (isWorkspaceCli) {
        writtenFiles = changedProjectFiles(before, await projectFileFingerprints(project))
        acceptanceNotes = [`由 ${executor.name} 本机执行；文件变化根据授权项目目录内的前后 SHA-256 快照识别。`, ...(run.executor === 'claude-code' ? ['Claude Code 仅开放 Read/Edit/Write/Grep/Glob 文件工具，不开放 Shell；QA 命令由织点独立执行。'] : [])]
      } else {
        const execution = extractJsonObject(output) ?? { summary: output, files: [], commands: [], acceptanceNotes: [] }
        summary = typeof execution.summary === 'string' ? execution.summary.slice(0, 1200) : summary
        acceptanceNotes = Array.isArray(execution.acceptanceNotes) ? execution.acceptanceNotes.slice(0, 12) : []
        if (readOnly) {
          if ([execution.files, execution.commands].some((items) => items !== undefined && (!Array.isArray(items) || items.length !== 0))) {
            throw Object.assign(new Error('只读分析不能提出文件修改或命令；未执行任何更改。'), { code: 'EXECUTOR_PERMISSION_DENIED', status: 403 })
          }
        } else {
          writtenFiles = await writeAgentFiles(project, execution.files, signal)
          for (const command of Array.isArray(execution.commands) ? execution.commands.slice(0, 6) : []) {
            if (!commandIsAllowed(command, project)) {
              commandResults.push({ command, exitCode: null, skipped: true, stderr: '命令未在项目白名单中，已跳过。' })
              continue
            }
            commandResults.push({ command, ...await runCommand(command, project.path, executionDefaults.commandTimeoutMs, signal) })
          }
        }
      }
      const specialistResult = { agentId: agent.id, agentName: run.agentName, executor: run.executor, summary, writtenFiles, commandResults, acceptanceNotes }
      task.execution = {
        summary: [task.execution?.summary, summary].filter(Boolean).join('\n'),
        specialists: [...priorResults, specialistResult],
        writtenFiles: [...new Set([...(task.execution?.writtenFiles ?? []), ...writtenFiles])],
        commandResults: [...(task.execution?.commandResults ?? []), ...commandResults],
        acceptanceNotes: [...(task.execution?.acceptanceNotes ?? []), ...acceptanceNotes],
      }
      run.output = output
      run.execution = specialistResult
      addEvent(runId, { type: 'execution.completed', message: `${run.agentName} 完成子任务，检测到 ${writtenFiles.length} 个变化文件。`, execution: specialistResult })

      const nextIndex = currentIndex + 1
      const nextSpecialist = task.specialistOrder?.[nextIndex]
      if (nextSpecialist) {
        if (!agentIsConfigured(nextSpecialist)) throw new Error(`${nextSpecialist.name ?? '专业 Agent'} 缺少执行器或模型配置。`)
        task.currentSpecialistIndex = nextIndex
        task.status = 'executing'
        const nextRun = makeWorkflowRun({ ...nextSpecialist, executionMode: task.executionMode }, task, nextSpecialist.name ?? '专业 Agent', 'specialist-execute')
        nextRun.subtask = nextSpecialist.name
        runs.set(nextRun.id, nextRun)
        queue.push(nextRun.id)
        task.nextRunId = nextRun.id
        addEvent(runId, { type: 'handoff.created', message: `${run.agentName} 已交接给 ${nextRun.agentName}。`, nextRunId: nextRun.id })
      } else if (agentIsConfigured(task.agents?.qa)) {
        task.status = 'reviewing'
        const nextRun = makeWorkflowRun({ ...task.agents.qa, executionMode: task.executionMode }, task, task.agents.qa.name ?? '测试 Agent', 'qa-review')
        runs.set(nextRun.id, nextRun)
        queue.push(nextRun.id)
        task.nextRunId = nextRun.id
        addEvent(runId, { type: 'handoff.created', message: `${run.agentName} 已完成最后一个子任务，交接给 ${nextRun.agentName}。`, nextRunId: nextRun.id })
      } else {
        task.status = 'executed'
      }
      task.updatedAt = now()
    } else {
      const verificationResults = []
      if (project.accessMode === 'execute') {
        for (const command of project.verificationCommands ?? []) {
          addEvent(runId, { type: 'verification.started', message: `QA 正在独立运行验收命令：${command}` })
          const result = await runCommand(command, project.path, executionDefaults.commandTimeoutMs, signal)
          verificationResults.push({ command, ...result })
          addEvent(runId, { type: 'verification.completed', message: `验收命令 ${command}：${result.exitCode === 0 ? '通过' : result.timedOut ? '超时' : '失败'}。`, result: { command, exitCode: result.exitCode, timedOut: result.timedOut, stdout: result.stdout, stderr: result.stderr } })
        }
      }
      task.execution = { ...(task.execution ?? {}), verificationResults }
      const executor = executorRegistry.get(run.executor ?? 'model-api')
      if (!executor) throw Object.assign(new Error(`未注册执行器“${run.executor ?? ''}”；已拒绝运行。`), { code: 'UNKNOWN_EXECUTOR' })
      const system = executor.capabilities.projectRead === 'authorized-workspace'
        ? `你是织点的独立测试 Agent。你处于只读验收阶段，必须实际检查当前项目，不得修改文件或默认相信专业 Agent。基于项目和独立验收命令结果，最后严格输出 JSON：{"status":"passed"或"failed","summary":"...","checks":[{"name":"...","passed":true,"evidence":"..."}],"followups":["..."]}。不能编造证据。`
        : `你是织点的测试 Agent。你是独立验收者，不得默认相信前一个 Agent 的结论。只输出 JSON：{"status":"passed"或"failed","summary":"...","checks":[{"name":"...","passed":true,"evidence":"..."}],"followups":["..."]}。只能基于提供的文件快照和命令结果判断，不能编造证据。`
      const memoryContext = (task.contextSnapshot ?? []).map((entry) => `[${entry.scope}] ${entry.title}\n${entry.content}`).join('\n\n') || '没有检索到项目资料或个人偏好。'
      const prompt = `任务：${task.title}\n验收要求：${task.brief}${task.reworkNote ? `\n人工退回原因：${task.reworkNote}` : ''}\n同线程历史：${formatThreadContext(task.threadContextSnapshot)}\n执行结果：${JSON.stringify(task.execution ?? {})}\n独立验收命令结果：${JSON.stringify(verificationResults)}\n相关长期上下文：${memoryContext}\n项目快照：${snapshot.textFiles.map((file) => `--- ${file.path}\n${file.content}`).join('\n').slice(0, maxSnapshotBytes)}\n测试 Skills：${skillContext}`
      const output = await invokeAgent(run, { agentName: run.agentName, system, prompt, project, task, readOnly: true, maxTokens: 2000, signal })
      throwIfAborted(signal)
      const review = extractJsonObject(output) ?? { status: 'failed', summary: output, checks: [], followups: ['模型没有返回可解析验收 JSON。'] }
      const checks = Array.isArray(review.checks) ? review.checks.filter((check) => check && typeof check.name === 'string').slice(0, 20).map((check) => ({ name: check.name.slice(0, 160), passed: check.passed === true, evidence: typeof check.evidence === 'string' ? check.evidence.slice(0, 600) : '' })) : []
      const commandIssues = [...(task.execution?.commandResults ?? []), ...verificationResults].filter((result) => result.skipped || result.timedOut || result.exitCode !== 0)
      const followups = Array.isArray(review.followups) ? review.followups.filter((item) => typeof item === 'string').slice(0, 10).map((item) => item.slice(0, 500)) : []
      if (checks.length === 0 || checks.some((check) => !check.passed || !check.evidence.trim())) followups.push('验收未提供全部通过且附有证据的检查项。')
      for (const result of commandIssues) followups.push(result.skipped ? `白名单命令未执行：${result.command}` : `命令未成功：${result.command}（退出码：${result.exitCode ?? '超时'}）`)
      const hasVerificationGate = project.accessMode !== 'execute' || verificationResults.length > 0
      if (!hasVerificationGate) followups.push('未配置独立验收命令；任务不能标记通过。')
      const checksPass = checks.length > 0 && checks.every((check) => check.passed && check.evidence.trim())
      const status = review.status === 'passed' && checksPass && commandIssues.length === 0 && hasVerificationGate ? 'passed' : 'failed'
      const summary = typeof review.summary === 'string' ? review.summary.slice(0, 1200) : '测试 Agent 未提供验收摘要。'
      const reviewRecord = { id: id('review'), taskId: task.id, runId, status, summary: status === 'passed' ? summary : review.status === 'passed' ? `未通过证据校验：${summary}` : summary, checks, verificationResults, followups: followups.slice(0, 12), createdAt: now() }
      workflow.reviews.set(reviewRecord.id, reviewRecord)
      task.reviewId = reviewRecord.id
      task.status = reviewRecord.status === 'passed' ? 'awaiting-approval' : 'needs-fix'
      task.updatedAt = now()
      run.output = output
      run.review = reviewRecord
      addEvent(runId, { type: 'review.completed', message: `测试 Agent 独立验收：${reviewRecord.status === 'passed' ? '通过' : '需要整改'}。`, review: reviewRecord })
    }
    run.status = 'completed'
    run.completedAt = now()
    addEvent(runId, { type: 'run.completed', message: `${run.agentName} 的 ${run.phase} 已完成。` })
  } catch (error) {
    const timedOut = signal.aborted && signal.reason?.message === '定时任务阶段超时。'
    const cancelled = !timedOut && (signal.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR')
    run.status = cancelled ? 'cancelled' : 'failed'
    run.error = cancelled ? '运行已取消；文件系统中可能保留取消前已完成的修改，不会自动重放。' : timedOut ? signal.reason.message : error.message ?? '工作流运行失败。'
    run.errorCode = timedOut ? 'EXECUTOR_TIMEOUT' : error.code
    run.completedAt = now()
    task.status = cancelled ? 'cancelled' : run.phase === 'qa-review' ? 'needs-fix' : 'failed'
    task.updatedAt = now()
    if (!cancelled && run.phase === 'qa-review' && !task.reviewId) {
      const reviewRecord = {
        id: id('review'),
        taskId: task.id,
        runId,
        status: 'failed',
        summary: '测试 Agent 未能完成独立验收。',
        checks: [],
        followups: [run.error],
        createdAt: now(),
      }
      workflow.reviews.set(reviewRecord.id, reviewRecord)
      task.reviewId = reviewRecord.id
      run.review = reviewRecord
    }
    addEvent(runId, { type: cancelled ? 'run.cancelled' : 'run.failed', message: run.error })
  }
  session.status = task.status === 'approved' ? 'completed' : task.status === 'failed' ? 'failed' : 'active'
  session.updatedAt = now()
  const settledStatuses = new Set(['awaiting-approval', 'needs-fix', 'failed', 'cancelled', 'executed'])
  if (settledStatuses.has(task.status)) {
    const resultSummary = run.error || run.review?.summary || task.execution?.summary || task.plan?.summary || run.output || `任务进入状态：${task.status}`
    saveThreadAssistantMessage(task, `任务状态：${task.status}\n${resultSummary}`, run.id)
    const thread = workflow.threads.get(task.threadId)
    if (thread) {
      thread.status = ['needs-fix', 'failed', 'cancelled'].includes(task.status) ? 'failed' : 'active'
      thread.updatedAt = now()
    }
  }
  clearTimeout(deadline)
  runControllers.delete(runId)
  finishOccurrence(task, run)
  enqueueResultDelivery(task, run)
  await persistWorkflow()
}

async function processQueue() {
  if (queuePromise || shuttingDown) return queuePromise
  queuePromise = (async () => {
    try {
      while (queue.length && !shuttingDown) {
        const runId = queue.shift()
        try {
          await runWorkflow(runId)
        } catch (error) {
          console.error(`Workflow run ${runId} failed unexpectedly: ${error.message}`)
        }
      }
    } finally {
      queuePromise = null
      if (queue.length && !shuttingDown) void processQueue()
    }
  })()
  return queuePromise
}

async function recoverWorkflowQueue() {
  for (const run of runs.values()) {
    if (run.status === 'queued') {
      queue.push(run.id)
      continue
    }
    if (run.status !== 'running') continue
    run.status = 'failed'
    run.error = '本地服务在运行期间关闭；为避免重复写入，已标记失败，请重新发起任务。'
    run.completedAt = now()
    addEvent(run.id, { type: 'run.interrupted', message: run.error })
    const task = workflow.tasks.get(run.taskId)
    if (task) {
      task.status = 'failed'
      task.updatedAt = now()
      const session = workflow.sessions.get(task.sessionId)
      if (session) {
        session.status = 'failed'
        session.updatedAt = now()
      }
      saveThreadAssistantMessage(task, `任务状态：failed\n${run.error}`, run.id)
      finishOccurrence(task, run, false)
      enqueueResultDelivery(task, run)
      const thread = workflow.threads.get(task.threadId)
      if (thread) { thread.status = 'failed'; thread.updatedAt = now() }
    }
  }
  for (const item of workflow.deliveries.values()) {
    if (item.status === 'sending') Object.assign(item, { status: 'unknown', error: '上次投递期间本地服务关闭；未自动重发。', updatedAt: now() })
  }
  await persistWorkflow()
}

async function enqueueWorkflow(body, existingThread = null, occurrence = null, submission = null) {
  const requestedProjectId = body.projectId ?? existingThread?.projectId
  if (existingThread && [...workflow.tasks.values()].some((task) => task.threadId === existingThread.id && ['queued', 'executing', 'reviewing'].includes(task.status))) {
    throw Object.assign(new Error('该线程仍有任务运行中，请等待完成后再续接。'), { status: 409 })
  }
  if (existingThread && body.projectId && body.projectId !== existingThread.projectId) {
    throw Object.assign(new Error('续接线程不能切换到其他项目。'), { status: 403 })
  }
  const project = workflow.projects.get(requestedProjectId)
  if (!project) throw Object.assign(new Error('请先选择已授权的项目目录。'), { status: 400 })
  const title = typeof body.title === 'string' ? redactThreadSecrets(body.title.trim()).slice(0, 200) : ''
  const briefInput = typeof body.brief === 'string' ? body.brief : ''
  const messageInput = typeof body.message === 'string' ? body.message : ''
  const brief = redactThreadSecrets((existingThread ? messageInput || briefInput : briefInput).trim()).slice(0, 12_000)
  const taskTitle = existingThread && !title ? (brief.split(/\r?\n/, 1)[0].slice(0, 200) || existingThread.title) : title
  if (!taskTitle) throw Object.assign(new Error('任务标题不能为空。'), { status: 400 })
  if (existingThread && !brief) throw Object.assign(new Error('续接内容不能为空。'), { status: 400 })
  const thread = existingThread ?? {
    id: id('thread'), projectId: project.id, title: taskTitle, status: 'active',
    agents: null, createdAt: now(), updatedAt: now(),
  }
  const inputAgents = existingThread ? existingThread.agents : body.agents && typeof body.agents === 'object' ? body.agents : {}
  const specialists = Array.isArray(inputAgents.specialists) ? inputAgents.specialists.slice(0, 8) : inputAgents.specialist ? [inputAgents.specialist] : []
  const agents = existingThread ? inputAgents : { ...inputAgents, specialists, specialist: inputAgents.specialist ?? specialists[0] }
  if (!agentIsConfigured(agents.ceo)) throw Object.assign(new Error('CEO Agent 缺少执行器或模型配置。'), { status: 400 })
  if (!specialists.length || specialists.some((agent) => !agentIsConfigured(agent))) throw Object.assign(new Error('至少选择一个并配置完成的专业 Agent。'), { status: 400 })
  if (!agentIsConfigured(agents.qa)) throw Object.assign(new Error('测试 Agent 缺少执行器或模型配置。'), { status: 400 })
  for (const specialist of specialists) {
    const executorId = typeof specialist?.executor === 'string' && specialist.executor ? specialist.executor : 'model-api'
    executorRegistry.authorize(executorId, { phase: 'specialist-execute', accessMode: project.accessMode })
  }
  const qaExecutorId = typeof agents.qa?.executor === 'string' && agents.qa.executor ? agents.qa.executor : 'model-api'
  executorRegistry.authorize(qaExecutorId, { phase: 'qa-review', accessMode: project.accessMode })

  const threadContextSnapshot = existingThread ? buildThreadContextSnapshot(thread.id) : null
  const session = { id: id('session'), projectId: project.id, threadId: thread.id, title: taskTitle, status: 'active', createdAt: now(), updatedAt: now() }
  const contextSnapshot = retrieveContext([...workflow.contextEntries.values()], project.id, `${taskTitle} ${brief}`)
  const task = { id: id('task'), sessionId: session.id, threadId: thread.id, title: taskTitle, brief, status: 'queued', executionMode: project.accessMode, createdAt: now(), updatedAt: now(), agents, specialists, currentSpecialistIndex: 0, contextSnapshot, threadContextSnapshot, plan: null, execution: null, reviewId: null }
  const userMessageContent = existingThread ? brief : [taskTitle, brief].filter(Boolean).join('\n\n')
  const userMessage = { id: id('message'), threadId: thread.id, taskId: task.id, role: 'user', content: redactThreadSecrets(userMessageContent).slice(0, 4_000), createdAt: now(), updatedAt: now() }
  thread.agents = agents
  thread.status = 'active'
  thread.updatedAt = now()
  const ceo = agents.ceo ?? {}
  const run = makeWorkflowRun({ ...ceo, executionMode: project.accessMode }, task, ceo.name ?? 'CEO Agent', 'ceo-plan')
  if (submission) task.submission = { ...submission, runId: run.id }
  if (occurrence) {
    task.occurrenceId = occurrence.id
    occurrence.taskIds.push(task.id)
    occurrence.status = 'running'
    occurrence.error = null
    occurrence.updatedAt = now()
  }
  workflow.threads.set(thread.id, thread)
  workflow.messages.set(userMessage.id, userMessage)
  workflow.sessions.set(session.id, session)
  workflow.tasks.set(task.id, task)
  runs.set(run.id, run)
  await persistWorkflow()
  queue.push(run.id)
  void processQueue()
  return { thread: publicThread(thread), session, task, run: publicRun(run) }
}

function submitWorkflow(body, thread, key) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('提交内容无效。'), { status: 400 })
  if (key === undefined) return enqueueWorkflow(body, thread)
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(key)) throw Object.assign(new Error('任务提交标识无效。'), { status: 400 })
  const digest = createHash('sha256').update(JSON.stringify([thread?.id ?? null, body])).digest('hex')
  const check = (stored) => {
    if (stored !== digest) throw Object.assign(new Error('此提交标识已用于不同的请求。'), { status: 409 })
  }
  const pending = pendingSubmissions.get(key)
  if (pending) { check(pending.digest); return pending.result }
  const existing = [...workflow.tasks.values()].find((task) => task.submission?.key === key)
  if (existing) {
    check(existing.submission.digest)
    return { thread: publicThread(workflow.threads.get(existing.threadId)), session: workflow.sessions.get(existing.sessionId), task: existing, run: publicRun(runs.get(existing.submission.runId)) }
  }
  const result = enqueueWorkflow(body, thread, null, { key, digest }).finally(() => pendingSubmissions.delete(key))
  pendingSubmissions.set(key, { digest, result })
  return result
}

async function createPlanningRun(body) {
  const run = {
    id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    status: 'running',
    mode: 'plan-only',
    agentName: typeof body.agentName === 'string' ? body.agentName : 'Agent',
    provider: typeof body.provider === 'string' ? body.provider : '',
    model: typeof body.model === 'string' ? body.model : '',
    taskTitle: typeof body.task?.title === 'string' ? body.task.title : '',
    skillNames: Array.isArray(body.skills) ? body.skills.filter((skill) => skill && typeof skill.name === 'string').map((skill) => skill.name).slice(0, 12) : [],
    createdAt: new Date().toISOString(),
  }
  runs.set(run.id, run)
  await persistRuns()
  try {
    const result = await callPlanningModel(body)
    Object.assign(run, { ...result, status: 'completed', completedAt: new Date().toISOString() })
  } catch (error) {
    Object.assign(run, { status: 'failed', error: error.message ?? '模型规划失败。', completedAt: new Date().toISOString() })
  }
  await persistRuns()
  return run
}

function projectGrant(project) {
  return project ? JSON.stringify([project.path, project.accessMode, project.allowedCommands, project.verificationCommands]) : null
}

function scheduleError(message, status = 400) {
  return Object.assign(new Error(message), { status })
}

function publicSchedule(schedule) {
  const { grant, agents, ...record } = schedule
  return { ...record, sourceTaskTitle: workflow.tasks.get(schedule.sourceTaskId)?.title, projectName: workflow.projects.get(schedule.projectId)?.name, requiresAuthorization: grant !== projectGrant(workflow.projects.get(schedule.projectId)), agentNames: [agents.ceo?.name, ...(agents.specialists ?? [agents.specialist]).map((agent) => agent?.name), agents.qa?.name].filter(Boolean) }
}

const pendingOccurrence = (item) => ['pending', 'running', 'retry-wait'].includes(item.status)

function normalizeSchedule(body, previous) {
  const sourceTask = workflow.tasks.get(body.sourceTaskId ?? previous?.sourceTaskId)
  const thread = sourceTask && workflow.threads.get(sourceTask.threadId)
  const project = thread && workflow.projects.get(thread.projectId)
  if (!project || !sourceTask?.agents?.ceo) throw scheduleError('请选择有完整岗位配置的工作流任务。')
  if (previous && project.id !== previous.projectId) throw scheduleError('已有计划不能切换项目。', 403)
  let recurrence
  try { recurrence = normalizeRecurrence(body.recurrence ?? previous?.recurrence) } catch (error) { throw scheduleError(error.message) }
  const title = redactThreadSecrets(body.title ?? previous?.title ?? sourceTask.title).trim().slice(0, 200)
  const brief = redactThreadSecrets(body.brief ?? previous?.brief ?? sourceTask.brief).trim().slice(0, 12_000)
  const misfire = body.misfire ?? previous?.misfire ?? 'skip'
  const maxRetries = body.maxRetries ?? previous?.maxRetries ?? 0
  const timeoutMs = body.timeoutMs ?? previous?.timeoutMs ?? 120_000
  const enabled = body.enabled ?? previous?.enabled ?? true
  if (!title || !['skip', 'run-once'].includes(misfire) || !Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 3 || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 900_000 || typeof enabled !== 'boolean') throw scheduleError('计划配置不合法。')
  const unchanged = previous?.enabled && JSON.stringify(recurrence) === JSON.stringify(previous.recurrence)
  const nextRunAt = !enabled ? null : unchanged ? previous.nextRunAt : nextScheduleAt(recurrence)
  if (enabled && !nextRunAt) throw scheduleError('一次性计划须指定未来时间，已完成计划可手动运行。')
  return { id: previous?.id ?? id('schedule'), projectId: project.id, sourceTaskId: sourceTask.id, title, brief, agents: sourceTask.agents, grant: projectGrant(project), recurrence, enabled, misfire, maxRetries, timeoutMs, nextRunAt, createdAt: previous?.createdAt ?? now(), updatedAt: now() }
}

function makeOccurrence(schedule, occurrenceId, scheduledFor, trigger, status = 'pending', error = null) {
  return { id: occurrenceId, scheduleId: schedule.id, grant: schedule.grant, scheduledFor, trigger, status, error, taskIds: [], createdAt: now(), updatedAt: now() }
}

function publicOccurrence(item) {
  const { grant: _grant, ...record } = item
  return record
}

function finishOccurrence(task, run, allowRetry = true) {
  const item = workflow.occurrences.get(task.occurrenceId)
  if (!item || item.taskIds.at(-1) !== task.id || !['running', 'awaiting-approval'].includes(item.status)) return
  if (['queued', 'executing', 'reviewing'].includes(task.status)) return
  const schedule = workflow.schedules.get(item.scheduleId)
  const retry = allowRetry && !schedule?.deletedAt && (schedule?.enabled || item.trigger === 'manual' || schedule?.recurrence.kind === 'once') && item.taskIds.length <= schedule.maxRetries && run.phase === 'ceo-plan' && run.errorCode === 'EXECUTOR_TIMEOUT'
  item.status = task.status === 'approved' ? 'completed' : task.status === 'awaiting-approval' ? task.status : task.status === 'cancelled' ? 'cancelled' : retry ? 'retry-wait' : 'failed'
  const returned = workflow.reviews.get(task.reviewId)?.decision?.value === 'return'
  item.error = run.error ? redactThreadSecrets(run.error).slice(0, 600) : item.status === 'failed' ? returned ? '交付被退回修改。' : `任务状态：${task.status}` : null
  item.retryAt = retry ? new Date(Date.now() + 15_000 * 2 ** (item.taskIds.length - 1)).toISOString() : null
  item.updatedAt = now()
}

let schedulerActive = false
const missedGraceMs = 60_000

async function tickSchedules() {
  if (schedulerActive || shuttingDown) return
  schedulerActive = true
  try {
    let changed = false
    const time = Date.now()
    for (const schedule of workflow.schedules.values()) {
      if (!schedule.enabled || !schedule.nextRunAt || Date.parse(schedule.nextRunAt) > time) continue
      const scheduledFor = schedule.nextRunAt
      const occurrenceId = deterministicOccurrenceId(schedule.id, scheduledFor)
      schedule.nextRunAt = nextScheduleAt(schedule.recurrence, time)
      if (!schedule.nextRunAt) schedule.enabled = false
      schedule.updatedAt = now()
      changed = true
      if (workflow.occurrences.has(occurrenceId)) continue
      const busy = [...workflow.occurrences.values()].some((item) => item.scheduleId === schedule.id && pendingOccurrence(item))
      const missed = time - Date.parse(scheduledFor) > missedGraceMs && schedule.misfire === 'skip'
      workflow.occurrences.set(occurrenceId, makeOccurrence(schedule, occurrenceId, scheduledFor, 'scheduled', busy || missed ? 'skipped' : 'pending', busy ? '上一次触发尚未结束。' : missed ? '已错过本次计划时间。' : null))
    }
    if (changed) await persistWorkflow()
    for (const item of workflow.occurrences.values()) {
      if (item.status !== 'pending' && (item.status !== 'retry-wait' || Date.parse(item.retryAt) > time)) continue
      const schedule = workflow.schedules.get(item.scheduleId)
      try {
        const project = workflow.projects.get(schedule?.projectId)
        if (!schedule || schedule.deletedAt) throw scheduleError('该定时计划已删除。', 409)
        if (!project || projectGrant(project) !== item.grant || await realpath(project.path) !== project.path) throw scheduleError('项目授权已变更；请重新确认计划权限。', 403)
        if (!pendingOccurrence(item)) continue
        await enqueueWorkflow(schedule, null, item)
      } catch (error) {
        item.status = 'failed'
        item.error = redactThreadSecrets(error.message).slice(0, 600)
        item.updatedAt = now()
        await persistWorkflow()
      }
    }
  } finally {
    schedulerActive = false
  }
}

function wakeScheduler() {
  if (shuttingDown || schedulerPromise) return schedulerPromise
  schedulerPromise = tickSchedules().catch((error) => console.error(`Scheduler tick failed: ${error.message}`)).finally(() => { schedulerPromise = null })
  return schedulerPromise
}

function publicDeliveryTarget(target) {
  return { projectId: target.id, channel: target.channel, events: target.events, enabled: target.enabled, hasSigningSecret: target.hasSigningSecret, includeTaskLink: target.includeTaskLink === true }
}

const inboundEnabled = process.env.ZHIDIAN_ENABLE_INBOUND === '1'
const inboundDecisions = new Set()
const inboundRetentionMs = 7 * 86_400_000

function inboundTaskInProject(taskId, projectId) {
  const task = workflow.tasks.get(taskId)
  return task && workflow.threads.get(task.threadId)?.projectId === projectId ? task : null
}

function inboundGrant(project) {
  return createHash('sha256').update(projectGrant(project)).digest('hex')
}

async function serveInboundWebhook(request, response, projectId) {
  const target = workflow.inboundTargets.get(projectId)
  if (!inboundEnabled || !target?.enabled) { sendJson(response, 404, { error: '入站入口未启用。' }); return }
  try {
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) throw scheduleError('需要 JSON 请求。', 415)
    const chunks = []
    let bytes = 0
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      bytes += chunk.length
      if (bytes > maxBodyBytes) { response.setHeader('connection', 'close'); throw scheduleError('请求内容过大。', 413) }
      chunks.push(chunk)
    }
    const credentials = await readInboundCredential(target)
    if (workflow.inboundTargets.get(projectId) !== target || shuttingDown) throw scheduleError('入口配置已变更或服务正在停机。', 503)
    const decoded = decodeInboundPayload({ rawBody: Buffer.concat(chunks, bytes), headers: request.headers, ...credentials })
    const audit = auditRequests.get(response)
    audit.role = 'integration'
    if (!auditLog.record(audit, 'attempt', { resourceId: projectId })) throw scheduleError('审计日志不可用。', 503)
    if (decoded.kind === 'challenge') { sendJson(response, 200, { challenge: decoded.challenge }); return }
    const identity = extractInboundMessage(decoded.payload, target)
    if (!identity) { sendJson(response, 200, {}); return }
    if (!identityAllowed(target, identity)) { sendJson(response, 403, { error: '外部身份未获该项目授权。' }); return }
    const eventId = inboundEventRecordId(projectId, target.appId, target.tenantKey, identity.eventId)
    if (workflow.inboundEvents.has(eventId)) {
      await persistWorkflow()
      sendJson(response, 200, {})
      return
    }
    const command = parseInboundCommand(identity.text)
    if (!command || !target.intents.includes(command.intent)) { sendJson(response, 200, {}); return }
    if ((command.taskId && !inboundTaskInProject(command.taskId, projectId)) ||
      (command.threadId && workflow.threads.get(command.threadId)?.projectId !== projectId)) {
      throw scheduleError('找不到此项目内的资源。', 404)
    }
    if (command.intent !== 'status' && [...workflow.inboundEvents.values()].filter((event) => event.projectId === projectId && event.status === 'awaiting-owner').length >= 50) {
      throw scheduleError('此项目已有 50 条待处理请求。', 429)
    }
    if (workflow.inboundEvents.size >= 2_000) {
      const cutoff = Date.now() - inboundRetentionMs
      for (const { id, status, updatedAt } of workflow.inboundEvents.values()) {
        if (status !== 'awaiting-owner' && Date.parse(updatedAt) < cutoff) workflow.inboundEvents.delete(id)
      }
    }
    if (workflow.inboundEvents.size >= 2_000) throw scheduleError('入站记录达到容量上限，请稍后重试。', 429)
    const at = now()
    const record = {
      id: eventId, projectId, channel: target.channel, revision: target.revision,
      grant: inboundGrant(workflow.projects.get(projectId)),
      userId: identity.userId, chatId: identity.chatId,
      intent: command.intent, status: command.intent === 'status' ? 'accepted' : 'awaiting-owner',
      taskId: command.taskId, threadId: command.threadId,
      taskStatus: command.intent === 'status' ? workflow.tasks.get(command.taskId).status : undefined,
      draft: command.intent === 'create' ? { title: redactThreadSecrets(command.title), brief: redactThreadSecrets(command.brief) }
        : command.intent === 'reply' ? { message: redactThreadSecrets(command.message) } : undefined,
      createdAt: at, updatedAt: at,
    }
    workflow.inboundEvents.set(eventId, record)
    if (credentials.appSecret && identity.messageId) {
      const notification = queueDelivery(target, `reply-${record.id}`, 'inbound-reply', record.taskId)
      Object.assign(notification, {
        kind: 'inbound-reply', messageId: identity.messageId, replyUuid: randomUUID(),
        replyText: record.intent === 'status' ? `织点 | 当前任务状态 ${record.taskStatus}` : '织点 | 已收到请求，等待主人处理。',
      })
    }
    await persistWorkflow()
    sendJson(response, 200, {})
  } catch (error) {
    sendJson(response, error.status ?? 500, { error: error.status ? error.message : '无法处理入站事件。' })
  }
}

async function decideInboundEvent(record, body) {
  if (record.status !== 'awaiting-owner' || inboundDecisions.has(record.id)) throw scheduleError('该请求已处理或正在处理。', 409)
  if (!['accept', 'dismiss'].includes(body?.decision)) throw scheduleError('请选择有效的处理方式。')
  if (body.decision === 'dismiss' || record.intent === 'approve') {
    record.status = body.decision === 'dismiss' ? 'dismissed' : 'acknowledged'
    record.updatedAt = now()
    delete record.draft
    await persistWorkflow()
    return record
  }
  const target = workflow.inboundTargets.get(record.projectId)
  const project = workflow.projects.get(record.projectId)
  if (!inboundEnabled || !target?.enabled || target.revision !== record.revision || !project || inboundGrant(project) !== record.grant) {
    throw scheduleError('入口或项目授权已变更，请重新提交外部请求。', 409)
  }
  const key = record.id
  // A previous acceptance may have committed the workflow before writing its inbox status.
  const submitted = [...workflow.tasks.values()].find((task) => task.submission?.key === key)
  if (submitted && !inboundTaskInProject(submitted.id, project.id)) throw scheduleError('提交标识已占用。', 409)
  inboundDecisions.add(record.id)
  try {
    let task = submitted
    if (!task && record.intent === 'create') {
      const source = inboundTaskInProject(body.sourceTaskId, project.id)
      if (!source?.agents?.ceo || !source.agents.qa) throw scheduleError('请选择同一项目中具备岗位配置的源任务。')
      ;({ task } = await submitWorkflow({ projectId: project.id, title: record.draft.title, brief: record.draft.brief, agents: source.agents }, null, key))
    }
    if (!task && record.intent === 'reply') {
      const thread = workflow.threads.get(record.threadId)
      if (thread?.projectId !== project.id) throw scheduleError('找不到此项目内的线程。', 404)
      ;({ task } = await submitWorkflow({ projectId: project.id, message: record.draft.message }, thread, key))
    }
    if (!task) throw scheduleError('入站请求无法转为任务。', 409)
    Object.assign(record, { status: 'accepted', taskId: task.id, threadId: task.threadId, updatedAt: now() })
    delete record.draft
    await persistWorkflow()
    return record
  } finally { inboundDecisions.delete(record.id) }
}

async function saveInboundTarget(projectId, body, previous, stillOwner) {
  if (!httpsOrigin || !credentialVault) throw scheduleError('入站配置需要 HTTPS 和实例密钥环。', 409)
  if (!workflow.projects.has(projectId)) throw scheduleError('找不到已授权项目。', 404)
  let settings
  try { settings = normalizeInboundSettings(body, previous) } catch (error) { throw scheduleError(error.message) }
  const old = previous && previous.channel === settings.channel ? await readInboundCredential(previous) : null
  const verificationToken = typeof body.verificationToken === 'string' ? body.verificationToken.trim() : old?.verificationToken ?? ''
  const encryptKey = typeof body.encryptKey === 'string' ? body.encryptKey.trim() : old?.encryptKey ?? ''
  const appSecret = body.clearAppSecret === true ? '' : typeof body.appSecret === 'string' ? body.appSecret.trim() : old?.appSecret ?? ''
  if (!verificationToken || verificationToken.length > 512 || !encryptKey || encryptKey.length > 512 || appSecret.length > 512) throw scheduleError('验证令牌、加密密钥或应用密钥格式不正确。')
  if (!stillOwner()) throw scheduleError('会话已失效。', 401)
  if (workflow.inboundTargets.get(projectId) !== previous) throw scheduleError('配置已变更，请重新加载。', 409)
  const encryptedCredentials = credentialVault.seal(`inbound:${projectId}`, JSON.stringify({ verificationToken, encryptKey, appSecret }))
  const target = { id: projectId, projectId, ...settings, encryptedCredentials, hasVerificationToken: true, hasEncryptKey: true, hasAppSecret: Boolean(appSecret), revision: randomUUID() }
  supersedeDeliveries(projectId, 'inbound-reply')
  workflow.inboundTargets.set(projectId, target)
  await persistWorkflow()
  return publicInboundTarget(target)
}

function supersedeDeliveries(projectId, kind = 'bot') {
  const controller = deliveryControllers.get(projectId)
  if (controller?.kind === kind) controller.abort()
  for (const item of workflow.deliveries.values()) {
    if (item.projectId === projectId && (item.kind ?? 'bot') === kind && ['pending', 'retry-wait'].includes(item.status)) {
      Object.assign(item, { status: 'cancelled', error: '通知配置已停用或替换。', retryAt: null, updatedAt: now() })
    }
  }
}

function queueDelivery(target, itemId, event, taskId) {
  if (workflow.deliveries.has(itemId)) return workflow.deliveries.get(itemId)
  const item = { id: itemId, projectId: target.id, revision: target.revision, channel: target.channel, event, taskId, status: 'pending', attempts: 0, createdAt: now(), updatedAt: now() }
  workflow.deliveries.set(item.id, item)
  return item
}

function enqueueResultDelivery(task, run) {
  if (!deliveryEvents.includes(task.status)) return
  const session = workflow.sessions.get(task.sessionId)
  const target = workflow.deliveryTargets.get(session?.projectId)
  if (!target?.enabled || !target.events.includes(task.status)) return
  queueDelivery(target, `delivery-${run.id}-${task.status}`, task.status, task.id)
}

async function decideTaskDelivery(task, body) {
  const { reviewId, decision, note } = body ?? {}
  if (typeof reviewId !== 'string' || !['approve', 'return'].includes(decision)) throw scheduleError('请指定当前 QA 记录和验收决定。', 400)
  const reason = decision === 'return' && typeof note === 'string' ? redactThreadSecrets(note.trim()) : ''
  if (decision === 'return' && (!reason || reason.length > 1000)) throw scheduleError('请输入 1 到 1000 字的退回原因。', 400)
  const review = workflow.reviews.get(reviewId)
  const run = runs.get(review?.runId)
  if (task.reviewId !== reviewId || review?.taskId !== task.id || review.status !== 'passed' || run?.taskId !== task.id || run.phase !== 'qa-review' || run.status !== 'completed') {
    throw scheduleError('该 QA 记录已过期或未通过，请刷新任务。', 409)
  }
  if (review.decision) {
    if (review.decision.value !== decision || (review.decision.note ?? '') !== reason) throw scheduleError('此 QA 记录已有验收决定。', 409)
    await persistWorkflow()
    return { task, review }
  }
  if (task.status !== 'awaiting-approval') throw scheduleError('任务不在待确认交付状态。', 409)

  const decidedAt = now()
  const approved = decision === 'approve'
  review.decision = { value: decision, decidedAt, ...(reason && { note: reason }) }
  task.status = approved ? 'approved' : 'needs-fix'
  task.updatedAt = decidedAt
  if (approved) delete task.reworkNote
  else task.reworkNote = reason
  const session = workflow.sessions.get(task.sessionId)
  if (session) Object.assign(session, { status: approved ? 'completed' : 'failed', updatedAt: decidedAt })
  saveThreadAssistantMessage(task, `${approved ? '已人工确认交付' : `已人工退回：${reason}`}\n独立 QA：${review.summary}`, run.id)
  const thread = workflow.threads.get(task.threadId)
  if (thread && [...workflow.tasks.values()].findLast((candidate) => candidate.threadId === thread.id)?.id === task.id) {
    thread.status = approved ? 'completed' : 'failed'
  }
  finishOccurrence(task, run, false)
  enqueueResultDelivery(task, run)
  await persistWorkflow()
  return { task, review }
}

let deliveryBusy = false
const deliveryControllers = new Map()
const deliveredAt = new Map()
async function tickDeliveries() {
  if (deliveryBusy || shuttingDown) return
  const item = [...workflow.deliveries.values()].find((candidate) => Date.now() - (deliveredAt.get(candidate.projectId) ?? 0) >= 2_000 && (candidate.status === 'pending' || (candidate.status === 'retry-wait' && Date.parse(candidate.retryAt) <= Date.now())))
  if (!item) return
  deliveryBusy = true
  deliveryPromise = (async () => {
   try {
    const inbound = item.kind === 'inbound-reply'
    const targets = inbound ? workflow.inboundTargets : workflow.deliveryTargets
    const target = targets.get(item.projectId)
    if (!target?.enabled || target.revision !== item.revision || (inbound && (!httpsOrigin || !inboundEnabled))) {
      Object.assign(item, { status: 'cancelled', error: '通知配置已停用或替换。', updatedAt: now() })
      await persistWorkflow()
      return
    }
    const controller = new AbortController()
    controller.kind = item.kind ?? 'bot'
    deliveryControllers.set(item.projectId, controller)
    item.status = 'sending'
    item.attempts += 1
    item.updatedAt = now()
    await persistWorkflow()
    let result
    try {
      const credentials = await (inbound ? readInboundCredential(target) : readDeliveryCredential(target))
      if (controller.signal.aborted || targets.get(item.projectId) !== target) {
        result = { status: 'cancelled', error: '通知配置已撤销。' }
      } else {
        deliveredAt.set(item.projectId, Date.now())
        const transmit = inbound ? transmitInboundReply : transmitBot
        const workbenchOrigin = !inbound && target.includeTaskLink === true && projectForTask(workflow.tasks.get(item.taskId), workflow) === item.projectId ? httpsOrigin : null
        result = await transmit({ channel: target.channel, appId: target.appId, ...credentials }, item, { workbenchOrigin, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]) })
      }
    } catch {
      result = { status: 'failed', error: '无法读取实例的机器人凭据。' }
    }
    Object.assign(item, nextDeliveryState(item, result))
    await persistWorkflow()
   } finally {
     deliveryControllers.delete(item.projectId)
     deliveryBusy = false
     deliveryPromise = null
   }
  })()
  return deliveryPromise
}

async function saveDeliveryTarget(projectId, body, previous) {
  if (!workflow.projects.has(projectId)) throw scheduleError('找不到已授权项目。', 404)
  const channel = body.channel ?? previous?.channel
  const events = body.events ?? previous?.events
  const enabled = body.enabled ?? previous?.enabled ?? true
  if (!['feishu', 'lark'].includes(channel) || !Array.isArray(events) || events.length === 0 || events.some((event) => !deliveryEvents.includes(event)) || typeof enabled !== 'boolean') throw scheduleError('通知渠道或事件配置无效。')
  const includeTaskLink = body.includeTaskLink === undefined ? previous?.includeTaskLink === true : body.includeTaskLink
  if (typeof includeTaskLink !== 'boolean' || (body.includeTaskLink === true && !httpsOrigin)) throw scheduleError('任务链接仅可在 HTTPS 工作台中启用。')
  let encryptedCredentials = previous?.encryptedCredentials
  let hasSigningSecret = previous?.hasSigningSecret ?? false
  if (body.webhook || !previous || previous.channel !== channel) {
    let url
    try { url = validateBotUrl(channel, body.webhook) } catch (error) { throw scheduleError(error.message) }
    if (body.signingSecret !== undefined && (typeof body.signingSecret !== 'string' || body.signingSecret.length > 512)) throw scheduleError('签名密钥格式不正确。')
    const secret = body.signingSecret?.trim() || ''
    encryptedCredentials = await sealCredential(`delivery:${projectId}`, JSON.stringify({ url, secret }))
    hasSigningSecret = Boolean(secret)
  } else if (body.signingSecret) throw scheduleError('更新签名密钥时请一并输入 Webhook 地址。')
  if (workflow.deliveryTargets.get(projectId) !== previous) throw scheduleError('配置已变更，请重新加载。', 409)
  const target = { id: projectId, channel, events: [...new Set(events)], enabled, encryptedCredentials, hasSigningSecret, includeTaskLink, revision: id('delivery-config') }
  supersedeDeliveries(projectId)
  workflow.deliveryTargets.set(projectId, target)
  await persistWorkflow()
  return publicDeliveryTarget(target)
}

if (!checkData) await mkdir(dataDir, { recursive: true })
const dataLock = await lockDataDirectory(dataDir)
dataLock.unref()
const keyringPath = process.env.ZHIDIAN_CREDENTIAL_KEYRING
if (keyringPath !== undefined) {
  if (!isAbsolute(keyringPath)) throw new Error('The instance credential keyring path must be absolute.')
  const info = await stat(keyringPath)
  if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) throw new Error('The keyring must be a private regular file (mode 0600 on POSIX).')
  try { credentialVault = createCredentialVault(JSON.parse(await readFile(keyringPath, 'utf8'))) } catch { throw new Error('Invalid or unreadable instance credential keyring.') }
}
if (rotateCredentials && !credentialVault) throw new Error('Credential rotation requires an instance credential keyring.')
if (httpsOrigin && (!auth.enabled || !credentialVault)) throw new Error('HTTPS mode requires owner authentication and an instance credential keyring.')
assertPrivateCredentials(deployment, { authEnabled: auth.enabled, credentialVaultConfigured: Boolean(credentialVault) })
const tlsOptions = httpsOrigin && !rotateCredentials && (!checkData || checkPilot) ? await loadTlsOptions(process.env.ZHIDIAN_TLS_KEY, process.env.ZHIDIAN_TLS_CERT, httpsOrigin) : null
const serveWorkbench = tlsOptions || desktopMode ? await loadWorkbenchAssets(fileURLToPath(new URL('./dist', import.meta.url))) : null
if (process.env.ZHIDIAN_STORAGE !== undefined && !['json', 'sqlite'].includes(process.env.ZHIDIAN_STORAGE)) throw new Error('ZHIDIAN_STORAGE must be json or sqlite.')
const existingSqlite = await stat(sqlitePath).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error })
if (checkPilot && !existingSqlite) throw new Error('Pilot preflight requires an initialized SQLite backup or stopped instance.')
if (existingSqlite && process.env.ZHIDIAN_STORAGE === 'json') throw new Error('SQLite store already exists. Restore to a separate data directory to use JSON.')
if (httpsOrigin && !existingSqlite && process.env.ZHIDIAN_STORAGE !== 'sqlite') throw new Error('HTTPS mode requires SQLite storage.')
await loadProviders()
if (existingSqlite || process.env.ZHIDIAN_STORAGE === 'sqlite') {
  const { openSqliteWorkflow } = await import('./server/sqlite-workflow.mjs')
  sqliteStore = openSqliteWorkflow(sqlitePath, { readOnly: checkData })
  if (checkData) sqliteStore.verifyIntegrity()
}
await loadWorkflow()
if (checkData) {
  const report = {
    ok: true, mode: checkPilot ? 'check-pilot' : 'check-data', storage: sqliteStore ? 'sqlite' : 'json', compatibleSchema: CURRENT_WORKFLOW_SCHEMA_VERSION,
    counts: { ...Object.fromEntries(Object.entries(workflow).map(([key, records]) => [key, records.size])), runs: runs.size, members: members.size },
    resumeOnStart: {
      queuedRuns: [...runs.values()].filter(({ status }) => status === 'queued').length,
      interruptedRuns: [...runs.values()].filter(({ status }) => status === 'running').length,
      enabledSchedules: [...workflow.schedules.values()].filter(({ enabled, deletedAt }) => enabled && !deletedAt).length,
      pendingDeliveries: [...workflow.deliveries.values()].filter(({ status }) => status === 'pending' || status === 'retry-wait').length,
    },
    credentials: { providerKeys: [...providers.values()].filter(({ apiKey }) => Boolean(apiKey)).length, deliveryTargets: workflow.deliveryTargets.size },
  }
  if (checkPilot) {
    const certificate = new X509Certificate(tlsOptions.cert)
    report.pilot = {
      origin: httpsOrigin.origin, listener: { host, port, privateBind: deployment.privateBind, trustedClientCount: deployment.trustedClients.size }, certificateExpiresAt: certificate.validToDate.toISOString(),
      certificateFingerprint256: certificate.fingerprint256, auditFiles: auditFileSizes(dataDir),
      notVerified: ['client-certificate-trust', 'private-link', 'host-file-acls', 'host-egress', 'audit-collector'],
    }
  }
  sqliteStore?.close()
  await releaseDataLock(dataLock)
  await new Promise((resolveOutput) => process.stdout.write(`${JSON.stringify(report)}\n`, resolveOutput))
  process.exit(0)
}
if (rotateCredentials) {
  await persistProviders()
  await persistWorkflow()
  sqliteStore?.close()
  dataLock.close()
  console.log('Credential envelopes re-encrypted. Keep old keys until backups are verified.')
  process.exit(0)
}
const auditLog = createAuditLog(dataDir, { onFailure: (code) => console.error(`Control-plane audit unavailable: ${code}`) })
await recoverWorkflowQueue()

const memberHistoryViews = {
  threads: { records: workflow.threads, project: (item) => item.projectId, row: ({ id, title, status, updatedAt }) => ({ id, title, status, at: updatedAt }) },
  runs: { records: runs, project: (item) => projectForRun(item, workflow), row: ({ id, taskId, phase, status, createdAt }) => ({ id, taskId, title: phase, status, at: createdAt }) },
  schedules: { records: workflow.schedules, project: (item) => !item.deletedAt && item.projectId, row: ({ id, title, enabled, nextRunAt }) => ({ id, title, status: enabled ? 'enabled' : 'disabled', at: nextRunAt }) },
  deliveries: { records: workflow.deliveries, project: (item) => item.projectId, row: ({ id, event, status, updatedAt }) => ({ id, title: event, status, at: updatedAt }) },
}

function serveMemberHistory(request, response, params, allowed) {
  const kind = params.get('kind') ?? 'threads'
  if (!Object.hasOwn(memberHistoryViews, kind)) { sendJson(response, 400, { error: '未知的成员记录类型。' }); return }
  const projects = [...workflow.projects.values()].filter(({ id }) => allowed.has(id)).map(({ id, name }) => ({ id, name }))
  const projectId = params.get('projectId') ?? projects[0]?.id ?? null
  if (projectId !== null && (!allowed.has(projectId) || !workflow.projects.has(projectId))) {
    sendJson(response, 404, { error: '找不到可查看的项目。' })
    return
  }
  const { records, project, row } = memberHistoryViews[kind]
  const cursor = params.get('after')
  const anchor = cursor && records.get(cursor)
  if (cursor && (!anchor || project(anchor) !== projectId)) {
    sendJson(response, 400, { error: '分页位置已失效，请回到第一页。' })
    return
  }
  const page = projectId === null ? { items: [], next: null }
    : historyPage(records, params, (item) => project(item) === projectId, row)
  const snapshot = { projects, projectId, kind, ...page }
  // An unrelated project's changes must not invalidate a member's visible history.
  const tag = `W/"member-${createHash('sha256').update(JSON.stringify(snapshot)).digest('base64url')}"`
  if (!sendNotModified(request, response, tag)) sendJson(response, 200, snapshot)
}

function serveViewer(request, response, url, authSession) {
  const { pathname, searchParams } = url
  const allowed = viewerProjectIds(members.get(authSession.memberId))
  const denied = () => sendJson(response, 403, { error: '当前账号只可查看获授权项目的状态。' })
  if (request.method !== 'GET') { denied(); return }
  if (pathname === '/api/member/history') { serveMemberHistory(request, response, searchParams, allowed); return }
  if (pathname === '/api/member/workspace') {
    const projects = [...workflow.projects.values()].filter((project) => allowed.has(project.id)).map(({ id, name }) => ({ id, name }))
    const threads = [...workflow.threads.values()].filter((item) => allowed.has(item.projectId)).map(({ id, projectId, title, status, updatedAt }) => ({ id, projectId, title, status, updatedAt }))
    const visibleRuns = [...runs.values()].reverse().filter((run) => allowed.has(projectForRun(run, workflow))).slice(0, 100)
    const runsByProject = visibleRuns.map((run) => ({ ...viewerRun(run), projectId: projectForRun(run, workflow) }))
    const schedules = [...workflow.schedules.values()].filter((item) => !item.deletedAt && allowed.has(item.projectId)).map(({ id, projectId, title, enabled, nextRunAt }) => ({ id, projectId, title, enabled, nextRunAt }))
    const deliveries = [...workflow.deliveries.values()].reverse().filter((item) => allowed.has(item.projectId)).slice(0, 100).map(({ id, projectId, status, event, updatedAt }) => ({ id, projectId, status, event, updatedAt }))
    sendJson(response, 200, { projects, threads, runs: runsByProject, schedules, deliveries })
    return
  }
  const taskLink = pathname.match(/^\/api\/member\/tasks\/([A-Za-z0-9-]{1,100})$/)
  if (taskLink) {
    const task = workflow.tasks.get(taskLink[1])
    const projectId = projectForTask(task, workflow)
    const project = workflow.projects.get(projectId)
    if (!task || !project || !allowed.has(projectId)) { sendJson(response, 404, { error: '找不到可查看的任务。' }); return }
    sendJson(response, 200, { id: task.id, status: task.status, updatedAt: task.updatedAt, projectId, projectName: project.name, threadTitle: workflow.threads.get(task.threadId).title })
    return
  }
  const stream = pathname.match(/^\/api\/runs\/([^/]+)\/events$/)
  if (stream) {
    const run = runs.get(decodeURIComponent(stream[1]))
    if (!allowed.has(projectForRun(run, workflow))) sendJson(response, 404, { error: '找不到运行记录。' })
    else writeRunEvents(run, response, authSession)
    return
  }
  denied()
}

async function serveMemberManagement(request, response, route, authSession) {
  if (!authSession || authSession.role !== 'owner') { sendJson(response, 403, { error: '请先启用并登录主人账号。' }); return }
  const memberId = route[1] && decodeURIComponent(route[1])
  if (request.method === 'GET' && !memberId) {
    sendJson(response, 200, { members: [...members.values()].map(publicMember) })
    return
  }
  if (request.method !== (memberId ? 'PUT' : 'POST')) { sendJson(response, 405, { error: '不支持的请求方法。' }); return }
  try {
    const input = await readJson(request)
    if (auth.session(request.headers.cookie)?.key !== authSession.key) { sendJson(response, 401, { error: '会话已失效。' }); return }
    const previous = memberId && members.get(memberId)
    if (memberId && !previous) { sendJson(response, 404, { error: '找不到项目成员。' }); return }
    if (!memberId && members.size >= 100) { sendJson(response, 409, { error: '当前实例最多支持 100 个成员。' }); return }
    const { record, key } = updateMember(input, previous, workflow.projects)
    members.set(record.id, record)
    if (previous) auth.revokeMember(record.id).forEach(revokeStreams)
    await persistWorkflow()
    sendJson(response, previous ? 200 : 201, { member: publicMember(record), ...(key ? { accessKey: key } : {}) })
  } catch (error) { sendJson(response, error.status ?? 500, { error: error.status ? error.message : '保存项目成员失败。' }) }
}

async function serveRequest(request, response) {
  const origin = request.headers.origin
  let url
  try {
    if (!/^\/(?!\/)/.test(request.url ?? '') || request.url.includes('\\')) throw new Error()
    url = new URL(request.url, `http://${host}:${boundPort}`)
    decodeURIComponent(url.pathname)
  } catch { sendJson(response, 400, { error: '无效的请求路径。' }); return }
  const inboundWebhook = request.method === 'POST' && url.pathname.match(/^\/api\/inbound\/([^/]+)$/)
  const isEventStream = request.method === 'GET' && url.pathname.endsWith('/events')
  const denied = () => sendJson(response, 403, { error: '请求来源或目标地址未获允许。' })
  if (inboundWebhook && !httpsOrigin) { denied(); return }
  if (desktopMode) {
    if (request.headers.host !== '127.0.0.1:' + boundPort || !desktopRequestAllowed(request.socket.remoteAddress, request.headers.authorization)) { denied(); return }
    response.setHeader('referrer-policy', 'no-referrer')
    response.setHeader('x-content-type-options', 'nosniff')
    if (!url.pathname.startsWith('/api/')) {
      if (!serveWorkbench(request, response, url.pathname)) sendJson(response, 404, { error: '找不到页面。' })
      return
    }
  } else if (!clientAddressAllowed(request.socket.remoteAddress, deployment)) { denied(); return }
  if (!desktopMode && httpsOrigin) {
    response.setHeader('referrer-policy', 'same-origin')
    response.setHeader('x-content-type-options', 'nosniff')
    if (!httpsHostAllowed(request.headers, httpsOrigin)) { denied(); return }
    if (!url.pathname.startsWith('/api/')) {
      if (!serveWorkbench(request, response, url.pathname)) sendJson(response, 404, { error: '找不到页面。' })
      return
    }
    if (!inboundWebhook && !httpsRequestAllowed(request, httpsOrigin, isEventStream)) { denied(); return }
  } else if (!desktopMode && !inboundWebhook && (!isAllowedApiHost(request.headers.host) || !isAllowedUiOrigin(origin) || (!isEventStream && request.headers['x-zhidian-client'] !== 'web-ui'))) {
    denied()
    return
  }

  if (inboundWebhook) {
    const projectId = decodeURIComponent(inboundWebhook[1])
    const audit = auditLog.start('inbound.receive')
    audit.resourceId = projectId
    if (!auditLog.available) {
      sendJson(response, 503, { error: '审计日志不可用，暂不接受入站请求。' })
      return
    }
    auditRequests.set(response, audit)
    response.once('close', () => { if (auditRequests.delete(response)) auditLog.record(audit, 'disconnected', { resourceId: projectId }) })
    await serveInboundWebhook(request, response, projectId)
    return
  }

  if (request.method === 'GET' && url.pathname === '/api/health') {
    sendJson(response, auditLog.available ? 200 : 503, { ok: auditLog.available })
    return
  }

  const authSession = auth.session(request.headers.cookie)
  const action = auditAction(request.method, url.pathname)
  if (action) {
    const entry = auditLog.start(action, authSession ?? (!auth.enabled ? { role: 'local' } : null))
    const exitAction = ['auth.logout', 'run.cancel', 'occurrence.cancel'].includes(action)
    if (!exitAction && (!auditLog.available || ((authSession?.role === 'owner' || !auth.enabled) && action !== 'auth.login' && !auditLog.record(entry, 'attempt')))) {
      sendJson(response, 503, { error: '审计日志不可用，暂不接受新的变更。' })
      return
    }
    auditRequests.set(response, entry)
    response.once('close', () => {
      if (auditRequests.delete(response)) auditLog.record(entry, 'disconnected')
    })
  }
  if (request.method === 'GET' && url.pathname === '/api/auth/status') {
    sendJson(response, 200, { required: auth.enabled, signedIn: !auth.enabled || Boolean(authSession), role: auth.enabled ? authSession?.role : 'owner' })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/auth/login') {
    try {
      const { key, memberId } = await readJson(request)
      const result = auth.login(key, request.headers.cookie, memberId)
      if (result.status === 200 && auditRequests.has(response)) {
        Object.assign(auditRequests.get(response), { role: memberId === undefined ? 'owner' : 'viewer', memberId })
      }
      if (result.cookie) response.setHeader('set-cookie', result.cookie)
      if (result.status === 429) response.setHeader('retry-after', '60')
      result.revoked?.forEach(revokeStreams)
      sendJson(response, result.status, result.status === 200 ? { signedIn: true } : { error: result.status === 429 ? '登录次数过多，请稍后重试。' : '无法登录，请检查账号和访问密钥。' })
    } catch (error) { sendJson(response, error.status ?? 400, { error: '登录请求无效。' }) }
    return
  }
  if (auth.enabled && !authSession) {
    sendJson(response, 401, { error: '请先登录织点。' })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
    const key = auth.logout(request.headers.cookie)
    if (key) revokeStreams(key)
    response.setHeader('set-cookie', auth.clearCookie)
    sendJson(response, 200, { signedIn: false })
    return
  }

  if (authSession?.role === 'viewer') { serveViewer(request, response, url, authSession); return }
  const memberRoute = url.pathname.match(/^\/api\/members(?:\/([^/]+))?$/)
  if (memberRoute) { await serveMemberManagement(request, response, memberRoute, authSession); return }

  if (request.method === 'GET' && url.pathname === '/api/harnesses') {
    sendJson(response, 200, { harnesses: await getHarnessStatuses() })
    return
  }

  if (request.method === 'GET' && url.pathname === '/api/executors') {
    sendJson(response, 200, { executors: executorRegistry.list() })
    return
  }

  if (request.method === 'GET' && url.pathname === '/api/providers') {
    sendJson(response, 200, {
      providers: Object.fromEntries([...providers].map(([id, value]) => [id, {
        baseUrl: value.baseUrl,
        hasApiKey: Boolean(value.apiKey),
        maskedApiKey: value.apiKey ? `••••${value.apiKey.slice(-4)}` : '',
      }])),
    })
    return
  }

  if (request.method === 'GET' && url.pathname === '/api/runs') {
    sendJson(response, 200, { runs: [...runs.values()].slice(-50).reverse().map(publicRun) })
    return
  }

  const cancelRunMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/)
  if (request.method === 'POST' && cancelRunMatch) {
    const runId = decodeURIComponent(cancelRunMatch[1])
    const run = runs.get(runId)
    if (!run || !workflow.tasks.has(run.taskId)) {
      sendJson(response, 404, { error: '找不到可取消的工作流运行。' })
      return
    }
    auditResource(response, run.id)
    if (run.status !== 'queued' && run.status !== 'running') {
      sendJson(response, 409, { error: `运行当前状态“${run.status}”，不能取消。` })
      return
    }
    const task = workflow.tasks.get(run.taskId)
    const session = workflow.sessions.get(task.sessionId)
    if (run.status === 'queued') {
      const queueIndex = queue.indexOf(runId)
      if (queueIndex >= 0) queue.splice(queueIndex, 1)
      run.status = 'cancelled'
      run.error = '排队中的运行已取消；不会自动重放。'
      run.completedAt = now()
      task.status = 'cancelled'
      task.updatedAt = now()
      if (session) { session.status = 'active'; session.updatedAt = now() }
      saveThreadAssistantMessage(task, `任务状态：cancelled\n${run.error}`, run.id)
      finishOccurrence(task, run, false)
      enqueueResultDelivery(task, run)
      const thread = workflow.threads.get(task.threadId)
      if (thread) { thread.status = 'failed'; thread.updatedAt = now() }
      addEvent(runId, { type: 'run.cancelled', message: run.error })
      await persistWorkflow()
      sendJson(response, 200, { cancelled: true, run: publicRun(run), task })
      return
    }
    const controller = runControllers.get(runId)
    if (!controller) {
      sendJson(response, 409, { error: '运行正在切换状态，请刷新后重试。' })
      return
    }
    if (!controller.signal.aborted) {
      run.cancellationRequestedAt = now()
      controller.abort()
      addEvent(runId, { type: 'run.cancellation_requested', message: '已请求取消；正在等待执行器与子进程停止。' })
      await persistRuns()
    }
    sendJson(response, 202, { cancellationRequested: true, run: publicRun(run) })
    return
  }

  if (request.method === 'GET' && url.pathname === '/api/workflow') {
    sendWorkflowState(request, response, '', publicWorkflow)
    return
  }

  if (request.method === 'GET' && url.pathname === '/api/workbench') {
    sendWorkflowState(request, response, '-workbench', workbenchSummary)
    return
  }

  if (request.method === 'GET' && url.pathname === '/api/workbench/tasks') {
    const stage = url.searchParams.get('stage')
    const sources = url.searchParams.get('sources') === '1'
    const projectId = url.searchParams.get('projectId')
    const page = historyPage(workflow.tasks, url.searchParams, (task, query) => {
      if (sources && (!task.agents?.ceo || !task.agents?.qa)) return false
      if (projectId && workflow.sessions.get(task.sessionId)?.projectId !== projectId) return false
      const currentStage = taskStage(task.status)
      return (!stage || stage === currentStage) && (!query || `${task.title} ${task.brief} 本地 Agent 工作流 ${stageOwners[currentStage]}`.toLowerCase().includes(query))
    }, taskSummary)
    if (!page) sendJson(response, 400, { error: '任务分页游标已失效。' })
    else sendJson(response, 200, page)
    return
  }

  if (request.method === 'GET' && url.pathname === '/api/workbench/threads') {
    const page = historyPage(workflow.threads, url.searchParams, (thread, query) => !query || `${thread.title} ${workflow.projects.get(thread.projectId)?.name ?? ''}`.toLowerCase().includes(query), publicThread)
    if (!page) sendJson(response, 400, { error: '线程分页游标已失效。' })
    else sendJson(response, 200, page)
    return
  }

  const taskDetailMatch = url.pathname.match(/^\/api\/workbench\/tasks\/([^/]+)$/)
  if (request.method === 'GET' && taskDetailMatch) {
    const task = workflow.tasks.get(decodeURIComponent(taskDetailMatch[1]))
    if (!task) { sendJson(response, 404, { error: '找不到工作流任务。' }); return }
    sendWorkflowState(request, response, `-task-${createHash('sha256').update(task.id).digest('hex')}`, () => ({
      summary: taskSummary(task), task, runs: [...runs.values()].filter((run) => run.taskId === task.id).map(publicRun),
      review: workflow.reviews.get(task.reviewId) ?? null,
    }))
    return
  }

  const workbenchRun = /^\/api\/workbench\/runs\/([^/]+)$/.exec(url.pathname)
  if (request.method === 'GET' && workbenchRun) {
    const run = runs.get(decodeURIComponent(workbenchRun[1]))
    const task = run && workflow.tasks.get(run.taskId)
    if (!task) sendJson(response, 404, { error: '找不到此工作流运行。' })
    else {
      const projectId = projectForRun(run, workflow)
      const project = workflow.projects.get(projectId)
      sendJson(response, 200, { run: publicRun(run), project: project ? { id: project.id, name: project.name } : null })
    }
    return
  }

  if (url.pathname === '/api/delivery' && request.method === 'GET') {
    const projectId = url.searchParams.get('projectId')
    if (projectId !== null && !workflow.projects.has(projectId)) {
      sendJson(response, 404, { error: '找不到通知项目。' })
      return
    }
    const targets = projectId ? [workflow.deliveryTargets.get(projectId)].filter(Boolean) : [...workflow.deliveryTargets.values()]
    sendJson(response, 200, { targets: targets.map(publicDeliveryTarget), deliveries: [...recentDeliveries(projectId)].map(({ revision: _revision, messageId: _messageId, replyUuid: _replyUuid, replyText: _replyText, ...item }) => item) })
    return
  }

  if (url.pathname === '/api/inbound' && request.method === 'GET') {
    const enabled = Boolean(httpsOrigin && inboundEnabled)
    if (authSession?.role !== 'owner') { sendJson(response, 200, { enabled: false, targets: [], events: [] }); return }
    const projectId = url.searchParams.get('projectId')
    const events = [...workflow.inboundEvents.values()].reverse().filter((event) => !projectId || event.projectId === projectId)
    const pending = events.filter((event) => event.status === 'awaiting-owner')
    const handled = events.filter((event) => event.status !== 'awaiting-owner')
    sendJson(response, 200, {
      enabled,
      targets: [...workflow.inboundTargets.values()].map(publicInboundTarget),
      events: [...pending, ...handled].slice(0, 100).map(publicInboundEvent),
    })
    return
  }

  const inboundDecision = /^\/api\/inbound\/requests\/(inbound-[a-f0-9]{64})$/.exec(url.pathname)
  if (inboundDecision && request.method === 'POST') {
    try {
      if (authSession?.role !== 'owner') throw scheduleError('请先登录主人账号。', 403)
      const body = await readJson(request)
      if (auth.session(request.headers.cookie)?.key !== authSession.key) throw scheduleError('会话已失效。', 401)
      const record = workflow.inboundEvents.get(inboundDecision[1])
      if (!record) throw scheduleError('找不到入站请求。', 404)
      auditResource(response, record.id)
      sendJson(response, 200, { event: publicInboundEvent(await decideInboundEvent(record, body)) })
    } catch (error) { sendJson(response, error.status ?? 500, { error: error.status ? error.message : '无法处理入站请求。' }) }
    return
  }

  const inboundConfigMatch = url.pathname.match(/^\/api\/inbound\/([^/]+)$/)
  if (inboundConfigMatch) {
    try {
      const projectId = decodeURIComponent(inboundConfigMatch[1])
      if (authSession?.role !== 'owner') throw scheduleError('请先登录主人账号。', 403)
      const previous = workflow.inboundTargets.get(projectId)
      auditResource(response, projectId)
      if (request.method === 'PUT') {
        const body = await readJson(request)
        if (auth.session(request.headers.cookie)?.key !== authSession.key) throw scheduleError('会话已失效。', 401)
        if (workflow.inboundTargets.get(projectId) !== previous) throw scheduleError('配置已变更，请重新加载。', 409)
        sendJson(response, 200, { target: await saveInboundTarget(projectId, body, previous, () => auth.session(request.headers.cookie)?.key === authSession.key) })
      } else if (request.method === 'DELETE') {
        supersedeDeliveries(projectId, 'inbound-reply')
        workflow.inboundTargets.delete(projectId)
        await persistWorkflow()
        sendJson(response, 200, { deleted: true })
      } else throw scheduleError('不支持的请求方法。', 405)
    } catch (error) { sendJson(response, error.status ?? 500, { error: error.status ? error.message : '入站配置无法保存，请检查本机凭据存储。' }) }
    return
  }

  const deliveryMatch = url.pathname.match(/^\/api\/delivery\/([^/]+)(?:\/(test))?$/)
  if (deliveryMatch) {
    try {
      const projectId = decodeURIComponent(deliveryMatch[1])
      const target = workflow.deliveryTargets.get(projectId)
      if (workflow.projects.has(projectId)) auditResource(response, projectId)
      if (request.method === 'PUT' && !deliveryMatch[2]) {
        const body = await readJson(request)
        sendJson(response, 200, { target: await saveDeliveryTarget(projectId, body, target) })
      } else if (request.method === 'DELETE' && !deliveryMatch[2]) {
        supersedeDeliveries(projectId)
        workflow.deliveryTargets.delete(projectId)
        await persistWorkflow()
        sendJson(response, 200, { deleted: true })
      } else if (request.method === 'POST' && deliveryMatch[2]) {
        if (!target?.enabled) throw scheduleError('请先启用该项目的通知渠道。', 409)
        if ([...workflow.deliveries.values()].some((item) => item.projectId === projectId && item.event === 'test' && Date.parse(item.createdAt) > Date.now() - 15_000)) throw scheduleError('测试通知每 15 秒最多一次。', 429)
        queueDelivery(target, id('delivery-test'), 'test')
        await persistWorkflow()
        sendJson(response, 202, { queued: true })
      } else throw scheduleError('不支持的请求方法。', 405)
    } catch (error) { sendJson(response, error.status ?? 500, { error: error.status ? error.message : '通知配置无法保存，请检查本机凭据存储。' }) }
    return
  }

  if (url.pathname === '/api/schedules' && request.method === 'GET') {
    sendJson(response, 200, { schedules: [...workflow.schedules.values()].filter((item) => !item.deletedAt).map(publicSchedule), occurrences: [...workflow.occurrences.values()].reverse().slice(0, 100).map(publicOccurrence) })
    return
  }

  if (url.pathname === '/api/schedules' && request.method === 'POST') {
    try {
      const body = await readJson(request)
      if ([...workflow.schedules.values()].filter((item) => !item.deletedAt).length >= 50) throw scheduleError('本机最多保留 50 个未删除的定时计划。', 409)
      const schedule = normalizeSchedule(body)
      workflow.schedules.set(schedule.id, schedule)
      await persistWorkflow()
      sendJson(response, 201, { schedule: publicSchedule(schedule) })
    } catch (error) { sendJson(response, error.status ?? 500, { error: error.message }) }
    return
  }

  const scheduleMatch = url.pathname.match(/^\/api\/schedules\/([^/]+)(?:\/(run-now))?$/)
  if (scheduleMatch) {
    try {
      const schedule = workflow.schedules.get(decodeURIComponent(scheduleMatch[1]))
      if (!schedule || schedule.deletedAt) throw scheduleError('找不到定时计划。', 404)
      auditResource(response, schedule.id)
      const active = [...workflow.occurrences.values()].find((item) => item.scheduleId === schedule.id && pendingOccurrence(item))
      if (request.method === 'POST' && scheduleMatch[2]) {
        const { requestId } = await readJson(request)
        if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(requestId)) throw scheduleError('缺少有效的触发请求标识。')
        const key = `manual-${schedule.id}-${requestId}`
        let item = workflow.occurrences.get(key)
        if (!item) {
          if ([...workflow.occurrences.values()].some((candidate) => candidate.scheduleId === schedule.id && pendingOccurrence(candidate))) throw scheduleError('该计划已有未完成的触发。', 409)
          if (schedule.deletedAt) throw scheduleError('该定时计划已删除。', 404)
          if (schedule.grant !== projectGrant(workflow.projects.get(schedule.projectId))) throw scheduleError('项目授权已变更；请重新确认计划权限。', 403)
          item = makeOccurrence(schedule, key, now(), 'manual')
          workflow.occurrences.set(item.id, item)
          await persistWorkflow()
        }
        wakeScheduler()
        sendJson(response, 202, { occurrence: publicOccurrence(item) })
      } else if (request.method === 'PUT' && !scheduleMatch[2]) {
        const body = await readJson(request)
        if ([...workflow.occurrences.values()].some((item) => item.scheduleId === schedule.id && pendingOccurrence(item))) throw scheduleError('该计划仍有未完成的触发。', 409)
        if (workflow.schedules.get(schedule.id) !== schedule || schedule.deletedAt) throw scheduleError('计划已变更，请刷新。', 409)
        const updated = normalizeSchedule(body, schedule)
        workflow.schedules.set(schedule.id, updated)
        await persistWorkflow()
        sendJson(response, 200, { schedule: publicSchedule(updated) })
      } else if (request.method === 'DELETE' && !scheduleMatch[2]) {
        if (active) throw scheduleError('请先取消或等待当前触发完成。', 409)
        schedule.deletedAt = now()
        schedule.enabled = false
        schedule.nextRunAt = null
        await persistWorkflow()
        sendJson(response, 200, { deleted: true })
      } else throw scheduleError('不支持的请求方法。', 405)
    } catch (error) { sendJson(response, error.status ?? 500, { error: error.message }) }
    return
  }

  const occurrenceMatch = url.pathname.match(/^\/api\/occurrences\/([^/]+)\/cancel$/)
  if (occurrenceMatch && request.method === 'POST') {
    const item = workflow.occurrences.get(decodeURIComponent(occurrenceMatch[1]))
    if (!item) { sendJson(response, 404, { error: '找不到触发记录。' }); return }
    auditResource(response, item.id)
    const latestTaskId = item.taskIds.at(-1)
    const run = latestTaskId && [...runs.values()].reverse().find((candidate) => candidate.taskId === latestTaskId && ['queued', 'running'].includes(candidate.status))
    const controller = run && runControllers.get(run.id)
    if (item.status === 'running' && run?.status === 'running' && controller) {
      controller.abort()
      sendJson(response, 202, { cancellationRequested: true })
    } else if (item.status === 'pending' || item.status === 'retry-wait' || (item.status === 'running' && run?.status === 'queued')) {
      if (run?.status === 'queued') {
        run.status = 'cancelled'
        run.completedAt = now()
        run.error = '排队中的定时任务已取消。'
        const task = workflow.tasks.get(run.taskId)
        task.status = 'cancelled'
        task.updatedAt = now()
        saveThreadAssistantMessage(task, run.error, run.id)
        enqueueResultDelivery(task, run)
        addEvent(run.id, { type: 'run.cancelled', message: run.error })
      }
      item.status = 'cancelled'
      item.retryAt = null
      item.updatedAt = now()
      await persistWorkflow()
      sendJson(response, 200, { cancelled: true })
    } else sendJson(response, 409, { error: '此次触发已结束或正在切换状态。' })
    return
  }

  if (url.pathname === '/api/context' && request.method === 'GET') {
    sendJson(response, 200, { entries: [...workflow.contextEntries.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) })
    return
  }

  if (url.pathname === '/api/context' && request.method === 'POST') {
    try {
      const entry = normalizeContextEntry(await readJson(request), workflow.projects)
      workflow.contextEntries.set(entry.id, entry)
      await persistWorkflow()
      sendJson(response, 201, { entry })
    } catch (error) {
      sendJson(response, error.status ?? 500, { error: error.message ?? '无法保存上下文。' })
    }
    return
  }

  const contextMatch = url.pathname.match(/^\/api\/context\/([^/]+)$/)
  if (contextMatch) {
    const contextId = decodeURIComponent(contextMatch[1])
    const previous = workflow.contextEntries.get(contextId)
    if (!previous) { sendJson(response, 404, { error: '找不到上下文资料。' }); return }
    auditResource(response, previous.id)
    try {
      if (request.method === 'PUT') {
        const entry = normalizeContextEntry(await readJson(request), workflow.projects, previous)
        workflow.contextEntries.set(entry.id, entry)
        await persistWorkflow()
        sendJson(response, 200, { entry })
      } else if (request.method === 'DELETE') {
        workflow.contextEntries.delete(contextId)
        await persistWorkflow()
        sendJson(response, 200, { deleted: true })
      } else sendJson(response, 405, { error: '不支持的请求方法。' })
    } catch (error) {
      sendJson(response, error.status ?? 500, { error: error.message ?? '无法更新上下文。' })
    }
    return
  }

  if (request.method === 'POST' && url.pathname === '/api/projects') {
    try {
      sendJson(response, 200, { project: await registerProject(await readJson(request)) })
    } catch (error) {
      sendJson(response, error.status ?? 500, { error: error.message ?? '项目授权失败。' })
    }
    return
  }

  if (request.method === 'GET' && url.pathname === '/api/threads') {
    const threads = [...workflow.threads.values()].map((thread) => {
      const messages = [...workflow.messages.values()].filter((message) => message.threadId === thread.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      const tasks = [...workflow.tasks.values()].filter((task) => task.threadId === thread.id)
      return { ...publicThread(thread), projectName: workflow.projects.get(thread.projectId)?.name ?? '未知项目', messageCount: messages.length, taskCount: tasks.length, lastMessage: messages.length ? publicThreadMessage(messages.at(-1)) : null }
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    sendJson(response, 200, { threads })
    return
  }

  const threadFollowupMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/followups$/)
  if (request.method === 'POST' && threadFollowupMatch) {
    const threadId = decodeURIComponent(threadFollowupMatch[1])
    const thread = workflow.threads.get(threadId)
    if (!thread) { sendJson(response, 404, { error: '找不到工作线程。' }); return }
    try {
      if (httpsOrigin && request.headers['idempotency-key'] === undefined) throw Object.assign(new Error('HTTPS 提交必须带任务提交标识。'), { status: 400 })
      sendJson(response, 202, await submitWorkflow(await readJson(request), thread, request.headers['idempotency-key']))
    } catch (error) {
      sendJson(response, error.status ?? 500, { error: error.message ?? '无法续接工作线程。' })
    }
    return
  }

  const threadDetailMatch = url.pathname.match(/^\/api\/threads\/([^/]+)$/)
  if (request.method === 'GET' && threadDetailMatch) {
    const detail = threadDetail(decodeURIComponent(threadDetailMatch[1]))
    if (!detail) sendJson(response, 404, { error: '找不到工作线程。' })
    else sendJson(response, 200, detail)
    return
  }

  if (request.method === 'POST' && url.pathname === '/api/workflow/start') {
    try {
      if (httpsOrigin && request.headers['idempotency-key'] === undefined) throw Object.assign(new Error('HTTPS 提交必须带任务提交标识。'), { status: 400 })
      sendJson(response, 202, await submitWorkflow(await readJson(request), null, request.headers['idempotency-key']))
    } catch (error) {
      sendJson(response, error.status ?? 500, { error: error.message ?? '无法启动工作流。' })
    }
    return
  }

  const runEventsMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/events$/)
  if (request.method === 'GET' && runEventsMatch) {
    const runId = decodeURIComponent(runEventsMatch[1])
    const run = runs.get(runId)
    if (!run) {
      sendJson(response, 404, { error: '找不到运行记录。' })
      return
    }
    writeRunEvents(run, response, authSession, request.headers['last-event-id'], url.searchParams.get('view') === 'summary')
    return
  }

  const decisionMatch = url.pathname.match(/^\/api\/workflow\/([^/]+)\/decision$/)
  if (request.method === 'POST' && decisionMatch) {
    try {
      const task = workflow.tasks.get(decodeURIComponent(decisionMatch[1]))
      if (!task) throw scheduleError('找不到工作流任务。', 404)
      auditResource(response, task.id)
      sendJson(response, 200, await decideTaskDelivery(task, await readJson(request)))
    } catch (error) {
      sendJson(response, error.status ?? 500, { error: error.message ?? '无法保存验收决定。' })
    }
    return
  }

  const phaseMatch = url.pathname.match(/^\/api\/workflow\/([^/]+)\/(plan|execute|review)$/)
  if (request.method === 'POST' && phaseMatch) {
    try {
      const taskId = decodeURIComponent(phaseMatch[1])
      const task = workflow.tasks.get(taskId)
      if (!task) throw Object.assign(new Error('找不到工作流任务。'), { status: 404 })
      let body = await readJson(request)
      const action = phaseMatch[2]
      const returned = workflow.reviews.get(task.reviewId)?.decision?.value === 'return'
      const allowedStatuses = action === 'plan' ? ['failed'] : action === 'execute' ? ['planned', 'needs-fix', 'failed'] : ['executed', 'needs-fix', 'failed']
      if (!allowedStatuses.includes(task.status)) {
        throw Object.assign(new Error(`任务当前状态“${task.status}”不能启动此阶段。`), { status: 409 })
      }
      if (returned) {
        if (action !== 'execute') throw scheduleError('人工退回后需要重新执行，不能直接再次验收。', 409)
        body = task.specialistOrder?.[0] ?? task.specialists?.[0] ?? task.agents?.specialist
        if (!body) throw scheduleError('找不到原任务的专业 Agent。', 409)
      }
      const phase = action === 'plan' ? 'ceo-plan' : action === 'execute' ? 'specialist-execute' : 'qa-review'
      const defaultAgent = action === 'plan' ? 'CEO Agent' : action === 'execute' ? '专业 Agent' : '测试 Agent'
      const agentName = body.name ?? body.agentName ?? defaultAgent
      if (!agentIsConfigured(body)) throw Object.assign(new Error(`${agentName} 缺少执行器或模型配置。`), { status: 400 })
      const run = makeWorkflowRun({ ...body, executionMode: task.executionMode }, task, agentName, phase)
      if (returned) {
        task.execution = null
        task.currentSpecialistIndex = 0
        const occurrence = workflow.occurrences.get(task.occurrenceId)
        if (occurrence?.status === 'failed' && occurrence.taskIds.at(-1) === task.id) Object.assign(occurrence, { status: 'running', error: null, updatedAt: now() })
      } else if (action === 'execute' && body.id) {
        const order = task.specialistOrder ?? task.specialists ?? []
        task.currentSpecialistIndex = Math.max(0, order.findIndex((agent) => agent.id === body.id))
      }
      task.status = action === 'plan' ? 'queued' : action === 'execute' ? 'executing' : 'reviewing'
      task.updatedAt = now()
      task.reviewId = null
      runs.set(run.id, run)
      await persistWorkflow()
      queue.push(run.id)
      void processQueue()
      sendJson(response, 202, { run: publicRun(run), task })
    } catch (error) {
      sendJson(response, error.status ?? 500, { error: error.message ?? '无法推进工作流。' })
    }
    return
  }

  if (request.method === 'POST' && url.pathname === '/api/runs/plan') {
    try {
      const body = await readJson(request)
      sendJson(response, 200, { run: await createPlanningRun(body) })
    } catch (error) {
      sendJson(response, error.status ?? 500, { error: error.message ?? '本地规划服务发生错误。' })
    }
    return
  }

  const providerMatch = url.pathname.match(/^\/api\/providers\/([^/]+)(?:\/(test))?$/)
  const providerId = providerMatch ? decodeURIComponent(providerMatch[1]) : ''
  if (providerMatch && providers.has(providerId)) {
    const id = providerId
    auditResource(response, id)
    const action = providerMatch[2]
    try {
      const body = await readJson(request)
      if (action === 'test' && request.method === 'POST') {
        sendJson(response, 200, await testProvider(id, body))
        return
      }
      if (!action && request.method === 'PUT') {
        const current = providers.get(id)
        const baseUrl = requireProviderUrl(id, normalizeBaseUrl(body.baseUrl, id === 'OpenAI Compatible'))
        const apiKey = body.clearApiKey === true
          ? ''
          : typeof body.apiKey === 'string' && body.apiKey.trim()
            ? body.apiKey.trim()
            : current.apiKey
        if (apiKey && process.platform !== 'win32' && !credentialVault) {
          throw Object.assign(new Error('当前系统暂不支持安全保存 API Key。'), { status: 501 })
        }
        providers.set(id, { baseUrl, apiKey })
        await persistProviders()
        sendJson(response, 200, { saved: true, hasApiKey: Boolean(apiKey) })
        return
      }
      if (!action && request.method === 'DELETE') {
        providers.set(id, { baseUrl: providers.get(id).baseUrl, apiKey: '' })
        await persistProviders()
        sendJson(response, 200, { deleted: true })
        return
      }
      sendJson(response, 405, { error: '不支持的请求方法。' })
    } catch (error) {
      sendJson(response, error.status ?? 500, { error: error.message ?? '本地服务发生错误。' })
    }
    return
  }

  sendJson(response, 404, { error: '找不到请求的本地接口。' })
}

function handleRequest(request, response) {
  void serveRequest(request, response).catch((error) => {
    console.error('Unhandled request failure:', error.name)
    if (response.headersSent) response.destroy()
    else sendJson(response, 500, { error: '本地服务发生错误。' })
  })
}

const limits = { requestTimeout: 30_000, headersTimeout: 10_000, maxHeaderSize: 16 * 1024 }
const server = tlsOptions ? createTlsServer({ ...tlsOptions, ...limits, handshakeTimeout: 10_000 }, handleRequest) : createServer(limits, handleRequest)
if (tlsOptions) server.maxConnections = 128

server.listen(port, host, () => {
  if (desktopMode) {
    boundPort = server.address().port
    process.stdout.write('ZHIDIAN_DESKTOP_READY:' + boundPort + '\n')
  } else {
    console.log(`Zhidian listening on ${tlsOptions ? 'https' : 'http'}://${host}:${port}`)
  }
  if (queue.length) void processQueue()
  wakeScheduler()
  schedulerTimer = setInterval(wakeScheduler, 1_000)
  schedulerTimer.unref()
  deliveryTimer = setInterval(() => { void tickDeliveries().catch((error) => console.error('Delivery worker failed:', error.name)) }, 1_000)
  deliveryTimer.unref()
})

function closeEventStreams() {
  for (const responses of eventClients.values()) for (const response of responses) response.end()
  eventClients.clear()
  for (const streams of sessionStreams.values()) streams.clear()
  sessionStreams.clear()
}

async function shutdown(exitCode = 0) {
  if (shutdownPromise) return shutdownPromise
  shutdownPromise = (async () => {
    shuttingDown = true
    if (schedulerTimer) clearInterval(schedulerTimer)
    if (deliveryTimer) clearInterval(deliveryTimer)
    closeEventStreams()
    for (const controller of runControllers.values()) controller.abort(new Error('本地服务正在停机。'))
    for (const controller of deliveryControllers.values()) controller.abort(new Error('本地服务正在停机。'))
    await Promise.allSettled([queuePromise, schedulerPromise, deliveryPromise].filter(Boolean))
    await new Promise((resolveClose) => { if (server.listening) server.close(resolveClose); else resolveClose() })
    // A no-op serialized write also waits behind any request that was finishing during server.close().
    await Promise.allSettled([persistProviders(), persistWorkflow()])
    sqliteStore?.close()
    await new Promise((resolveClose) => dataLock.close(resolveClose))
    process.exit(exitCode)
  })().catch((error) => {
    console.error(`Shutdown failed: ${error.message}`)
    process.exit(1)
  })
  return shutdownPromise
}

process.on('SIGINT', () => { void shutdown(0) })
process.on('SIGTERM', () => { void shutdown(0) })
process.on('message', (message) => { if (message?.type === 'zhidian:shutdown') void shutdown(0) })
process.parentPort?.on('message', (event) => {
  if (event.data?.type === 'zhidian:shutdown') void shutdown(0)
})
