import { spawn } from 'node:child_process'
import { lstat, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const host = '127.0.0.1'
const port = Number(process.env.ZHIDIAN_API_PORT ?? 8787)
const dataDir = process.env.ZHIDIAN_DATA_DIR ?? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Zhidian')
const configPath = join(dataDir, 'providers.json')
const maxBodyBytes = 64 * 1024
const runsPath = join(dataDir, 'runs.json')
const workflowPath = join(dataDir, 'workflow.json')
const maxProjectFiles = 180
const maxSnapshotBytes = 45 * 1024
const allowedTextExtensions = new Set(['.js', '.jsx', '.ts', '.tsx', '.json', '.css', '.html', '.md', '.mjs', '.cjs', '.yml', '.yaml', '.toml'])

const providerDefinitions = {
  OpenAI: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', keyRequired: true, kind: 'openai' },
  Anthropic: { label: 'Anthropic / Claude', baseUrl: 'https://api.anthropic.com', keyRequired: true, kind: 'anthropic' },
  DeepSeek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', keyRequired: true, kind: 'openai' },
  'OpenAI Compatible': { label: '兼容 OpenAI API', baseUrl: '', keyRequired: true, kind: 'openai' },
  Local: { label: '本地模型', baseUrl: 'http://localhost:11434/v1', keyRequired: false, kind: 'openai' },
}

const providers = new Map(Object.entries(providerDefinitions).map(([id, definition]) => [id, {
  baseUrl: definition.baseUrl,
  apiKey: '',
}]))
const runs = new Map()
const workflow = {
  projects: new Map(),
  sessions: new Map(),
  tasks: new Map(),
  reviews: new Map(),
}
const eventClients = new Map()
const queue = []
let queueActive = false
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
    child.stdin.end(Buffer.from(payload, 'utf8').toString('base64'))
  })
}

const protect = powershell('protect')
const unprotect = powershell('unprotect')

async function loadProviders() {
  try {
    const stored = JSON.parse(await readFile(configPath, 'utf8'))
    for (const [id, value] of Object.entries(stored)) {
      if (!providers.has(id) || !value || typeof value !== 'object') continue
      const current = providers.get(id)
      current.baseUrl = typeof value.baseUrl === 'string' ? value.baseUrl : current.baseUrl
      if (typeof value.encryptedApiKey === 'string' && value.encryptedApiKey) {
        current.apiKey = Buffer.from(await unprotect(value.encryptedApiKey), 'base64').toString('utf8')
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(`Could not load provider settings: ${error.message}`)
    }
  }
}

async function persistProviders() {
  await mkdir(dataDir, { recursive: true })
  const stored = {}
  for (const [id, provider] of providers) {
    stored[id] = {
      baseUrl: provider.baseUrl,
      encryptedApiKey: provider.apiKey ? await protect(provider.apiKey) : '',
    }
  }
  const tempPath = `${configPath}.tmp`
  await writeFile(tempPath, JSON.stringify(stored, null, 2), { encoding: 'utf8', mode: 0o600 })
  await rename(tempPath, configPath)
}

async function loadRuns() {
  try {
    const stored = JSON.parse(await readFile(runsPath, 'utf8'))
    if (!Array.isArray(stored)) return
    for (const run of stored.slice(-100)) {
      if (run && typeof run.id === 'string') runs.set(run.id, run)
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`Could not load run records: ${error.message}`)
  }
}

async function persistRuns() {
  await mkdir(dataDir, { recursive: true })
  const tempPath = `${runsPath}.tmp`
  await writeFile(tempPath, JSON.stringify([...runs.values()].slice(-100), null, 2), { encoding: 'utf8', mode: 0o600 })
  await rename(tempPath, runsPath)
}

async function loadWorkflow() {
  try {
    const stored = JSON.parse(await readFile(workflowPath, 'utf8'))
    for (const project of stored.projects ?? []) if (project?.id) workflow.projects.set(project.id, project)
    for (const session of stored.sessions ?? []) if (session?.id) workflow.sessions.set(session.id, session)
    for (const task of stored.tasks ?? []) if (task?.id) workflow.tasks.set(task.id, task)
    for (const review of stored.reviews ?? []) if (review?.id) workflow.reviews.set(review.id, review)
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`Could not load workflow state: ${error.message}`)
  }
}

async function persistWorkflow() {
  await mkdir(dataDir, { recursive: true })
  const stored = {
    projects: [...workflow.projects.values()].slice(-50),
    sessions: [...workflow.sessions.values()].slice(-100),
    tasks: [...workflow.tasks.values()].slice(-200),
    reviews: [...workflow.reviews.values()].slice(-200),
  }
  const tempPath = `${workflowPath}.tmp`
  await writeFile(tempPath, JSON.stringify(stored, null, 2), { encoding: 'utf8', mode: 0o600 })
  await rename(tempPath, workflowPath)
}

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
  if (run) {
    run.events = [...(run.events ?? []), { id: id('event'), at: now(), ...event }].slice(-100)
  }
  const clients = eventClients.get(runId) ?? []
  const payload = `data: ${JSON.stringify({ runId, ...event })}\n\n`
  for (const response of clients) response.write(payload)
}

function subscribeRun(runId, response) {
  const clients = eventClients.get(runId) ?? []
  clients.push(response)
  eventClients.set(runId, clients)
  response.on('close', () => {
    const current = eventClients.get(runId) ?? []
    eventClients.set(runId, current.filter((item) => item !== response))
  })
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

function normalizeProjectInput(body) {
  const projectPath = typeof body.path === 'string' ? body.path.trim() : ''
  if (!projectPath || !isAbsolute(projectPath)) throw Object.assign(new Error('项目目录必须是绝对路径。'), { status: 400 })
  const accessMode = body.accessMode === 'execute' ? 'execute' : body.accessMode === 'write' ? 'write' : 'read-only'
  const allowedCommands = Array.isArray(body.allowedCommands)
    ? body.allowedCommands.filter((command) => typeof command === 'string' && command.trim()).map((command) => command.trim()).slice(0, 12)
    : []
  return { path: resolve(projectPath), name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : projectPath.split(/[\\/]/).filter(Boolean).pop() ?? '项目', accessMode, allowedCommands }
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
    phase: run.phase,
    status: run.status,
    mode: run.mode,
    agentName: run.agentName,
    provider: run.provider,
    model: run.model,
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

function publicWorkflow() {
  return {
    projects: [...workflow.projects.values()],
    sessions: [...workflow.sessions.values()],
    tasks: [...workflow.tasks.values()],
    runs: [...runs.values()].map(publicRun),
    reviews: [...workflow.reviews.values()],
  }
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(JSON.stringify(value))
}

function isLocalOrigin(value) {
  if (!value) return false
  try {
    const origin = new URL(value)
    return origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
  } catch {
    return false
  }
}

async function readJson(request) {
  let body = ''
  for await (const chunk of request) {
    body += chunk
    if (Buffer.byteLength(body) > maxBodyBytes) throw Object.assign(new Error('请求内容过大。'), { status: 413 })
  }
  try {
    return JSON.parse(body || '{}')
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
  const baseUrl = normalizeBaseUrl(body.baseUrl ?? saved.baseUrl)
  const apiKey = typeof body.apiKey === 'string' && body.apiKey.trim() ? body.apiKey.trim() : saved.apiKey
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  if (!model) throw Object.assign(new Error('请填写用于连接测试的 Model ID。'), { status: 400 })
  if (definition.keyRequired && !apiKey) throw Object.assign(new Error('请先填写并保存 API Key，或在连接测试时临时填写。'), { status: 400 })

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
    upstream = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(45_000) })
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

function makeWorkflowRun(body, task, agentName, phase) {
  return {
    id: id('run'),
    taskId: task.id,
    sessionId: task.sessionId,
    phase,
    status: 'queued',
    mode: body.executionMode ?? 'read-only',
    agentName,
    provider: body.provider ?? '',
    model: body.model ?? '',
    taskTitle: task.title,
    skillNames: Array.isArray(body.skills) ? body.skills.map((skill) => skill.name).filter(Boolean).slice(0, 12) : [],
    events: [],
    createdAt: now(),
  }
}

async function requestAgentModel({ providerId, model, agentName, system, prompt, maxTokens = 1600 }) {
  const definition = providerDefinitions[providerId]
  const saved = providers.get(providerId)
  if (!definition || !saved) throw Object.assign(new Error(`未找到 ${agentName} 的服务商配置。`), { status: 400 })
  if (!model) throw Object.assign(new Error(`${agentName} 没有填写 Model ID。`), { status: 400 })
  if (definition.keyRequired && !saved.apiKey) throw Object.assign(new Error(`请先在模型接入页保存 ${definition.label} 的 API Key。`), { status: 400 })
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
    upstream = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(60_000) })
  } catch (error) {
    if (error.name === 'TimeoutError') throw new Error(`${agentName} 模型请求超时。`)
    throw new Error(`${agentName} 无法连接模型服务商：${error.message}`)
  }
  const responseBody = await upstream.json().catch(() => ({}))
  if (!upstream.ok) {
    const detail = responseBody?.error?.message ?? responseBody?.message
    const safeDetail = typeof detail === 'string' ? detail.replaceAll(saved.apiKey, '[已隐藏]').slice(0, 320) : `服务商返回 HTTP ${upstream.status}。`
    throw new Error(`${agentName} 请求失败：${safeDetail}`)
  }
  const output = getTextContent(responseBody, definition.kind)
  if (!output) throw new Error(`${agentName} 返回空结果。`)
  return output
}

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

async function runCommand(command, cwd, timeoutMs) {
  return new Promise((resolveResult) => {
    const child = spawn(process.platform === 'win32' ? 'powershell.exe' : 'sh', process.platform === 'win32' ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command] : ['-lc', command], {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const append = (current, chunk) => `${current}${chunk}`.slice(-executionDefaults.maxOutputBytes)
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout = append(stdout, chunk) })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr = append(stderr, chunk) })
    const timer = setTimeout(() => {
      child.kill()
      resolveResult({ exitCode: null, timedOut: true, stdout, stderr: `${stderr}\n命令超时。` })
    }, timeoutMs)
    child.on('error', (error) => { clearTimeout(timer); resolveResult({ exitCode: null, timedOut: false, stdout, stderr: error.message }) })
    child.on('close', (exitCode) => { clearTimeout(timer); resolveResult({ exitCode, timedOut: false, stdout, stderr }) })
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

async function writeAgentFiles(project, files) {
  if (project.accessMode !== 'write' && project.accessMode !== 'execute') throw new Error('当前项目授权为只读，Agent 不能写入文件。')
  if (!Array.isArray(files) || files.length === 0) return []
  const pending = []
  for (const file of files.slice(0, executionDefaults.maxFiles)) {
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
    await mkdir(dirname(file.target), { recursive: true })
    await assertSafeWriteTarget(project, file.target)
    await writeFile(file.target, file.content, 'utf8')
    written.push(file.relativePath)
  }
  return written
}

async function runWorkflow(runId) {
  const run = runs.get(runId)
  const task = run ? workflow.tasks.get(run.taskId) : null
  const session = task ? workflow.sessions.get(task.sessionId) : null
  const project = session ? workflow.projects.get(session.projectId) : null
  if (!run) return
  if (!task || !session || !project) {
    run.status = 'failed'
    run.error = '工作流上下文不完整，无法执行。'
    run.completedAt = now()
    addEvent(runId, { type: 'run.failed', message: run.error })
    await persistRuns()
    return
  }
  const agent = run.phase === 'ceo-plan'
    ? task.agents?.ceo ?? task.agent ?? {}
    : run.phase === 'specialist-execute'
      ? task.agents?.specialist ?? {}
      : task.agents?.qa ?? {}
  const skills = Array.isArray(agent.skills) ? agent.skills : []
  run.status = 'running'
  addEvent(runId, { type: 'run.started', phase: run.phase, message: `${run.agentName} 开始${run.phase === 'ceo-plan' ? '拆解任务' : run.phase === 'specialist-execute' ? '执行任务' : '独立验收'}` })
  await persistRuns()
  try {
    const snapshot = await projectSnapshot(project)
    addEvent(runId, { type: 'context.loaded', message: `已读取项目目录，发现 ${snapshot.files.length} 个文件，文本上下文 ${snapshot.textFiles.length} 个文件。` })
    const skillContext = skills.map((skill, index) => `${index + 1}. ${skill.name}：${skill.description ?? ''}；验证：${skill.verification ?? ''}`).join('\n') || '没有绑定 Skills。'
    if (run.phase === 'ceo-plan') {
      const system = `你是织点的 CEO Agent。你处于只读规划阶段，只能拆解任务，不得声称修改文件或运行测试。必须只输出 JSON：{"summary":"...","steps":[{"title":"...","owner":"...","acceptance":"..."}],"risks":["..."],"recommendedCommands":["..."]}。`
      const prompt = `任务：${task.title}\n背景：${task.brief}\n项目文件：${snapshot.files.slice(0, 120).join(', ')}\nCEO Skills：${skillContext}`
      const output = await requestAgentModel({ providerId: run.provider, model: run.model, agentName: run.agentName, system, prompt, maxTokens: 1800 })
      const plan = extractJsonObject(output) ?? { summary: output, steps: [], risks: ['模型没有返回可解析 JSON'], recommendedCommands: [] }
      task.plan = plan
      task.status = 'planned'
      task.updatedAt = now()
      run.output = output
      run.plan = plan
      addEvent(runId, { type: 'plan.created', message: 'CEO 已生成结构化任务计划。', plan })
      if (task.agents?.specialist?.provider && task.agents?.specialist?.model) {
        task.status = 'executing'
        task.updatedAt = now()
        const nextRun = makeWorkflowRun({ ...task.agents.specialist, executionMode: task.executionMode }, task, task.agents.specialist.name ?? '专业 Agent', 'specialist-execute')
        runs.set(nextRun.id, nextRun)
        queue.push(nextRun.id)
        task.nextRunId = nextRun.id
        addEvent(runId, { type: 'handoff.created', message: `CEO 已交接给 ${nextRun.agentName}。`, nextRunId: nextRun.id })
      }
    } else if (run.phase === 'specialist-execute') {
      const system = `你是织点的专业执行 Agent。你只能在授权项目目录内工作。根据任务和 Skills 返回 JSON，不要返回 Markdown：{"summary":"...","files":[{"path":"相对路径","content":"完整文件内容"}],"commands":["必须是用户已白名单授权的命令"],"acceptanceNotes":["..."]}。没有必要修改时 files 返回空数组。`
      const prompt = `任务：${task.title}\n背景：${task.brief}\nCEO 计划：${JSON.stringify(task.plan ?? {})}\n岗位：${run.agentName}\nSkills：${skillContext}\n当前项目文件：${snapshot.textFiles.map((file) => `--- ${file.path}\n${file.content}`).join('\n').slice(0, maxSnapshotBytes)}\n当前项目权限：${project.accessMode}；白名单命令：${project.allowedCommands.join(' | ') || '无'}`
      const output = await requestAgentModel({ providerId: run.provider, model: run.model, agentName: run.agentName, system, prompt, maxTokens: 2600 })
      const execution = extractJsonObject(output) ?? { summary: output, files: [], commands: [], acceptanceNotes: [] }
      const writtenFiles = await writeAgentFiles(project, execution.files)
      const commandResults = []
      for (const command of Array.isArray(execution.commands) ? execution.commands.slice(0, 6) : []) {
        if (!commandIsAllowed(command, project)) {
          commandResults.push({ command, exitCode: null, skipped: true, stderr: '命令未在项目白名单中，已跳过。' })
          continue
        }
        const result = await runCommand(command, project.path, executionDefaults.commandTimeoutMs)
        commandResults.push({ command, ...result })
      }
      task.execution = { summary: execution.summary, writtenFiles, commandResults, acceptanceNotes: execution.acceptanceNotes ?? [] }
      task.status = 'executed'
      task.updatedAt = now()
      run.output = output
      run.execution = task.execution
      addEvent(runId, { type: 'execution.completed', message: `专业 Agent 完成执行，写入 ${writtenFiles.length} 个文件，运行 ${commandResults.filter((item) => !item.skipped).length} 条白名单命令。`, execution: task.execution })
      if (task.agents?.qa?.provider && task.agents?.qa?.model) {
        task.status = 'reviewing'
        task.updatedAt = now()
        const nextRun = makeWorkflowRun({ ...task.agents.qa, executionMode: task.executionMode }, task, task.agents.qa.name ?? '测试 Agent', 'qa-review')
        runs.set(nextRun.id, nextRun)
        queue.push(nextRun.id)
        task.nextRunId = nextRun.id
        addEvent(runId, { type: 'handoff.created', message: `专业 Agent 已交接给 ${nextRun.agentName}。`, nextRunId: nextRun.id })
      }
    } else {
      const system = `你是织点的测试 Agent。你是独立验收者，不得默认相信前一个 Agent 的结论。只输出 JSON：{"status":"passed"或"failed","summary":"...","checks":[{"name":"...","passed":true,"evidence":"..."}],"followups":["..."]}。只能基于提供的文件快照和命令结果判断，不能编造证据。`
      const prompt = `任务：${task.title}\n验收要求：${task.brief}\n执行结果：${JSON.stringify(task.execution ?? {})}\n项目快照：${snapshot.textFiles.map((file) => `--- ${file.path}\n${file.content}`).join('\n').slice(0, maxSnapshotBytes)}\n测试 Skills：${skillContext}`
      const output = await requestAgentModel({ providerId: run.provider, model: run.model, agentName: run.agentName, system, prompt, maxTokens: 2000 })
      const review = extractJsonObject(output) ?? { status: 'failed', summary: output, checks: [], followups: ['模型没有返回可解析验收 JSON。'] }
      const checks = Array.isArray(review.checks) ? review.checks.filter((check) => check && typeof check.name === 'string').slice(0, 20).map((check) => ({ name: check.name.slice(0, 160), passed: check.passed === true, evidence: typeof check.evidence === 'string' ? check.evidence.slice(0, 600) : '' })) : []
      const commandIssues = (task.execution?.commandResults ?? []).filter((result) => result.skipped || result.timedOut || result.exitCode !== 0)
      const followups = Array.isArray(review.followups) ? review.followups.filter((item) => typeof item === 'string').slice(0, 10).map((item) => item.slice(0, 500)) : []
      if (checks.length === 0 || checks.some((check) => !check.passed || !check.evidence.trim())) followups.push('验收未提供全部通过且附有证据的检查项。')
      for (const result of commandIssues) followups.push(result.skipped ? `白名单命令未执行：${result.command}` : `命令未成功：${result.command}（退出码：${result.exitCode ?? '超时'}）`)
      const checksPass = checks.length > 0 && checks.every((check) => check.passed && check.evidence.trim())
      const status = review.status === 'passed' && checksPass && commandIssues.length === 0 ? 'passed' : 'failed'
      const summary = typeof review.summary === 'string' ? review.summary.slice(0, 1200) : '测试 Agent 未提供验收摘要。'
      const reviewRecord = { id: id('review'), taskId: task.id, runId, status, summary: status === 'passed' ? summary : review.status === 'passed' ? `未通过证据校验：${summary}` : summary, checks, followups: followups.slice(0, 12), createdAt: now() }
      workflow.reviews.set(reviewRecord.id, reviewRecord)
      task.reviewId = reviewRecord.id
      task.status = reviewRecord.status === 'passed' ? 'approved' : 'needs-fix'
      task.updatedAt = now()
      run.output = output
      run.review = reviewRecord
      addEvent(runId, { type: 'review.completed', message: `测试 Agent 独立验收：${reviewRecord.status === 'passed' ? '通过' : '需要整改'}。`, review: reviewRecord })
    }
    run.status = 'completed'
    run.completedAt = now()
    addEvent(runId, { type: 'run.completed', message: `${run.agentName} 的 ${run.phase} 已完成。` })
  } catch (error) {
    run.status = 'failed'
    run.error = error.message ?? '工作流运行失败。'
    run.completedAt = now()
    task.status = run.phase === 'qa-review' ? 'needs-fix' : 'failed'
    task.updatedAt = now()
    if (run.phase === 'qa-review' && !task.reviewId) {
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
    addEvent(runId, { type: 'run.failed', message: run.error })
  }
  session.status = task.status === 'approved' ? 'completed' : task.status === 'failed' ? 'failed' : 'active'
  session.updatedAt = now()
  await persistRuns()
  await persistWorkflow()
}

async function processQueue() {
  if (queueActive) return
  queueActive = true
  try {
    while (queue.length) {
      const runId = queue.shift()
      try {
        await runWorkflow(runId)
      } catch (error) {
        console.error(`Workflow run ${runId} failed unexpectedly: ${error.message}`)
      }
    }
  } finally {
    queueActive = false
    if (queue.length) void processQueue()
  }
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
    }
  }
  await persistRuns()
  await persistWorkflow()
}

async function enqueueWorkflow(body) {
  const project = workflow.projects.get(body.projectId)
  if (!project) throw Object.assign(new Error('请先选择已授权的项目目录。'), { status: 400 })
  const title = typeof body.title === 'string' ? body.title.trim() : ''
  if (!title) throw Object.assign(new Error('任务标题不能为空。'), { status: 400 })
  const session = { id: id('session'), projectId: project.id, title, status: 'active', createdAt: now(), updatedAt: now() }
  const agents = body.agents && typeof body.agents === 'object' ? body.agents : {}
  const task = { id: id('task'), sessionId: session.id, title, brief: typeof body.brief === 'string' ? body.brief.trim() : '', status: 'queued', executionMode: project.accessMode, createdAt: now(), updatedAt: now(), agents, plan: null, execution: null, reviewId: null }
  const ceo = agents.ceo ?? {}
  const run = makeWorkflowRun({ ...ceo, executionMode: project.accessMode }, task, ceo.name ?? 'CEO Agent', 'ceo-plan')
  workflow.sessions.set(session.id, session)
  workflow.tasks.set(task.id, task)
  runs.set(run.id, run)
  queue.push(run.id)
  await persistWorkflow()
  await persistRuns()
  void processQueue()
  return { session, task, run: publicRun(run) }
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

await loadProviders()
await loadRuns()
await loadWorkflow()
await recoverWorkflowQueue()

const server = createServer(async (request, response) => {
  const origin = request.headers.origin
  const url = new URL(request.url ?? '/', `http://${host}:${port}`)
  const isEventStream = request.method === 'GET' && url.pathname.endsWith('/events')
  if (!isLocalOrigin(origin) || (!isEventStream && request.headers['x-zhidian-client'] !== 'web-ui')) {
    sendJson(response, 403, { error: '请求来源未获允许。' })
    return
  }

  if (request.method === 'GET' && url.pathname === '/api/health') {
    sendJson(response, 200, { ok: true })
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

  if (request.method === 'GET' && url.pathname === '/api/workflow') {
    sendJson(response, 200, publicWorkflow())
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

  if (request.method === 'POST' && url.pathname === '/api/workflow/start') {
    try {
      sendJson(response, 202, await enqueueWorkflow(await readJson(request)))
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
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' })
    response.write(`data: ${JSON.stringify({ type: 'run.snapshot', run: publicRun(run) })}\n\n`)
    for (const event of run.events ?? []) response.write(`data: ${JSON.stringify({ runId, ...event })}\n\n`)
    subscribeRun(runId, response)
    return
  }

  const phaseMatch = url.pathname.match(/^\/api\/workflow\/([^/]+)\/(plan|execute|review)$/)
  if (request.method === 'POST' && phaseMatch) {
    try {
      const taskId = decodeURIComponent(phaseMatch[1])
      const task = workflow.tasks.get(taskId)
      if (!task) throw Object.assign(new Error('找不到工作流任务。'), { status: 404 })
      const action = phaseMatch[2]
      const allowedStatuses = action === 'plan' ? ['failed'] : action === 'execute' ? ['planned', 'needs-fix', 'failed'] : ['executed']
      if (!allowedStatuses.includes(task.status)) {
        throw Object.assign(new Error(`任务当前状态“${task.status}”不能启动此阶段。`), { status: 409 })
      }
      const body = await readJson(request)
      const phase = action === 'plan' ? 'ceo-plan' : action === 'execute' ? 'specialist-execute' : 'qa-review'
      const defaultAgent = action === 'plan' ? 'CEO Agent' : action === 'execute' ? '专业 Agent' : '测试 Agent'
      const agentName = body.agentName ?? defaultAgent
      const run = makeWorkflowRun({ ...body, executionMode: task.executionMode }, task, agentName, phase)
      task.status = action === 'plan' ? 'queued' : action === 'execute' ? 'executing' : 'reviewing'
      task.updatedAt = now()
      runs.set(run.id, run)
      queue.push(run.id)
      await persistWorkflow()
      await persistRuns()
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
    const action = providerMatch[2]
    try {
      const body = await readJson(request)
      if (action === 'test' && request.method === 'POST') {
        sendJson(response, 200, await testProvider(id, body))
        return
      }
      if (!action && request.method === 'PUT') {
        const current = providers.get(id)
        const baseUrl = normalizeBaseUrl(body.baseUrl, id === 'OpenAI Compatible')
        const apiKey = body.clearApiKey === true
          ? ''
          : typeof body.apiKey === 'string' && body.apiKey.trim()
            ? body.apiKey.trim()
            : current.apiKey
        if (apiKey && process.platform !== 'win32') {
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
})

server.listen(port, host, () => {
  console.log(`Zhidian local API listening on http://${host}:${port}`)
  if (queue.length) void processQueue()
})

process.on('SIGINT', () => server.close(() => process.exit(0)))
process.on('SIGTERM', () => server.close(() => process.exit(0)))
