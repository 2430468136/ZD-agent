import assert from 'node:assert/strict'
import { execFile, spawn, spawnSync } from 'node:child_process'
import { createCipheriv, createHash, randomBytes, randomUUID, X509Certificate } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { request as requestHttp } from 'node:http'
import { request as requestTls } from 'node:https'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { checkServerIdentity, createServer as createTlsListener } from 'node:tls'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { openSqliteWorkflow } from '../server/sqlite-workflow.mjs'
import { CURRENT_WORKFLOW_SCHEMA_VERSION } from '../server/workflow-store.mjs'
import { buildInboundSignature } from '../server/inbound-delivery.mjs'

const directory = await mkdtemp(join(tmpdir(), 'zhidian-https-e2e-'))
const children = []
const root = new URL('../', import.meta.url)
const exec = promisify(execFile)
const ownerKey = randomBytes(32).toString('base64url')
const ownerHash = createHash('sha256').update(ownerKey).digest('hex')
const [apiPort, providerPort] = await Promise.all([freePort(), freePort()])
const sockets = new Set()
const relay = createServer((client) => {
  const upstream = connect(apiPort, '127.0.0.1')
  sockets.add(client)
  client.on('error', () => upstream.destroy())
  upstream.on('error', () => client.destroy())
  client.once('close', () => { sockets.delete(client); upstream.destroy() })
  upstream.once('close', () => client.destroy())
  client.pipe(upstream).pipe(client)
})
await new Promise((resolve, reject) => { relay.once('error', reject); relay.listen(0, '127.0.0.1', resolve) })
const origin = `https://127.0.0.1:${relay.address().port}`
const caFile = join(directory, 'ca.pem')
const tlsKeyFile = join(directory, 'tls.pem')
const keyring = join(directory, 'keyring.json')
let ca
const fixtureCount = 43
const oldestTitle = 'Historical fixture 00'
const fixtureOutput = 'Historical raw output: not in list responses'
const historyTaskId = 'history-task-00'
const historyThreadId = 'history-thread-00'
const mockAgent = (id, name) => ({ id, name, provider: 'DeepSeek', model: 'mock-model', executor: 'deepseek-api', skills: [{ name: `${name} skill` }] })
const mockAgents = { ceo: mockAgent('ceo', 'CEO Agent'), specialists: [mockAgent('frontend', '专业 Agent')], qa: mockAgent('qa', '测试 Agent') }

function resolveOpenSsl() {
  const configured = process.env.ZHIDIAN_TEST_OPENSSL?.trim()
  if (configured) return configured
  if (process.platform !== 'win32') return 'openssl'
  const candidates = [
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    'C:\\Program Files\\OpenSSL-Win64\\bin\\openssl.exe',
    'C:\\Program Files\\OpenSSL\\bin\\openssl.exe',
  ]
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['version'], { encoding: 'utf8', windowsHide: true })
    if (result.status === 0) return candidate
  }
  return 'openssl'
}

async function seedHistory() {
  const dataDir = join(directory, 'data')
  const projectPath = join(directory, 'historic')
  await Promise.all([mkdir(dataDir), mkdir(projectPath)])
  const store = openSqliteWorkflow(join(dataDir, 'workflow.sqlite'))
  const at = '2026-01-01T00:00:00.000Z'
  const projectId = 'history-project'
  const data = { schemaVersion: CURRENT_WORKFLOW_SCHEMA_VERSION, projects: [{ id: projectId, path: projectPath, name: 'History fixtures', accessMode: 'read-only', allowedCommands: [], verificationCommands: [] }], sessions: [], tasks: [], reviews: [], threads: [], messages: [], runs: [], contextEntries: [], schedules: [], occurrences: [], deliveryTargets: [], deliveries: [], members: [] }
  const noisePath = join(directory, 'delivery-noise')
  await mkdir(noisePath)
  data.projects.push({ ...data.projects[0], id: 'delivery-noise', name: 'Delivery noise', path: noisePath })
  const delivery = { channel: 'feishu', event: 'approved', status: 'failed', attempts: 1, createdAt: at, updatedAt: at }
  data.deliveries.push({ ...delivery, id: 'historic-delivery-failure', projectId, taskId: historyTaskId, error: 'Historic delivery error detail' })
  data.deliveries.push({ ...delivery, id: 'out-of-window-failure', projectId: 'delivery-noise' })
  for (let n = 0; n < 101; n += 1) data.deliveries.push({ ...delivery, id: `noise-${n}`, projectId: 'delivery-noise', status: 'sent' })
  for (let n = 0; n < fixtureCount; n += 1) {
    const suffix = String(n).padStart(2, '0')
    const title = `Historical fixture ${suffix}`
    const threadId = `history-thread-${suffix}`
    const sessionId = `history-session-${suffix}`
    const taskId = `history-task-${suffix}`
    const runId = `history-run-${suffix}`
    const reviewId = `history-review-${suffix}`
    const dates = { createdAt: at, updatedAt: at }
    const brief = `${'history '.repeat(80)}search beyond preview ${suffix}`
    data.threads.push({ id: threadId, projectId, title, status: 'completed', agents: mockAgents, ...dates })
    data.sessions.push({ id: sessionId, projectId, threadId, title, status: 'completed', ...dates })
    data.tasks.push({ id: taskId, title, brief, sessionId, threadId, status: 'approved', executionMode: 'read-only', reviewId, agents: mockAgents, ...dates })
    data.runs.push({ id: runId, taskId, sessionId, threadId, phase: 'ceo-plan', status: 'completed', agentName: 'CEO Agent', output: fixtureOutput, createdAt: at, completedAt: at })
    data.reviews.push({ id: reviewId, taskId, runId, status: 'passed', summary: 'Historic QA evidence', createdAt: at })
    data.messages.push({ id: `history-message-${suffix}`, threadId, taskId, role: 'user', content: `Stored message ${suffix}`, createdAt: at })
  }
  try { store.write(data) } finally { store.close() }
}

function freePort() {
  const listener = createServer()
  return new Promise((resolve, reject) => {
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', () => { const { port } = listener.address(); listener.close(() => resolve(port)) })
  })
}

function start(args, variables) {
  const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...variables }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  child.stderr.setEncoding('utf8').on('data', (chunk) => { child.diagnostics = (child.diagnostics ?? '') + chunk })
  children.push(child)
  return child
}

function pilotEnv(overrides) {
  return {
    MOCK_PROVIDER_PORT: String(providerPort), ZHIDIAN_API_PORT: String(apiPort), ZHIDIAN_HTTPS_ORIGIN: origin,
    ZHIDIAN_OWNER_KEY_HASH: ownerHash, ZHIDIAN_CREDENTIAL_KEYRING: keyring,
    ZHIDIAN_TLS_CERT: caFile, ZHIDIAN_TLS_KEY: tlsKeyFile, ZHIDIAN_STORAGE: 'sqlite', ZHIDIAN_ENABLE_INBOUND: '1',
    ZHIDIAN_DATA_DIR: join(directory, 'data'), ...overrides,
  }
}

async function launch(overrides, { expectFailure = Boolean(overrides) } = {}) {
  const child = start(['--import', './scripts/mock-https-provider.mjs', 'server.mjs'], pilotEnv(overrides))
  if (expectFailure) {
    for (let n = 0; n < 100 && child.exitCode === null; n += 1) await wait(50)
    assert.equal(child.exitCode, 1, child.diagnostics)
    return child.diagnostics
  }
  for (let n = 0; n < 100 && child.exitCode === null; n += 1) {
    if ((await call('/api/health').catch(() => null))?.status === 200) return child
    await wait(50)
  }
  throw new Error(`HTTPS instance did not become ready: ${child.diagnostics ?? ''}`)
}

function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => { child.once('exit', resolve); child.kill() })
}

function call(path, { method = 'GET', body, rawBody, cookie, headers = {}, sse = false, webhook = false, gatewayPort } = {}) {
  return new Promise((resolve, reject) => {
    const serialized = rawBody ?? (body === undefined ? '' : JSON.stringify(body))
    const options = { method, agent: false, path, signal: AbortSignal.timeout(6_000), headers: {
      ...(!webhook && { 'sec-fetch-site': 'same-origin', ...(!sse && { 'x-zhidian-client': 'web-ui' }) }),
      ...(!webhook && method !== 'GET' && { origin }), ...(cookie && { cookie }),
      ...(serialized && { 'content-type': 'application/json', ...(!headers['transfer-encoding'] && { 'content-length': Buffer.byteLength(serialized) }) }), ...headers,
    } }
    const callback = async (response) => {
      response.on('error', () => {})
      const status = response.statusCode
      if (sse && status === 200) { resolve({ status, stream: response }); return }
      try {
        let text = ''
        for await (const chunk of response.setEncoding('utf8')) text += chunk
        resolve({ status, headers: response.headers, text, json: response.headers['content-type']?.includes('application/json') ? JSON.parse(text) : null })
      } catch (error) { reject(error) }
    }
    const request = gatewayPort
      ? requestHttp({ ...options, hostname: '127.0.0.1', port: gatewayPort }, callback)
      : requestTls(origin, { ...options, ca, checkServerIdentity: (_host, certificate) => checkServerIdentity('127.0.0.1', certificate) }, callback)
    request.on('error', (error) => reject(Object.assign(error, { childDiagnostics: children.map((child) => child.diagnostics).filter(Boolean).join('\n') })))
    request.end(serialized)
  })
}

async function launchGateway(project, overrides = {}) {
  const gatewayPort = await freePort()
  const variables = { ZHIDIAN_GATEWAY_PORT: String(gatewayPort), ZHIDIAN_GATEWAY_PROJECT_ID: project, ZHIDIAN_GATEWAY_UPSTREAM: origin, ZHIDIAN_GATEWAY_CA: caFile, ...overrides }
  const child = start(['scripts/inbound-gateway.mjs'], variables)
  for (let n = 0; n < 100 && child.exitCode === null; n += 1) {
    if ((await call('/', { gatewayPort }).catch(() => null))?.status === 404) return { gatewayPort, child }
    await wait(50)
  }
  throw new Error(`Callback gateway did not become ready: ${child.diagnostics ?? ''}`)
}

async function login(key, memberId) {
  const result = await call('/api/auth/login', { method: 'POST', body: { key, memberId } })
  assert.equal(result.status, 200, result.text)
  const [setCookie] = result.headers['set-cookie']
  assert.match(setCookie, /^__Host-zhidian_session=/)
  for (const flag of ['Secure', 'SameSite=Strict', 'Path=/', 'HttpOnly']) assert.ok(setCookie.split('; ').includes(flag), flag)
  return setCookie.split(';', 1)[0]
}

async function register(cookie, name) {
  const path = join(directory, name)
  await mkdir(path)
  const result = await call('/api/projects', { method: 'POST', cookie, body: { path, name, accessMode: 'execute', allowedCommands: ['node --version'], verificationCommands: ['node --version'] } })
  assert.equal(result.status, 200, result.text)
  return result.json.project
}

async function observe(path, cookie, predicate, headers) {
  const { stream, status } = await call(path, { sse: true, cookie, headers })
  assert.equal(status, 200)
  let data = ''
  try {
    for await (const chunk of stream.setEncoding('utf8')) {
      data += chunk
      if (predicate(data)) return data
    }
  } finally { stream.destroy() }
  throw new Error('Expected SSE frame was not received.')
}

async function egressSmoke(options) {
  const comparator = createTlsListener({ key: await readFile(tlsKeyFile), cert: ca }, (socket) => socket.end())
  await new Promise((resolve, reject) => { comparator.once('error', reject); comparator.listen(0, '127.0.0.1', resolve) })
  const deniedOrigin = `https://127.0.0.1:${comparator.address().port}`
  const sample = (mode, trusted = true) => exec(process.execPath, ['scripts/pilot-egress.mjs', mode, origin, deniedOrigin, ...(trusted ? [caFile] : [])], options)
  try {
    const control = JSON.parse((await sample('control')).stdout)
    assert.ok(control.expectedObservations && control.allow.tlsVerified && control.deny.tlsVerified)
    await assert.rejects(sample('deployment'), (error) => {
      const report = JSON.parse(error.stdout)
      return error.code === 1 && report.allow.tlsVerified && report.deny.tcpConnected && !report.expectedObservations
    })
  } finally { await new Promise((resolveClose) => comparator.close(resolveClose)) }
  const deployment = JSON.parse((await sample('deployment')).stdout)
  assert.ok(deployment.expectedObservations && deployment.allow.tlsVerified && !deployment.deny.tcpConnected)
  assert.equal(deployment.deny.stage, 'tcp')
  await assert.rejects(sample('deployment', false), (error) => {
    const report = JSON.parse(error.stdout)
    return error.code === 1 && report.allow.tcpConnected && report.allow.stage === 'tls' && !report.allow.tlsVerified
  })
  console.log('PASS: egress probe separates a reachable TCP endpoint, a refused connection, and an untrusted TLS endpoint.')
}

async function browserSubmissionRecovery(page, projectPath, apiSubmit) {
  const title = 'Browser submission recovery fixture'
  const brief = 'Keep this draft in the workbench form only.'
  const message = 'Verify the original thread, without making changes.'
  await page.evaluate(() => {
    const key = 'zhidian-demo-agents-v1'
    const agents = JSON.parse(localStorage.getItem(key))
    localStorage.setItem(key, JSON.stringify(agents.map((agent) => ({ ...agent, provider: 'DeepSeek', model: 'mock-model', executor: 'deepseek-api' }))))
  })
  await page.reload()
  await page.getByRole('button', { name: '退出登录', exact: true }).waitFor()

  async function retry(path, enter, loseReceipt) {
    const requests = []
    const match = (url) => url.pathname === path
    const settled = Promise.withResolvers()
    const intercept = async (route) => {
      const request = route.request()
      const key = request.headers()['idempotency-key']
      requests.push(key)
      if (requests.length > 1) { await route.continue(); return }
      try {
        const stored = await apiSubmit(path, request.postData(), key)
        assert.equal(stored.status, 202, stored.text)
        await loseReceipt(route)
        settled.resolve(stored.json)
      } catch (error) {
        await route.abort().catch(() => {})
        settled.reject(error)
      }
    }
    await page.route(match, intercept)
    try {
      await enter()
      const first = await Promise.race([settled.promise, wait(10_000, undefined, { ref: false }).then(() => { throw new Error(`No committed browser submission at ${path}.`) })])
      const storage = await page.evaluate(() => JSON.stringify(Object.entries(sessionStorage)))
      await page.reload()
      await page.getByRole('button', { name: '退出登录', exact: true }).waitFor()
      assert.equal(requests.length, 1, 'Reload must not automatically resubmit.')
      const received = page.waitForResponse((item) => match(new URL(item.url())) && item.request().method() === 'POST', { timeout: 12_000 })
      await enter()
      const second = await received
      assert.equal(second.status(), 202, await second.text())
      const replay = await second.json()
      assert.deepEqual(requests, [requests[0], requests[0]], 'Retry after reload changed the submission key.')
      assert.equal(replay.task.id, first.task.id, 'Retry created another task.')
      assert.equal(replay.thread.id, first.thread.id)
      assert.ok(storage.includes(requests[0]), 'No reload-safe submission key was stored.')
      for (const raw of [title, brief, message, projectPath]) assert.ok(!storage.includes(raw), 'A draft field was written to session storage.')
      await page.waitForFunction((key) => !JSON.stringify(Object.entries(sessionStorage)).includes(key), requests[0])
      return replay
    } finally { await page.unroute(match, intercept) }
  }

  const start = await retry('/api/workflow/start', async () => {
    await page.getByRole('button', { name: '作战大屏', exact: true }).click()
    await page.getByRole('button', { name: '派发任务', exact: true }).click()
    await page.getByLabel('任务目标', { exact: false }).fill(title)
    await page.getByLabel('验收标准与背景', { exact: false }).fill(brief)
    await page.getByLabel('授权项目目录').fill(projectPath)
    assert.equal(await page.getByLabel('访问范围').inputValue(), 'read-only')
    await page.getByLabel('任务方向').selectOption('前端开发')
    await page.locator('form.create-modal').getByRole('button', { name: '派发任务', exact: true }).click()
  }, (route) => route.abort('internetdisconnected'))

  const followup = await retry(`/api/threads/${start.thread.id}/followups`, async () => {
    await page.getByRole('button', { name: /^工作线程/ }).click()
    await page.getByRole('textbox', { name: '搜索线程' }).fill(title)
    await page.getByRole('button', { name: new RegExp(title) }).click()
    await page.locator('.thread-followup-form textarea').fill(message)
    await page.getByRole('button', { name: '继续此线程' }).click()
  }, (route) => route.fulfill({ status: 202, json: {} }))
  assert.equal(followup.thread.id, start.thread.id)
  console.log('PASS: browser reload reuses an unconfirmed submission key for both tasks and follow-ups without storing draft content.')
}

async function browserOfficeDispatch(page, projectPath) {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 })
    await page.reload()
    const title = `scheduler timeout fixture dashboard dispatch ${width}`
    const office = page.getByRole('region', { name: 'Agent 办公室实时状态' })
    await page.getByRole('button', { name: '派发任务', exact: true }).click()
    await page.getByLabel('任务目标', { exact: false }).fill(title)
    await page.getByLabel('授权项目目录').fill(projectPath)
    await page.getByLabel('任务方向').selectOption('前端开发')
    const form = page.locator('form.create-modal')
    const [response] = await Promise.all([
      page.waitForResponse((item) => new URL(item.url()).pathname === '/api/workflow/start' && item.request().method() === 'POST', { timeout: 12_000 }),
      form.getByRole('button', { name: '派发任务', exact: true }).click({ timeout: 6_000 }),
    ])
    assert.equal(response.status(), 202, await response.text())
    await form.waitFor({ state: 'hidden' })
    assert.ok(await office.isVisible(), 'Submitting from the dashboard must keep the office in view.')
    assert.ok(await office.evaluate((element) => element.scrollWidth <= element.clientWidth), 'Agent seats must fit inside the office.')
    const token = office.locator('.office-dispatch-token.is-visible')
    await token.waitFor({ timeout: 14_000 })
    assert.equal(await office.locator('.office-seat-target').getAttribute('data-agent'), 'frontend')
    const points = await token.evaluate(async (element) => {
      const walk = element.getAnimations().find((item) => item.animationName === 'office-ceo-walk')
      if (!walk) throw new Error('CEO avatar has no walking animation.')
      walk.pause()
      await walk.ready
      const duration = walk.effect.getComputedTiming().duration
      const center = (node) => {
        const { left, top, width, height } = node.getBoundingClientRect()
        return { x: left + width / 2, y: top + height / 2 }
      }
      const floor = element.parentElement
      const source = center(floor.querySelector('[data-agent="ceo"] .office-person'))
      const target = center(floor.querySelector('[data-agent="frontend"] .office-person'))
      const at = (time) => { walk.currentTime = time; return center(element) }
      return { source, target, start: at(0), end: at(duration - 1), mid: at(duration / 2) }
    })
    const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
    assert.ok(distance(points.start, points.source) < 4, JSON.stringify(points))
    assert.ok(distance(points.mid, points.start) > 10, JSON.stringify(points))
    assert.ok(distance(points.end, points.target) < 85 && distance(points.end, points.target) < distance(points.start, points.target), JSON.stringify(points))
    const screenshotDir = process.env.ZHIDIAN_TEST_OFFICE_SCREENSHOTS
    const png = await office.screenshot({ ...(screenshotDir && { path: join(screenshotDir, `office-dispatch-${width}.png`) }) })
    assert.ok(png.length > 1000, 'Office screenshot is empty.')
    await token.waitFor({ state: 'hidden', timeout: 6_000 })
    console.log(`PASS: dashboard submission stays in the office; CEO walks to the front-end Agent after the server handoff at ${width}px.`)
  }
  await page.setViewportSize({ width: 1440, height: 900 })
}

async function browserHarnessWorkspace(page, projectPath, otherPath) {
  const office = page.getByRole('region', { name: 'Agent 办公室实时状态' })
  const workspace = page.locator('.harness-workspace')
  const submit = async (directory, suffix) => {
    const title = `scheduler timeout fixture dashboard dispatch harness-split-${suffix}`
    await page.getByRole('button', { name: '派发任务', exact: true }).click()
    const form = page.locator('form.create-modal')
    await form.getByLabel('任务目标').fill(title)
    await form.getByLabel('授权项目目录').fill(directory)
    await form.getByLabel('任务方向').selectOption('前端开发')
    const [response] = await Promise.all([
      page.waitForResponse((item) => new URL(item.url()).pathname === '/api/workflow/start' && item.request().method() === 'POST'),
      form.getByRole('button', { name: '派发任务', exact: true }).click(),
    ])
    assert.equal(response.status(), 202, await response.text())
    const receipt = await response.json()
    await form.waitFor({ state: 'hidden' })
    await office.locator('.office-seat-target[data-agent=frontend]').waitFor({ timeout: 22_000 })
    const opened = page.waitForResponse(async (item) => new URL(item.url()).pathname.startsWith('/api/workbench/runs/') && item.status() === 200 && (await item.json()).run.taskId === receipt.task.id, { timeout: 10_000 })
    await office.locator('[data-agent=frontend]').click()
    await workspace.waitFor()
    const detail = await (await opened).json()
    assert.equal(detail.run.taskTitle, title)
    assert.equal(detail.run.agentId, 'frontend')
    return { ...detail, pane: workspace.locator(`[data-run-id=${detail.run.id}]`) }
  }

  await page.getByRole('button', { name: '作战大屏', exact: true }).click()
  const a = await submit(projectPath, 'A')
  await a.pane.getByText('前端 Agent 开始执行任务', { exact: true }).waitFor()
  await a.pane.getByText('已完成', { exact: true }).waitFor({ timeout: 10_000 })
  await a.pane.getByText('最终输出', { exact: true }).click()
  await a.pane.getByText(/output-harness-split-A/).waitFor()
  await page.getByRole('button', { name: '作战大屏', exact: true }).click()
  const b = await submit(otherPath, 'B')
  await b.pane.getByText('运行中', { exact: true }).waitFor()
  assert.notEqual(a.project.id, b.project.id)
  assert.equal(await workspace.locator('.harness-pane:visible').count(), 2)
  await a.pane.getByText('已完成', { exact: true }).waitFor()
  assert.ok(!(await a.pane.innerText()).includes(b.run.taskTitle))
  assert.ok(!(await b.pane.innerText()).includes(a.run.taskTitle))
  const [aBox, bBox] = await Promise.all([a.pane.boundingBox(), b.pane.boundingBox()])
  assert.ok(aBox && bBox && bBox.x > aBox.x + aBox.width && Math.abs(aBox.y - bBox.y) < 4)
  const projectPicker = workspace.getByLabel('项目', { exact: true })
  await projectPicker.selectOption(a.project.id)
  assert.ok(await workspace.getByLabel('打开运行').locator(`option[value=${a.run.id}]`).count())
  assert.equal(await workspace.getByLabel('打开运行').locator(`option[value=${b.run.id}]`).count(), 0)
  assert.ok(await b.pane.isVisible(), 'Filtering the picker must not retarget open panes.')
  page.once('dialog', (dialog) => { void dialog.accept() })
  const [cancelResponse] = await Promise.all([
    page.waitForResponse((item) => new URL(item.url()).pathname === `/api/runs/${b.run.id}/cancel`),
    b.pane.getByRole('button', { name: '停止', exact: true }).click(),
  ])
  assert.ok(cancelResponse.ok())
  await b.pane.getByText('已取消', { exact: true }).waitFor({ timeout: 10_000 })
  await a.pane.getByText('最终输出', { exact: true }).click()
  await a.pane.getByText(/output-harness-split-A/).waitFor()
  assert.doesNotMatch(await b.pane.innerText(), /output-harness-split-A/)
  const screenshotDir = process.env.ZHIDIAN_TEST_OFFICE_SCREENSHOTS
  if (screenshotDir) await workspace.screenshot({ path: join(screenshotDir, 'harness-split-1440.png') })

  await workspace.getByRole('button', { name: '单窗格', exact: true }).click()
  await page.reload()
  await page.getByRole('button', { name: 'Harness 分屏', exact: true }).click()
  await b.pane.getByText('已取消', { exact: true }).waitFor()
  assert.equal(await workspace.locator('.harness-pane:visible').count(), 1)
  assert.equal(await workspace.getByRole('button', { name: '单窗格', exact: true }).getAttribute('aria-pressed'), 'true')
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('zhidian-harness-layout-v1')))
  assert.deepEqual(saved, { ids: [a.run.id, b.run.id], focused: b.run.id, mode: 'focus' })

  await workspace.getByRole('button', { name: '并排布局', exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await workspace.getByRole('group', { name: '已打开窗格' }).getByRole('button').first().click()
  assert.ok(await a.pane.isVisible() && !(await b.pane.isVisible()))
  await a.pane.getByText('最终输出', { exact: true }).click()
  await a.pane.getByText(/output-harness-split-A/).waitFor()
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
  if (screenshotDir) await workspace.screenshot({ path: join(screenshotDir, 'harness-split-390.png') })
  await page.setViewportSize({ width: 1440, height: 900 })
  console.log('PASS: office opens the handed-off run; split panes preserve project and run isolation, cancel exactly one run, persist layout, and support narrow switching.')
}

async function browserSmoke(member, { publish, receiveDraft, revokeMember, otherProjectTitle, verifyTask, submissionProject, splitProject, apiSubmit, receivedTaskLink, historyMember, createApprovalTask }) {
  const { chromium } = await import(pathToFileURL(process.env.ZHIDIAN_TEST_PLAYWRIGHT).href)
  const key = new X509Certificate(ca).publicKey.export({ type: 'spki', format: 'der' })
  const pin = createHash('sha256').update(key).digest('base64')
  const browser = await chromium.launch({ executablePath: process.env.ZHIDIAN_TEST_CHROMIUM, args: [`--ignore-certificate-errors-spki-list=${pin}`] })
  try {
    const ownerPage = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    const memberPage = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    await Promise.all([ownerPage.goto(`${origin}/#task=${historyTaskId}`), memberPage.goto(receivedTaskLink)])
    assert.equal(await memberPage.getByRole('region', { name: '链接任务状态' }).count(), 0)
    await memberPage.getByLabel('账号类型').selectOption('member')
    await memberPage.getByLabel('成员 ID').fill(member.member.id)
    async function signIn(page, key) {
      await page.getByLabel('访问密钥').fill(key)
      const response = page.waitForResponse((item) => item.url().endsWith('/api/auth/login') && item.request().method() === 'POST', { timeout: 5_000 })
      await page.getByRole('button', { name: '登录', exact: true }).click()
      assert.equal((await response).status(), 200)
    }
    await Promise.all([signIn(ownerPage, ownerKey), signIn(memberPage, member.accessKey)])
    await ownerPage.getByRole('button', { name: '退出登录', exact: true }).waitFor({ timeout: 5_000 })
    await memberPage.getByRole('heading', { name: '织点 · 项目工作台' }).waitFor({ timeout: 5_000 })
    const linkedDrawer = ownerPage.getByRole('complementary', { name: '任务详情' })
    await linkedDrawer.getByRole('heading', { name: oldestTitle, exact: true }).waitFor()
    await linkedDrawer.getByRole('button', { name: '关闭详情' }).click()
    assert.equal(new URL(ownerPage.url()).hash, '')
    const linkedStatus = memberPage.getByRole('region', { name: '链接任务状态' })
    await linkedStatus.getByText(otherProjectTitle, { exact: true }).waitFor()
    await linkedStatus.getByText('通过', { exact: true }).waitFor()
    assert.ok(await memberPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'The mobile member view overflowed horizontally.')
    await memberPage.goto(`${origin}/#task=${historyTaskId}`)
    await linkedStatus.getByText('找不到可查看的任务。', { exact: true }).waitFor()
    assert.equal(await memberPage.getByText(oldestTitle, { exact: true }).count(), 0)
    await linkedStatus.getByRole('button', { name: '关闭链接任务' }).click()
    assert.equal(new URL(memberPage.url()).hash, '')
    console.log('PASS: notification task links survive sign-in, respect viewer grants, and do not expose another project.')
    await memberPage.getByRole('combobox', { name: '项目' }).waitFor({ timeout: 5_000 })
    assert.deepEqual(await memberPage.locator('select option').allTextContents(), ['shared'])
    assert.ok((await ownerPage.context().cookies(origin)).some(({ name, secure, httpOnly }) => name === '__Host-zhidian_session' && secure && httpOnly))
    await memberPage.getByRole('button', { name: '结果交付', exact: true }).click()
    await memberPage.getByRole('region', { name: '结果交付', exact: true }).getByText('结果未知', { exact: true }).waitFor()
    assert.equal(await memberPage.getByText('渠道返回 HTTP 503。', { exact: true }).count(), 0)
    assert.equal(await memberPage.getByRole('button', { name: '保存配置' }).count(), 0)
    await memberPage.getByRole('button', { name: '工作线程', exact: true }).click()
    const historyPage = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    try {
      await historyPage.goto(origin)
      await historyPage.getByLabel('账号类型').selectOption('member')
      await historyPage.getByLabel('成员 ID').fill(historyMember.member.id)
      await signIn(historyPage, historyMember.accessKey)
      const next = historyPage.getByRole('button', { name: '下一页' })
      await historyPage.getByText('Historical fixture 42', { exact: true }).waitFor()
      assert.equal(await historyPage.getByText(oldestTitle, { exact: true }).count(), 0)
      await next.click()
      await historyPage.getByText(oldestTitle, { exact: true }).waitFor()
      assert.ok(await next.isDisabled())
      const poll = await historyPage.waitForResponse((result) => new URL(result.url()).pathname === '/api/member/history' && result.status() === 304, { timeout: 10_000 })
      assert.ok(await poll.request().headerValue('if-none-match'))
      await historyPage.getByLabel('项目', { exact: true }).selectOption('delivery-noise')
      await historyPage.getByText('暂无记录', { exact: true }).waitFor()
      assert.equal(await historyPage.getByText(oldestTitle, { exact: true }).count(), 0)
      await historyPage.getByRole('button', { name: '结果交付', exact: true }).click()
      await historyPage.getByText('已送达', { exact: true }).first().waitFor()
      assert.equal(await historyPage.getByRole('row').count(), 41)
      await historyPage.getByLabel('项目', { exact: true }).selectOption('history-project')
      await historyPage.getByText('失败', { exact: true }).waitFor()
      assert.ok(await next.isDisabled())
      assert.equal(await historyPage.getByText('Historic delivery error detail').count(), 0)
      assert.equal(await historyPage.getByText('第 1 页', { exact: true }).count(), 1)
      assert.ok(await historyPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      console.log('PASS: mobile viewer pages through older threads, switches project and delivery view, and uses empty 304 polls.')
    } finally { await historyPage.close() }
    await ownerPage.setViewportSize({ width: 390, height: 844 })
    await ownerPage.getByRole('button', { name: '打开导航，3 条投递异常' }).click()
    await ownerPage.getByRole('button', { name: '结果交付，3 条投递异常' }).click()
    await ownerPage.getByRole('button', { name: /History fixtures.*失败 1/ }).click()
    await ownerPage.getByRole('row').filter({ hasText: historyTaskId }).getByText('Historic delivery error detail').waitFor()
    assert.equal(await ownerPage.getByLabel('通知项目').inputValue(), 'history-project')
    await ownerPage.getByRole('link', { name: historyTaskId }).click()
    await linkedDrawer.getByRole('heading', { name: oldestTitle, exact: true }).waitFor()
    await linkedDrawer.getByRole('button', { name: '关闭详情' }).click()
    await ownerPage.getByRole('button', { name: /shared.*结果未知 1/ }).click()
    await ownerPage.getByRole('row').getByText('渠道返回 HTTP 503。', { exact: true }).waitFor()
    assert.ok(await ownerPage.getByLabel('附工作台地址和任务链接').isChecked())
    assert.equal(await ownerPage.getByText('Historic delivery error detail', { exact: true }).count(), 0)
    await ownerPage.setViewportSize({ width: 1440, height: 900 })
    await ownerPage.getByRole('button', { name: '结果交付，3 条投递异常' }).waitFor()
    console.log('PASS: owner navigation surfaces delivery alerts and opens the relevant project records; the viewer has no owner delivery page.')
    await ownerPage.getByRole('button', { name: /^任务流水线/ }).click()
    await ownerPage.bringToFront()
    const idlePoll = await ownerPage.waitForResponse((response) => response.url().endsWith('/api/workbench') && response.status() === 304, { timeout: 12_000 })
    assert.ok(await idlePoll.request().headerValue('if-none-match'))
    assert.equal(await ownerPage.getByText(oldestTitle, { exact: true }).count(), 0)
    await ownerPage.getByRole('button', { name: '下一页' }).click()
    await ownerPage.getByRole('button', { name: new RegExp(oldestTitle) }).click()
    const drawer = ownerPage.getByRole('complementary', { name: '任务详情' })
    await drawer.getByText('Historic QA evidence', { exact: true }).waitFor()
    await drawer.locator('summary').first().click()
    await drawer.getByText(fixtureOutput, { exact: true }).waitFor()
    await drawer.getByRole('button', { name: '关闭详情' }).click()
    await ownerPage.getByRole('button', { name: /^工作线程/ }).click()
    await ownerPage.getByRole('textbox', { name: '搜索线程' }).fill(oldestTitle)
    await ownerPage.getByRole('button', { name: new RegExp(oldestTitle) }).click()
    await ownerPage.getByText('Stored message 00', { exact: true }).waitFor()
    await ownerPage.getByRole('button', { name: '定时任务', exact: true }).click()
    await ownerPage.getByRole('button', { name: `编辑 ${oldestTitle}` }).click()
    assert.equal(await ownerPage.getByLabel('复用工作流').inputValue(), historyTaskId)
    await ownerPage.getByRole('button', { name: '保存计划' }).click()
    await ownerPage.getByText('定时计划已保存', { exact: true }).waitFor()
    await ownerPage.getByRole('button', { name: '飞书 / Lark 入站', exact: true }).click()
    await ownerPage.getByLabel('入站项目').selectOption('history-project')
    await ownerPage.getByRole('heading', { name: '入站收件箱' }).waitFor()
    assert.equal(await memberPage.getByRole('button', { name: '飞书 / Lark 入站' }).count(), 0)
    const draftTitle = await receiveDraft()
    const draftRow = ownerPage.getByRole('row').filter({ hasText: draftTitle })
    await draftRow.getByText('待主人处理', { exact: true }).waitFor()
    await draftRow.getByRole('button', { name: '选择源任务' }).click()
    const search = draftRow.getByRole('textbox', { name: '搜索源任务' })
    const source = draftRow.getByLabel('复用工作流')
    const confirm = draftRow.getByRole('button', { name: '确认并运行' })
    assert.ok(await confirm.isDisabled())
    await draftRow.getByRole('button', { name: '下一页' }).waitFor()
    assert.equal(await source.locator(`option[value="${historyTaskId}"]`).count(), 0)
    await search.fill(otherProjectTitle)
    await source.locator('option', { hasText: '无匹配的源任务' }).waitFor({ state: 'attached' })
    await search.fill(oldestTitle)
    await source.selectOption(historyTaskId)
    const decision = ownerPage.waitForResponse((item) => new URL(item.url()).pathname.startsWith('/api/inbound/requests/') && item.request().method() === 'POST', { timeout: 5_000 })
    await confirm.click()
    const accepted = await decision
    assert.equal(accepted.status(), 200, await accepted.text())
    const { event } = await accepted.json()
    assert.equal(event.status, 'accepted')
    assert.ok(event.taskId)
    await verifyTask(event.taskId, draftTitle)
    const acceptedRow = ownerPage.getByRole('row').filter({ hasText: event.taskId })
    await acceptedRow.getByRole('button', { name: '查看任务' }).click()
    await drawer.getByRole('heading', { name: draftTitle, exact: true }).waitFor()
    await drawer.getByRole('button', { name: '关闭详情' }).click()
    console.log('PASS: browser accepts a mock inbound draft using a historical source from the same project and opens the resulting task.')
    await ownerPage.getByRole('button', { name: '作战大屏' }).click()
    await memberPage.context().setOffline(true)
    const { sharedTitle, privateTitle, animatedTitle } = await publish()
    const dispatch = ownerPage.locator('.office-dispatch-token.is-visible')
    const targetSeat = ownerPage.locator('.office-seat-target[data-agent="frontend"]')
    await dispatch.waitFor({ timeout: 14_000 })
    assert.equal(await targetSeat.count(), 1)
    await ownerPage.getByRole('button', { name: /^任务流水线/ }).click()
    await ownerPage.getByText(animatedTitle, { exact: true }).first().waitFor()
    await ownerPage.getByText(sharedTitle, { exact: true }).first().waitFor({ timeout: 12_000 })
    await ownerPage.getByText(privateTitle, { exact: true }).first().waitFor({ timeout: 12_000 })
    assert.equal(await memberPage.getByText(sharedTitle, { exact: true }).count(), 0)
    await memberPage.context().setOffline(false)
    await memberPage.getByText(sharedTitle, { exact: true }).waitFor({ timeout: 12_000 })
    assert.equal(await memberPage.getByText(privateTitle, { exact: true }).count(), 0)
    await browserSubmissionRecovery(ownerPage, submissionProject, apiSubmit)
    await browserOfficeDispatch(ownerPage, submissionProject)
    await browserHarnessWorkspace(ownerPage, submissionProject, splitProject)
    const approvalTitle = 'Browser manual delivery fixture'
    await createApprovalTask(approvalTitle)
    await ownerPage.getByRole('button', { name: '作战大屏', exact: true }).click()
    const approvalQueue = ownerPage.getByRole('region', { name: '验收队列' })
    const approvalRow = approvalQueue.getByRole('button', { name: new RegExp(approvalTitle) })
    await approvalRow.click()
    await linkedDrawer.getByRole('heading', { name: approvalTitle }).waitFor()
    await linkedDrawer.getByRole('button', { name: '退回修改', exact: true }).click()
    await linkedDrawer.getByLabel('退回原因').fill('Browser rework evidence')
    await linkedDrawer.getByRole('button', { name: '确认退回', exact: true }).click()
    await linkedDrawer.getByText('Browser rework evidence', { exact: true }).waitFor()
    await approvalRow.waitFor({ state: 'hidden' })
    await linkedDrawer.getByRole('button', { name: '重新执行', exact: true }).click()
    await linkedDrawer.getByRole('button', { name: '确认交付', exact: true }).click()
    await linkedDrawer.getByText(/已人工确认交付/).waitFor()
    await approvalRow.waitFor({ state: 'hidden' })
    await linkedDrawer.getByRole('button', { name: '关闭详情' }).click()
    console.log('PASS: browser approval queue opens real workflow records and supports return, re-execution, and approval.')
    await ownerPage.getByRole('button', { name: '退出登录', exact: true }).click()
    await ownerPage.getByLabel('访问密钥').waitFor({ timeout: 5_000 })
    assert.ok(!(await ownerPage.context().cookies(origin)).some(({ name }) => name === '__Host-zhidian_session'))
    assert.equal(await memberPage.getByRole('heading', { name: '织点 · 项目工作台' }).count(), 1)
    await revokeMember()
    await memberPage.getByLabel('访问密钥').waitFor({ timeout: 12_000 })
    assert.equal(await memberPage.getByText(sharedTitle, { exact: true }).count(), 0)
    console.log('PASS: disabling a viewer ends the browser session and removes access to the project without a reload.')
    console.log('PASS: Chromium loads old task logs, finds old threads, saves an old schedule source, animates the CEO handoff, and syncs isolated owner/viewer sessions across disconnect.')
  } finally { await browser.close() }
}

try {
  const certificate = spawnSync(resolveOpenSsl(), ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', tlsKeyFile, '-out', caFile], { encoding: 'utf8', windowsHide: true })
  assert.equal(certificate.status, 0, certificate.error?.message ?? certificate.stderr)
  await chmod(tlsKeyFile, 0o600)
  ca = await readFile(caFile)
  await writeFile(keyring, JSON.stringify({ active: 'fixture', keys: { fixture: randomBytes(32).toString('hex') } }), { mode: 0o600 })
  await seedHistory()
  start(['scripts/mock-provider.mjs'], { MOCK_PROVIDER_PORT: String(providerPort) })
  await launch({ ZHIDIAN_OWNER_KEY_HASH: undefined })
  await launch({ ZHIDIAN_CREDENTIAL_KEYRING: undefined })
  assert.match(await launch({ ZHIDIAN_HTTPS_ORIGIN: `https://localhost:${relay.address().port}` }), /TLS certificate SAN does not match/)
  let api = await launch()
  const probeOptions = { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 12_000 }
  const preflight = (overrides, extra = []) => exec(process.execPath, ['server.mjs', '--check-pilot', ...extra], {
    ...probeOptions, env: { ...process.env, ...pilotEnv(overrides) },
  })
  await assert.rejects(preflight(), (error) => error.code === 1 && /Could not lock the Zhidian data directory/.test(error.stderr))
  const probe = await exec(process.execPath, ['scripts/pilot-probe.mjs', origin, caFile], probeOptions)
  const probeReport = JSON.parse(probe.stdout)
  assert.equal(probeReport.origin, origin)
  assert.equal(probeReport.anonymousWorkflowStatus, 401)
  assert.equal(probeReport.anonymousWorkbenchStatus, 401)
  assert.equal(probeReport.rejectedOriginStatus, 403)
  await egressSmoke(probeOptions)
  await assert.rejects(exec(process.execPath, ['scripts/pilot-probe.mjs', origin], probeOptions), (error) => error.code === 1 && /SELF_SIGNED_CERT/.test(error.stderr))
  const page = await call('/')
  assert.equal(page.status, 200)
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/)
  const script = await call(page.text.match(/src="(\/assets\/[^" ]+\.js)"/)[1])
  assert.equal(script.status, 200)
  assert.equal((await call('/server.mjs')).status, 404)
  assert.equal((await call('/api/workflow')).status, 401)
  assert.equal((await call('/api/health', { headers: { host: 'wrong.example' } })).status, 403)
  assert.equal((await call('/api/health', { headers: { forwarded: 'proto=https;host=example.org' } })).status, 403)
  assert.equal((await call('/api/auth/login', { method: 'POST', headers: { origin: 'https://wrong.example' }, body: { key: ownerKey } })).status, 403)
  assert.equal((await call('/api/auth/login', { method: 'POST', headers: { origin: 'null' }, body: { key: ownerKey } })).status, 403)
  const owner = await login(ownerKey)
  const ownerOther = await login(ownerKey)
  assert.notEqual(owner, ownerOther)
  const initialWorkflow = await call('/api/workflow', { cookie: owner })
  const initialTag = initialWorkflow.headers.etag
  assert.equal(initialWorkflow.status, 200)
  assert.match(initialTag, /^W\/"[a-z0-9-]+-\d+"$/)
  const unchanged = await call('/api/workflow', { cookie: ownerOther, headers: { 'if-none-match': initialTag } })
  assert.equal(unchanged.status, 304)
  assert.equal(unchanged.text, '')
  assert.equal(unchanged.headers['cache-control'], 'no-store')
  assert.equal((await call('/api/workflow', { headers: { 'if-none-match': initialTag } })).status, 401)
  const project = await register(owner, 'shared')
  const privateProject = await register(owner, 'private')
  const historicDelivery = await call('/api/delivery?projectId=history-project', { cookie: owner })
  assert.deepEqual(historicDelivery.json.deliveries.map((item) => item.id), ['historic-delivery-failure'], 'Another project crowded out the historic failure.')
  const beforeDelivery = await call('/api/workbench', { cookie: owner })
  assert.deepEqual(beforeDelivery.json.deliveryAlerts, [{ projectId: 'history-project', failed: 1, unknown: 0 }])
  for (const [item, token] of [[privateProject, 'test-denied-token'], [project, 'test-ambiguous-token']]) {
    const path = `/api/delivery/${item.id}`
    const config = { channel: 'feishu', events: ['cancelled'], webhook: `https://open.feishu.cn/open-apis/bot/v2/hook/${token}` }
    assert.equal((await call(path, { method: 'PUT', cookie: owner, body: config })).status, 200)
    assert.equal((await call(`${path}/test`, { method: 'POST', cookie: owner })).status, 202)
  }
  const deliveryAlerts = async () => (await call('/api/workbench', { cookie: owner })).json.deliveryAlerts
  let alerts
  for (let attempt = 0; attempt < 80; attempt += 1) {
    alerts = await deliveryAlerts()
    if (alerts.some((item) => item.projectId === project.id && item.unknown === 1)) break
    await wait(100)
  }
  assert.deepEqual(Object.fromEntries(alerts.map(({ projectId, failed, unknown }) => [projectId, [failed, unknown]])), {
    'history-project': [1, 0], [privateProject.id]: [1, 0], [project.id]: [0, 1],
  })
  const afterDelivery = await call('/api/workbench', { cookie: owner, headers: { 'if-none-match': beforeDelivery.headers.etag } })
  assert.equal(afterDelivery.status, 200)
  assert.notEqual(afterDelivery.headers.etag, beforeDelivery.headers.etag)
  assert.doesNotMatch(afterDelivery.text, /Historic delivery error detail|test-denied-token|test-ambiguous-token/)
  const deniedDelivery = (await call(`/api/delivery?projectId=${privateProject.id}`, { cookie: owner })).json.deliveries[0]
  const unknownDelivery = (await call(`/api/delivery?projectId=${project.id}`, { cookie: owner })).json.deliveries[0]
  assert.equal(deniedDelivery.status, 'failed')
  assert.match(deniedDelivery.error, /19021/)
  assert.equal(unknownDelivery.status, 'unknown')
  assert.equal(unknownDelivery.attempts, 1)
  assert.equal(unknownDelivery.retryAt, null)
  const inboundToken = 'e2e-verification-token'
  const inboundKey = 'e2e-encrypt-key'
  const inboxProject = 'history-project'
  const inboundPath = `/api/inbound/${inboxProject}`
  const { gatewayPort } = await launchGateway(inboxProject)
  const viaGateway = (path, options = {}) => call(path, { gatewayPort, webhook: true, ...options })
  const webhook = (body, headers) => viaGateway(inboundPath, { method: 'POST', ...(typeof body === 'string' ? { rawBody: body } : { body }), headers })
  for (const path of ['/', '/api/health', '/api/auth/login', '/api/workbench', '/api/workflow/start', '/api/inbound/other-project', `${inboundPath}?extra=1`, `${inboundPath}/`]) {
    assert.equal((await viaGateway(path, { method: 'POST', body: {} })).status, 404, path)
  }
  assert.equal((await viaGateway(inboundPath, { method: 'GET' })).status, 404)
  assert.equal((await viaGateway(inboundPath, { method: 'POST', body: {}, headers: { host: 'wrong.invalid' } })).status, 404)
  assert.equal((await webhook({}, { 'content-encoding': 'gzip' })).status, 415)
  assert.equal((await webhook({}, { 'content-type': 'text/plain' })).status, 415)
  const oversize = JSON.stringify({ data: 'x'.repeat(64 * 1024) })
  assert.equal((await webhook(oversize)).status, 413)
  assert.equal((await webhook(oversize, { 'transfer-encoding': 'chunked' })).status, 413)
  assert.equal((await webhook({}, { 'x-lark-signature': ['a', 'b'] })).status, 400)
  const inboundConfig = await call(inboundPath, { method: 'PUT', cookie: owner, body: {
    channel: 'feishu', enabled: true, appId: 'cli_e2e', tenantKey: 'tenant_e2e', verificationToken: inboundToken, encryptKey: inboundKey, appSecret: 'e2e-app-secret',
    allowedChats: ['oc_e2e'], allowedUsers: ['ou_e2e'], intents: ['status', 'create', 'approve', 'reply'],
  } })
  assert.equal(inboundConfig.status, 200, inboundConfig.text)
  assert.equal(inboundConfig.json.target.hasEncryptKey, true)
  assert.ok(!inboundConfig.text.includes(inboundKey) && !inboundConfig.text.includes(inboundToken))
  const challengeBody = { type: 'url_verification', challenge: 'e2e-challenge', token: inboundToken }
  const challenge = await webhook(challengeBody, { forwarded: 'proto=https;host=fixture.invalid', 'x-forwarded-host': 'fixture.invalid', cookie: owner })
  assert.equal(challenge.status, 200, challenge.text)
  assert.deepEqual(challenge.json, { challenge: 'e2e-challenge' })
  assert.equal(challenge.headers['set-cookie'], undefined)
  const otherCa = join(directory, 'gateway-untrusted-ca.pem')
  const wrongCertificate = spawnSync(resolveOpenSsl(), ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(directory, 'untrusted-key.pem'), '-out', otherCa], { encoding: 'utf8', windowsHide: true })
  assert.equal(wrongCertificate.status, 0, wrongCertificate.stderr)
  const untrusted = await launchGateway(inboxProject, { ZHIDIAN_GATEWAY_CA: otherCa })
  const failedTrust = await call(inboundPath, { method: 'POST', body: challengeBody, webhook: true, gatewayPort: untrusted.gatewayPort })
  assert.equal(failedTrust.status, 502, failedTrust.text)
  assert.ok(!failedTrust.text.includes(inboundToken) && !failedTrust.text.includes('e2e-challenge'))
  await stop(untrusted.child)
  function message(eventId, text, chatId = 'oc_e2e') {
    const sentAt = Date.now()
    const payload = {
      schema: '2.0', header: { token: inboundToken, app_id: 'cli_e2e', tenant_key: 'tenant_e2e', event_type: 'im.message.receive_v1', event_id: eventId, create_time: String(sentAt) },
      event: { sender: { sender_type: 'user', sender_id: { open_id: 'ou_e2e' } }, message: { message_type: 'text', chat_id: chatId, ...(eventId === 'e2e-status' && { message_id: 'om_e2e_status' }), content: JSON.stringify({ text }) } },
    }
    const iv = randomBytes(16)
    const cipher = createCipheriv('aes-256-cbc', createHash('sha256').update(inboundKey).digest(), iv)
    const envelope = { encrypt: Buffer.concat([iv, cipher.update(JSON.stringify(payload)), cipher.final()]).toString('base64') }
    const body = `\n${JSON.stringify(envelope, null, 2)}\n`
    const timestamp = String(Math.floor(sentAt / 1000))
    const nonce = randomUUID()
    return [body, { 'x-lark-request-timestamp': timestamp, 'x-lark-request-nonce': nonce, 'x-lark-signature': buildInboundSignature(timestamp, nonce, inboundKey, body) }]
  }
  const statusMessage = message('e2e-status', `状态 ${historyTaskId}`)
  const createMessage = message('e2e-create', '任务：Review the README')
  assert.equal((await webhook(...statusMessage)).status, 200)
  assert.equal((await webhook(...statusMessage)).status, 200)
  assert.equal((await webhook(...message('e2e-unauthorized', `状态 ${historyTaskId}`, 'oc_other'))).status, 403)
  assert.equal((await webhook(statusMessage[0], { ...statusMessage[1], 'x-lark-signature': '0'.repeat(64) })).status, 401)
  await Promise.all([webhook(...createMessage), webhook(...createMessage)]).then((results) => results.forEach((result) => assert.equal(result.status, 200, result.text)))
  assert.equal((await webhook(...message('e2e-approve', `审批 ${historyTaskId}`))).status, 200)
  const inbox = async (cookie) => call(`/api/inbound?projectId=${inboxProject}`, { cookie })
  let replyHistory
  for (let attempt = 0; attempt < 40; attempt += 1) {
    replyHistory = await call('/api/delivery', { cookie: owner })
    if (replyHistory.json.deliveries.some((item) => item.event === 'inbound-reply' && item.status === 'sent')) break
    await wait(100)
  }
  const delivered = replyHistory.json.deliveries.filter((item) => item.event === 'inbound-reply')
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].status, 'sent', JSON.stringify(delivered))
  for (const value of ['e2e-app-secret', 'fixture-tenant-token', 'om_e2e_status', '当前任务状态']) assert.ok(!replyHistory.text.includes(value))
  const inboundEvents = await inbox(owner)
  assert.equal(inboundEvents.json.events.length, 3)
  assert.equal(inboundEvents.json.events.find((event) => event.intent === 'status').taskStatus, 'approved')
  const draft = inboundEvents.json.events.find((event) => event.intent === 'create')
  assert.equal(draft.status, 'awaiting-owner')
  assert.equal(draft.taskId, undefined)
  assert.equal((await call(`/api/inbound/requests/${draft.id}`, { method: 'POST', cookie: owner, body: { decision: 'accept', sourceTaskId: 'missing' } })).status, 400)
  const afterWrite = await call('/api/workflow', { cookie: ownerOther, headers: { 'if-none-match': initialTag } })
  assert.equal(afterWrite.status, 200)
  assert.notEqual(afterWrite.headers.etag, initialTag)
  assert.ok(afterWrite.json.projects.some(({ id }) => id === project.id))
  const initialProviders = await call('/api/providers', { cookie: owner })
  assert.equal(initialProviders.status, 200)
  const initialDeepSeekUrl = new URL(initialProviders.json.providers.DeepSeek.baseUrl)
  assert.equal(initialDeepSeekUrl.protocol, 'https:')
  assert.equal(initialDeepSeekUrl.pathname, '/')
  const invite = await call('/api/members', { method: 'POST', cookie: owner, body: { name: 'Observer', projectIds: [project.id], enabled: true } })
  assert.equal(invite.status, 201, invite.text)
  const viewer = await login(invite.json.accessKey, invite.json.member.id)
  const historyInvite = await call('/api/members', { method: 'POST', cookie: owner, body: { name: 'History observer', projectIds: ['history-project', 'delivery-noise'], enabled: true } })
  assert.equal(historyInvite.status, 201)
  const historyViewer = await login(historyInvite.json.accessKey, historyInvite.json.member.id)
  const historyUrl = '/api/member/history?kind=threads&projectId=history-project'
  const firstMemberPage = await call(historyUrl, { cookie: historyViewer })
  assert.equal(firstMemberPage.status, 200)
  assert.equal(firstMemberPage.json.items.length, 40)
  assert.ok(!firstMemberPage.text.includes(historyThreadId) && !firstMemberPage.text.includes(fixtureOutput))
  const secondMemberPage = await call(`${historyUrl}&after=${firstMemberPage.json.next}`, { cookie: historyViewer })
  assert.equal(secondMemberPage.json.items.length, fixtureCount - 40)
  assert.equal(secondMemberPage.json.items.at(-1).id, historyThreadId)
  assert.equal(secondMemberPage.json.next, null)
  const historicMemberRuns = await call('/api/member/history?kind=runs&projectId=history-project', { cookie: historyViewer })
  assert.equal(historicMemberRuns.json.items.length, 40)
  assert.doesNotMatch(historicMemberRuns.text, /output|events|agentName|provider/)
  const historicMemberDelivery = await call('/api/member/history?kind=deliveries&projectId=history-project', { cookie: historyViewer })
  assert.ok(historicMemberDelivery.json.items.some(({ id }) => id === 'historic-delivery-failure'))
  assert.doesNotMatch(historicMemberDelivery.text, /noise-[0-9]|Historic delivery error detail/)
  const badCursor = (id) => call(`/api/member/history?kind=deliveries&projectId=history-project&after=${id}`, { cookie: historyViewer })
  const otherCursor = await badCursor('noise-100')
  const noCursor = await badCursor('fixture-missing')
  assert.equal(otherCursor.status, 400)
  assert.equal(noCursor.status, 400)
  assert.equal(otherCursor.text, noCursor.text)
  const memberValidator = { 'if-none-match': firstMemberPage.headers.etag }
  assert.equal((await call(historyUrl, { headers: memberValidator })).status, 401)
  assert.equal((await call(historyUrl, { cookie: viewer, headers: memberValidator })).status, 404)
  await register(owner, 'member-hidden-revision')
  const unchangedMemberPage = await call(historyUrl, { cookie: historyViewer, headers: memberValidator })
  assert.equal(unchangedMemberPage.status, 304)
  assert.equal(unchangedMemberPage.text, '')
  assert.equal(unchangedMemberPage.headers['cache-control'], 'no-store')
  console.log('PASS: member history is paged and isolated by project, private changes preserve the validator, and unauthorized cursors reveal nothing.')
  assert.equal((await inbox(viewer)).status, 403)
  assert.equal((await call(`/api/inbound/requests/${draft.id}`, { method: 'POST', cookie: viewer, body: { decision: 'dismiss' } })).status, 403)
  assert.equal((await call('/api/workflow', { cookie: viewer, headers: { 'if-none-match': afterWrite.headers.etag } })).status, 403)
  const home = await call('/api/workbench', { cookie: owner })
  assert.equal(home.status, 200)
  assert.equal(home.json.tasks.length, 40)
  assert.equal(home.json.threadCount, fixtureCount)
  assert.ok(!home.text.includes(fixtureOutput) && !home.json.tasks.some(({ id }) => id === historyTaskId))
  assert.equal((await call('/api/workbench', { cookie: ownerOther, headers: { 'if-none-match': home.headers.etag } })).status, 304)
  for (const path of ['/api/workbench', '/api/workbench/tasks', '/api/workbench/threads', `/api/workbench/tasks/${historyTaskId}`]) {
    assert.equal((await call(path, { headers: { 'if-none-match': home.headers.etag } })).status, 401)
    assert.equal((await call(path, { cookie: viewer, headers: { 'if-none-match': home.headers.etag } })).status, 403)
  }
  for (const path of ['/api/workbench/tasks', '/api/workbench/threads']) {
    const firstPage = (await call(path, { cookie: owner })).json
    const secondPage = (await call(`${path}?after=${firstPage.next}`, { cookie: owner })).json
    assert.equal(firstPage.items.length, 40)
    assert.equal(secondPage.next, null)
    assert.equal(new Set([...firstPage.items, ...secondPage.items].map(({ id }) => id)).size, fixtureCount)
    assert.equal(secondPage.items.at(-1).title, oldestTitle)
  }
  const search = await call('/api/workbench/tasks?q=search+beyond+preview+00&stage=approved&sources=1', { cookie: owner })
  assert.deepEqual(search.json.items.map(({ id }) => id), [historyTaskId])
  assert.ok(!search.text.includes('search beyond preview'))
  const detail = await call(`/api/workbench/tasks/${historyTaskId}`, { cookie: owner })
  assert.equal(detail.json.runs[0].output, fixtureOutput)
  assert.equal(detail.json.review.summary, 'Historic QA evidence')
  assert.ok(detail.json.task.agents.ceo)
  const runDetailPath = `/api/workbench/runs/${detail.json.runs[0].id}`
  assert.equal((await call(runDetailPath)).status, 401)
  assert.equal((await call(runDetailPath, { cookie: viewer })).status, 403)
  const runDetail = await call(runDetailPath, { cookie: owner })
  assert.equal(runDetail.json.run.output, fixtureOutput)
  assert.equal(runDetail.json.run.taskId, historyTaskId)
  assert.equal(runDetail.json.project.id, 'history-project')
  assert.equal((await call('/api/workbench/runs/missing', { cookie: owner })).status, 404)
  assert.equal((await call(`/api/threads/${historyThreadId}`, { cookie: owner })).json.messages[0].content, 'Stored message 00')
  const schedule = await call('/api/schedules', { method: 'POST', cookie: owner, body: { sourceTaskId: historyTaskId, recurrence: { kind: 'daily', time: '09:00', timezone: 'UTC' }, enabled: false } })
  assert.equal(schedule.status, 201, schedule.text)
  assert.equal(schedule.json.schedule.sourceTaskTitle, oldestTitle)
  const unsafeProvider = await call('/api/providers/DeepSeek/test', { method: 'POST', cookie: owner, body: { baseUrl: 'http://127.0.0.1:1/v1', model: 'mock-model' } })
  assert.equal(unsafeProvider.status, 403)
  assert.equal((await call('/api/providers/DeepSeek', { method: 'PUT', cookie: owner, body: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'local-test-key' } })).status, 200)
  const linkTarget = `/api/delivery/${project.id}`
  const deepSeekCatalog = await call('/api/executors', { cookie: owner })
  assert.equal(deepSeekCatalog.json.executors.find(({ id }) => id === 'deepseek-api').defaultModel, 'deepseek-flash')
  const testDeepSeek = (model, apiKey) => call('/api/providers/DeepSeek/test', { method: 'POST', cookie: owner, body: { model, apiKey } })
  const connection = await testDeepSeek('deepseek-flash')
  assert.equal(connection.status, 200, connection.text)
  assert.match(connection.json.message, /已收到模型文本/)
  assert.doesNotMatch(connection.text, /private mock output/)
  const empty = await testDeepSeek('probe-empty')
  assert.equal(empty.status, 502)
  assert.match(empty.json.error, /空结果/)
  const deniedKey = 'temporary-fixture-key'
  const deniedTest = await testDeepSeek('probe-denied', deniedKey)
  assert.equal(deniedTest.status, 502)
  assert.match(deniedTest.json.error, /已隐藏/)
  assert.ok(!deniedTest.text.includes(deniedKey))
  assert.equal((await testDeepSeek('deepseek-flash')).status, 200, 'The saved credential must still work after a temporary test.')
  console.log('PASS: the DeepSeek connection test shares the task transport and rejects HTTP success without final text.')
  const beforeLink = await call(`/api/delivery?projectId=${project.id}`, { cookie: owner })
  assert.equal(beforeLink.json.targets[0].includeTaskLink, false)
  const linkConfig = await call(linkTarget, { method: 'PUT', cookie: owner, body: { webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-task-link-token', events: ['approved'], includeTaskLink: true } })
  assert.equal(linkConfig.status, 200)
  assert.equal(linkConfig.json.target.includeTaskLink, true)
  const body = { title: 'scheduler timeout fixture HTTPS', projectId: project.id, agents: mockAgents }
  const headers = { 'idempotency-key': randomUUID() }
  const submit = (cookie, payload = body) => call('/api/workflow/start', { method: 'POST', cookie, body: payload, headers })
  assert.equal((await submit(viewer)).status, 403)
  assert.equal((await call('/api/workflow/start', { method: 'POST', cookie: owner, body })).status, 400)
  const [first, duplicate] = await Promise.all([submit(owner), submit(ownerOther)])
  assert.equal(first.status, 202, first.text)
  const liveHome = await call('/api/workbench', { cookie: ownerOther, headers: { 'if-none-match': home.headers.etag } })
  assert.equal(liveHome.status, 200)
  assert.ok(liveHome.json.activeRuns.some(({ id }) => id === first.json.run.id))
  assert.ok(liveHome.json.activeRuns.every((run) => !('events' in run) && !('output' in run)))
  assert.equal(duplicate.json.task.id, first.json.task.id)
  assert.equal((await submit(ownerOther, { ...body, title: 'not the same submission' })).status, 409)
  const streamPath = `/api/runs/${first.json.run.id}/events`
  assert.equal((await call(streamPath, { sse: true })).status, 401)
  const earlier = await observe(streamPath, owner, (text) => /^id: /m.test(text))
  const cursor = /^id: ([\w-]+)$/m.exec(earlier)[1]
  const snapshot = await observe(streamPath, viewer, (text) => text.includes('run.snapshot'))
  assert.ok(snapshot.includes(first.json.run.id) && !snapshot.includes('output') && !snapshot.includes('events'))
  const resumed = await observe(streamPath, ownerOther, (text) => text.includes('handoff.created'), { 'last-event-id': cursor })
  assert.ok(resumed.includes('run.snapshot') && !resumed.includes(`id: ${cursor}\n`), resumed)
  const compact = await observe(`${streamPath}?view=summary`, ownerOther, (text) => text.includes('handoff.created') && text.includes('"nextRun"'), { 'last-event-id': cursor })
  assert.match(compact, /"agentId":"frontend"/)
  assert.doesNotMatch(compact, /"(?:output|events|execution|plan)":/)
  assert.ok(!compact.includes(`id: ${cursor}\n`))
  const allowed = await call('/api/member/workspace', { cookie: viewer })
  assert.deepEqual(allowed.json.projects.map(({ id }) => id), [project.id])
  assert.ok(!allowed.text.includes(privateProject.id))
  assert.doesNotMatch(allowed.text, /deliveryAlerts|Historic delivery error detail|HTTP 503|test-ambiguous-token/)
  assert.equal((await call('/api/workbench', { cookie: viewer, headers: { 'if-none-match': afterDelivery.headers.etag } })).status, 403)
  assert.equal((await call(`/api/delivery?projectId=${project.id}`, { cookie: viewer })).status, 403)
  assert.equal((await call(`/api/delivery?projectId=${privateProject.id}`, { cookie: viewer })).status, 403)
  console.log('PASS: delivery alerts separate explicit failures and unknown outcomes, resist cross-project history crowd-out, and keep details owner-only.')
  let pendingLinkTask
  for (let n = 0; n < 80; n += 1) {
    const state = await call('/api/workflow', { cookie: owner })
    const task = state.json.tasks.find(({ id }) => id === first.json.task.id)
    if (task.status === 'awaiting-approval') { pendingLinkTask = task; break }
    assert.ok(!['failed', 'needs-fix', 'cancelled'].includes(task.status) && n < 79, JSON.stringify(state.json.runs.map(({ phase, error }) => ({ phase, error }))))
    await wait(100)
  }
  assert.ok(pendingLinkTask?.reviewId)
  const decisionPath = `/api/workflow/${first.json.task.id}/decision`
  const approve = { method: 'POST', body: { reviewId: pendingLinkTask.reviewId, decision: 'approve' } }
  assert.equal((await call(`/api/member/tasks/${first.json.task.id}`, { cookie: viewer })).json.status, 'awaiting-approval')
  assert.ok(!(await call(`/api/delivery?projectId=${project.id}`, { cookie: owner })).json.deliveries.some((item) => item.taskId === first.json.task.id))
  assert.equal((await call(decisionPath, approve)).status, 401)
  assert.equal((await call(decisionPath, { ...approve, cookie: viewer })).status, 403)
  const approvals = await Promise.all([1, 2].map(() => call(decisionPath, { ...approve, cookie: owner })))
  for (const approval of approvals) assert.equal(approval.status, 200, approval.text)
  assert.deepEqual(approvals[0].json.review.decision, approvals[1].json.review.decision)
  let linkedDelivery
  for (let n = 0; n < 80; n += 1) {
    const response = await call(`/api/delivery?projectId=${project.id}`, { cookie: owner })
    linkedDelivery = response.json.deliveries.find((item) => item.taskId === first.json.task.id)
    if (linkedDelivery?.status === 'sent') break
    assert.ok(!['failed', 'unknown', 'cancelled'].includes(linkedDelivery?.status), JSON.stringify(linkedDelivery))
    await wait(100)
  }
  assert.equal(linkedDelivery?.status, 'sent')
  assert.equal((await call(`/api/delivery?projectId=${project.id}`, { cookie: owner })).json.deliveries.filter((item) => item.taskId === first.json.task.id && item.event === 'approved').length, 1)
  const receivedTaskLink = (await readFile(join(directory, 'data', 'mock-task-links.log'), 'utf8')).trim()
  assert.equal(receivedTaskLink, `${origin}/#task=${first.json.task.id}`)
  const memberTaskPath = `/api/member/tasks/${first.json.task.id}`
  const memberTask = await call(memberTaskPath, { cookie: viewer })
  assert.equal(memberTask.status, 200)
  assert.deepEqual(Object.keys(memberTask.json).sort(), ['id', 'projectId', 'projectName', 'status', 'threadTitle', 'updatedAt'])
  assert.equal(memberTask.json.projectId, project.id)
  assert.equal(memberTask.json.status, 'approved')
  assert.equal((await call(memberTaskPath)).status, 401)
  assert.equal((await call(`/api/workbench/tasks/${first.json.task.id}`, { cookie: viewer })).status, 403)
  const hiddenTask = await call(`/api/member/tasks/${historyTaskId}`, { cookie: viewer })
  const missingTask = await call('/api/member/tasks/task-missing', { cookie: viewer })
  assert.equal(hiddenTask.status, 404)
  assert.equal(missingTask.status, 404)
  assert.equal(hiddenTask.text, missingTask.text)
  const followupId = randomUUID()
  const followup = (cookie) => call(`/api/threads/${first.json.thread.id}/followups`, { method: 'POST', cookie, headers: { 'idempotency-key': followupId }, body: { message: 'scheduler timeout fixture HTTPS follow-up' } })
  const next = await followup(ownerOther)
  assert.equal(next.status, 202, next.text)
  assert.equal((await followup(ownerOther)).json.task.id, next.json.task.id)
  await observe(`/api/runs/${next.json.run.id}/events`, ownerOther, (text) => text.includes('provider.requested'))
  await stop(api)
  api = await launch()
  assert.equal((await submit(owner)).status, 401)
  const afterRestart = await login(ownerKey)
  assert.equal((await call(historyUrl, { cookie: historyViewer, headers: memberValidator })).status, 401)
  const restoredUnknown = (await call(`/api/delivery?projectId=${project.id}`, { cookie: afterRestart })).json.deliveries.find(({ id }) => id === unknownDelivery.id)
  assert.equal(restoredUnknown.status, 'unknown')
  assert.equal(restoredUnknown.attempts, 1)
  assert.equal((await webhook(...message('e2e-status', `状态 ${historyTaskId}`))).status, 200)
  assert.equal((await inbox(afterRestart)).json.events.length, 3)
  const approval = (await inbox(afterRestart)).json.events.find((event) => event.intent === 'approve')
  const acknowledge = await call(`/api/inbound/requests/${approval.id}`, { method: 'POST', cookie: afterRestart, body: { decision: 'accept' } })
  assert.equal(acknowledge.json.event.status, 'acknowledged')
  assert.equal((await call(`/api/workbench/tasks/${historyTaskId}`, { cookie: afterRestart })).json.task.status, 'approved')
  const restartedSnapshot = await call('/api/workflow', { cookie: afterRestart, headers: { 'if-none-match': afterWrite.headers.etag } })
  assert.equal(restartedSnapshot.status, 200)
  assert.notEqual(restartedSnapshot.headers.etag, afterWrite.headers.etag)
  assert.equal((await submit(afterRestart)).json.task.id, first.json.task.id)
  const recovered = await followup(afterRestart)
  assert.equal(recovered.json.task.id, next.json.task.id)
  assert.equal(recovered.json.run.status, 'failed')
  const state = (await call('/api/workflow', { cookie: afterRestart })).json
  assert.deepEqual(state.tasks.filter(({ id }) => !id.startsWith('history-task-')).map(({ id }) => id).sort(), [first.json.task.id, next.json.task.id].sort())
  assert.equal(state.tasks.length, fixtureCount + 2)
  const decide = (id, body, cookie = afterRestart) => call(`/api/inbound/requests/${id}`, { method: 'POST', cookie, body })
  assert.equal((await decide(draft.id, { decision: 'accept', sourceTaskId: first.json.task.id })).status, 400, 'Accepted a source task outside the project.')
  const updateProject = await call('/api/projects', { method: 'POST', cookie: afterRestart, body: { name: 'History fixtures', path: join(directory, 'historic'), accessMode: 'write' } })
  assert.equal(updateProject.status, 200, updateProject.text)
  assert.equal((await decide(draft.id, { decision: 'accept', sourceTaskId: historyTaskId })).status, 409, 'Draft survived a grant change.')
  assert.equal((await decide(draft.id, { decision: 'dismiss' })).json.event.status, 'dismissed')
  assert.equal((await webhook(...message('e2e-create-now', '任务：Review the README'))).status, 200)
  const newDraft = (await inbox(afterRestart)).json.events.find((event) => event.intent === 'create' && event.status === 'awaiting-owner')
  const decision = await decide(newDraft.id, { decision: 'accept', sourceTaskId: historyTaskId })
  assert.equal(decision.status, 200, decision.text)
  assert.equal(decision.json.event.status, 'accepted')
  assert.ok(decision.json.event.taskId)
  assert.equal((await decide(newDraft.id, { decision: 'accept', sourceTaskId: historyTaskId })).status, 409)
  assert.equal((await webhook(...message('e2e-cross-project', `状态 ${first.json.task.id}`))).status, 404)
  assert.equal((await webhook(...message('e2e-reply', `回复 ${historyThreadId}：请检查 README`))).status, 200)
  const reply = (await inbox(afterRestart)).json.events.find((event) => event.intent === 'reply')
  const replyDecision = await decide(reply.id, { decision: 'accept' })
  assert.equal(replyDecision.status, 200, replyDecision.text)
  assert.equal(replyDecision.json.event.threadId, historyThreadId)
  assert.equal(state.runs.filter(({ taskId }) => taskId === next.json.task.id).length, 1, 'Interrupted follow-up was replayed.')

  const analysisDir = join(directory, 'deepseek-analysis')
  const readme = 'READONLY_ANALYSIS_FIXTURE\n'
  await mkdir(analysisDir)
  await writeFile(join(analysisDir, 'README.md'), readme)
  const registered = await call('/api/projects', { method: 'POST', cookie: afterRestart, body: { path: analysisDir, accessMode: 'read-only' } })
  assert.equal(registered.status, 200, registered.text)
  const analysis = await call('/api/workflow/start', { method: 'POST', cookie: afterRestart, headers: { 'idempotency-key': randomUUID() }, body: { title: 'DeepSeek read-only fixture', brief: 'Summarize README without modifying it.', projectId: registered.json.project.id, agents: mockAgents } })
  assert.equal(analysis.status, 202, analysis.text)
  let analysisDetail
  for (let attempt = 0; attempt < 100; attempt += 1) {
    analysisDetail = await call(`/api/workbench/tasks/${analysis.json.task.id}`, { cookie: afterRestart })
    assert.equal(analysisDetail.status, 200, analysisDetail.text)
    if (['awaiting-approval', 'approved', 'failed', 'needs-fix', 'cancelled'].includes(analysisDetail.json.task.status)) break
    await wait(100)
  }
  assert.equal(analysisDetail.json.task.status, 'awaiting-approval', JSON.stringify(analysisDetail.json.runs.map(({ phase, status, error }) => ({ phase, status, error }))))
  assert.ok(analysisDetail.json.runs.some((run) => run.phase === 'specialist-execute' && run.executor === 'deepseek-api' && run.status === 'completed' && run.output.includes('READONLY_ANALYSIS_FIXTURE')))
  assert.deepEqual(analysisDetail.json.task.execution.writtenFiles, [])
  assert.deepEqual(analysisDetail.json.task.execution.commandResults, [])
  assert.equal(await readFile(join(analysisDir, 'README.md'), 'utf8'), readme)
  assert.deepEqual(await readdir(analysisDir), ['README.md'])
  console.log('PASS: the DeepSeek API specialist completes read-only project analysis with snapshot evidence and no side effects.')

  const probeMember = await call('/api/members', { method: 'POST', cookie: afterRestart, body: { name: 'Pilot probe viewer', projectIds: [project.id], enabled: true } })
  assert.equal(probeMember.status, 201, probeMember.text)
  const { member: pilotViewer, accessKey: pilotViewerKey } = probeMember.json
  const fixturePath = join(directory, 'member-probe.json')
  const fixture = { memberId: pilotViewer.id, projectId: project.id, threadId: first.json.thread.id, taskId: first.json.task.id,
    excludedProjectId: registered.json.project.id, excludedRunId: analysis.json.run.id, certificateFingerprint256: probeReport.certificateFingerprint256 }
  const runMemberProbe = (mode) => {
    const command = exec(process.execPath, ['scripts/pilot-probe.mjs', origin, caFile, '--member', fixturePath, ...(mode ? [mode] : [])], probeOptions)
    command.child.stdin.on('error', () => {})
    command.child.stdin.end(`${pilotViewerKey}\n`)
    return command
  }
  await writeFile(fixturePath, JSON.stringify({ ...fixture, certificateFingerprint256: '00:'.repeat(31) + '00' }))
  await assert.rejects(runMemberProbe(), (error) => error.code === 1 && /certificate fingerprint does not match/i.test(error.stderr) && !error.stderr.includes(pilotViewerKey))
  await writeFile(fixturePath, JSON.stringify({ ...fixture, taskId: 'missing-test-task' }))
  await assert.rejects(runMemberProbe(), (error) => error.code === 1 && /expected thread and task run not visible/i.test(error.stderr) && !error.stderr.includes(pilotViewerKey))
  await writeFile(fixturePath, JSON.stringify({ ...fixture, taskId: historyTaskId }))
  await assert.rejects(runMemberProbe('--measure-history'), (error) => error.code === 1 && error.stdout === '' &&
    /expected task is not visible/i.test(error.stderr) && !error.stderr.includes(pilotViewerKey))
  await writeFile(fixturePath, JSON.stringify(fixture))
  const measured = await runMemberProbe('--measure-history')
  const measurementReport = JSON.parse(measured.stdout)
  const refreshedViewer = await login(invite.json.accessKey, invite.json.member.id)
  const expectedHistory = await call(`/api/member/history?kind=threads&projectId=${project.id}`, { cookie: refreshedViewer })
  assert.equal(expectedHistory.status, 200)
  assert.equal((await call('/api/auth/logout', { method: 'POST', cookie: refreshedViewer })).status, 200)
  assert.equal(measurementReport.scope, 'member-history-measurement')
  assert.equal(measurementReport.certificateFingerprint256, probeReport.certificateFingerprint256)
  const { initial, conditional, ...measuredScope } = measurementReport.measurement
  assert.deepEqual(measuredScope, {
    projectId: project.id, taskId: first.json.task.id, excludedHistoryStatus: 404, transport: 'fresh-tls-per-request',
  })
  assert.equal(initial.items, expectedHistory.json.items.length)
  assert.equal(initial.bodyBytes, Buffer.byteLength(expectedHistory.text))
  assert.ok(Number.isFinite(initial.elapsedMs) && initial.elapsedMs > 0)
  assert.equal(conditional.rounds, 3)
  assert.equal(conditional.parallel, 4)
  assert.equal(conditional.notModified, 12)
  assert.equal(conditional.bodyBytes, 0)
  assert.ok(Number.isFinite(conditional.maxMs) && conditional.maxMs >= conditional.medianMs && conditional.medianMs > 0)
  assert.doesNotMatch(measured.stdout, /W\/.*member-/)
  for (const hidden of [pilotViewerKey, '__Host-zhidian_session', 'Historical fixture', body.title]) {
    assert.ok(!`${measured.stdout}${measured.stderr}`.includes(hidden), 'Measurement disclosed fixture content or credentials.')
  }
  console.log('PASS: the HTTPS member history probe measures the authorized page and twelve empty conditional responses without exposing payloads or credentials.')

  const watched = runMemberProbe('--watch-revocation')
  const ready = new Promise((resolve) => {
    let diagnostics = ''
    watched.child.stderr.setEncoding('utf8').on('data', (text) => {
      diagnostics += text
      if (diagnostics.includes('Disable this dedicated test member')) resolve()
    })
  })
  try {
    await Promise.race([ready, watched.then(() => { throw new Error('Member probe exited before waiting for revocation.') }), wait(8_000, undefined, { ref: false }).then(() => { throw new Error('Member probe did not reach the revocation check.') })])
    const disabled = await call(`/api/members/${pilotViewer.id}`, { method: 'PUT', cookie: afterRestart, body: { name: pilotViewer.name, projectIds: pilotViewer.projectIds, enabled: false } })
    assert.equal(disabled.status, 200, disabled.text)
    const result = await watched
    assert.ok(!`${result.stdout}${result.stderr}`.includes(pilotViewerKey) && !result.stdout.includes('__Host-zhidian_session'))
    const report = JSON.parse(result.stdout)
    assert.equal(report.scope, 'member-view-and-policy')
    assert.equal(report.certificateFingerprint256, probeReport.certificateFingerprint256)
    assert.equal(report.member.projectId, project.id)
    assert.equal(report.member.threadId, first.json.thread.id)
    assert.equal(report.member.taskId, first.json.task.id)
    assert.equal(report.member.ownerWorkbenchStatus, 403)
    assert.equal(report.member.excludedRunStatus, 404)
    assert.equal(report.member.oldSessionStatus, 401)
  } finally {
    if (watched.child.exitCode === null) watched.child.kill()
    await watched.catch(() => {})
  }
  console.log('PASS: member probe verifies the authorized task/thread, excludes another project, and observes HTTP 401 on a disabled member’s existing session.')

  if (process.env.ZHIDIAN_TEST_PLAYWRIGHT) {
    const submissionProject = join(directory, 'browser-submission')
    const splitProject = join(directory, 'browser-split-other-project')
    await mkdir(submissionProject)
    await mkdir(splitProject)
    async function publish() {
      const sharedTitle = 'shared task after viewer disconnect'
      const privateTitle = 'private task after viewer disconnect'
      const animatedTitle = 'scheduler timeout fixture office animation'
      const send = (title, projectId) => call('/api/workflow/start', { method: 'POST', body: { ...body, title, projectId }, cookie: afterRestart, headers: { 'idempotency-key': randomUUID() } })
      const animated = await send(animatedTitle, project.id)
      const shared = await send(sharedTitle, project.id)
      const privateResult = await send(privateTitle, privateProject.id)
      assert.equal(animated.status, 202, animated.text)
      assert.equal(shared.status, 202, shared.text)
      assert.equal(privateResult.status, 202, privateResult.text)
      return { sharedTitle, privateTitle, animatedTitle }
    }
    await browserSmoke(invite.json, {
      publish, otherProjectTitle: body.title, submissionProject, splitProject, receivedTaskLink, historyMember: historyInvite.json,
      createApprovalTask: async (title) => {
        const result = await call('/api/workflow/start', { method: 'POST', cookie: afterRestart, headers: { 'idempotency-key': randomUUID() }, body: { ...body, title, projectId: privateProject.id } })
        assert.equal(result.status, 202, result.text)
      },
      apiSubmit: (path, rawBody, key) => call(path, { method: 'POST', cookie: afterRestart, rawBody, headers: { 'idempotency-key': key } }),
      receiveDraft: async () => {
        const title = 'Browser inbox review fixture'
        const result = await webhook(...message('e2e-browser-create', `任务：${title}\n只读检查 README 文件。`))
        assert.equal(result.status, 200, result.text)
        return title
      },
      verifyTask: async (id, title) => {
        const detail = await call(`/api/workbench/tasks/${id}`, { cookie: afterRestart })
        assert.equal(detail.status, 200, detail.text)
        assert.equal(detail.json.task.title, title)
        assert.equal(detail.json.summary.projectId, inboxProject)
      },
      revokeMember: async () => {
        const { id, name, projectIds } = invite.json.member
        const result = await call(`/api/members/${id}`, { method: 'PUT', cookie: afterRestart, body: { name, projectIds, enabled: false } })
        assert.equal(result.status, 200, result.text)
        assert.equal(result.json.member.enabled, false)
      },
    })
  }
  assert.equal((await call(inboundPath, { method: 'DELETE', cookie: afterRestart })).status, 200)
  assert.equal((await webhook(...statusMessage)).status, 404)
  console.log('PASS: callback-only gateway preserves signed bytes over verified upstream TLS, strips forwarded headers, and rejects unrelated routes, oversized requests and untrusted upstreams.')
  console.log('PASS: mock callback challenge and signature, project isolation, durable deduplication, owner decision, thread follow-up and revocation.')

  const auditPath = join(directory, 'data', 'audit.jsonl')
  const auditText = await readFile(auditPath, 'utf8')
  const events = auditText.trim().split('\n').map(JSON.parse)
  const workflowResult = events.find((event) => event.action === 'workflow.submit' && event.phase === 'result' && event.status === 202 && event.resourceId === first.json.task.id)
  assert.ok(workflowResult && events.some((event) => event.requestId === workflowResult.requestId && event.phase === 'attempt' && event.role === 'owner'))
  assert.ok(events.some((event) => event.action === 'workflow.submit' && event.status === 403 && event.role === 'viewer' && event.memberId === invite.json.member.id))
  assert.ok(events.some((event) => event.action === 'workflow.submit' && event.status === 401 && event.role === 'anonymous'))
  assert.ok(events.some((event) => event.action === 'membership.create' && event.resourceId === invite.json.member.id && event.status === 201))
  assert.ok(events.some((event) => event.action === 'provider.configure' && event.resourceId === 'DeepSeek' && event.status === 200))
  assert.ok(events.some((event) => event.action === 'inbound.receive' && event.role === 'integration' && event.phase === 'result' && event.status === 200))
  assert.ok(events.some((event) => event.action === 'inbound.decide' && event.role === 'owner' && event.phase === 'result' && event.status === 200))
  for (const value of [ownerKey, invite.json.accessKey, owner, 'local-test-key', headers['idempotency-key'], body.title, 'http://127.0.0.1:1/v1', inboundToken, inboundKey, 'e2e-app-secret', 'Review the README', 'om_e2e_status']) assert.ok(!auditText.includes(value), 'Audit disclosed a credential or request content.')
  const exportResult = await exec(process.execPath, ['scripts/pilot-audit.mjs', join(directory, 'data')], probeOptions)
  const exported = exportResult.stdout.trim().split('\n').map(JSON.parse)
  const matching = exported.filter((event) => event.requestId === workflowResult.requestId)
  assert.deepEqual(matching.map(({ phase }) => phase), ['attempt', 'result'])
  assert.equal(matching.at(-1).resourceId, first.json.task.id)
  assert.deepEqual(exported, events, 'Audit export did not preserve the retained audit events.')
  assert.equal(await readFile(auditPath, 'utf8'), auditText, 'Audit export modified the running instance log.')

  const collector = join(directory, 'audit-collector')
  await mkdir(collector, { mode: 0o700 })
  const snapshotPath = join(collector, 'snapshot.jsonl')
  const archivePath = join(collector, 'archive.sqlite')
  const instance = 'https-pilot'
  await writeFile(snapshotPath, exportResult.stdout, { mode: 0o600 })
  const archive = async (mode, value) => {
    const { stdout } = await exec(process.execPath, ['scripts/pilot-audit-archive.mjs', mode, archivePath, instance, value], probeOptions)
    return JSON.parse(stdout)
  }
  assert.deepEqual(await archive('ingest', snapshotPath), { ok: true, instance, received: exported.length, inserted: exported.length, duplicates: 0 })
  const archived = await archive('find', workflowResult.requestId)
  assert.deepEqual(archived.events, matching)
  assert.equal(archived.events[1].status, 202)
  assert.equal(archived.events[1].resourceId, first.json.task.id)
  assert.deepEqual(await archive('ingest', snapshotPath), { ok: true, instance, received: exported.length, inserted: 0, duplicates: exported.length })
  assert.equal(await readFile(auditPath, 'utf8'), auditText, 'Archive import modified the running instance log.')
  console.log('PASS: a separate audit archive ingests and deduplicates a live snapshot and correlates the task submission with its HTTP 202 result.')

  await rename(auditPath, join(directory, 'data', 'audit-failure-fixture.jsonl'))
  await mkdir(auditPath)
  const rejected = await call('/api/providers/DeepSeek', { method: 'DELETE', cookie: afterRestart })
  assert.equal(rejected.status, 503)
  assert.equal((await call('/api/providers', { cookie: afterRestart })).json.providers.DeepSeek.hasApiKey, true, 'Mutation committed despite the audit error.')
  assert.equal((await call('/api/health')).status, 503)
  assert.equal((await call('/api/auth/logout', { method: 'POST', cookie: afterRestart })).status, 200)
  await stop(api)
  await assert.rejects(preflight(), (error) => error.code === 1 && /Audit path must be a private regular file/.test(error.stderr))
  await rmdir(auditPath)
  await rename(join(directory, 'data', 'audit-failure-fixture.jsonl'), auditPath)
  await assert.rejects(preflight({ ZHIDIAN_HTTPS_ORIGIN: undefined }), (error) => error.code === 1 && /requires ZHIDIAN_HTTPS_ORIGIN/.test(error.stderr))
  await assert.rejects(preflight({ ZHIDIAN_HTTPS_ORIGIN: `https://localhost:${relay.address().port}` }), (error) => error.code === 1 && /certificate SAN does not match/.test(error.stderr))
  await assert.rejects(preflight({}, ['--rotate-credentials']), (error) => error.code === 1 && /cannot be combined with credential rotation/.test(error.stderr))
  const persistentNames = ['workflow.sqlite', 'workflow.sqlite-wal', 'providers.json', 'audit.jsonl', 'audit.previous.jsonl']
  const fingerprints = () => Promise.all(persistentNames.map(async (name) => {
    try { return createHash('sha256').update(await readFile(join(directory, 'data', name))).digest('hex') }
    catch (error) { if (error.code === 'ENOENT') return null; throw error }
  }))
  const before = await fingerprints()
  const check = await preflight()
  const report = JSON.parse(check.stdout)
  assert.equal(report.mode, 'check-pilot')
  assert.equal(report.storage, 'sqlite')
  assert.equal(report.counts.members, 3)
  assert.equal(report.credentials.providerKeys, 1)
  assert.equal(report.pilot.listener.host, '127.0.0.1')
  assert.equal(report.pilot.certificateFingerprint256, probeReport.certificateFingerprint256)
  assert.ok(report.pilot.auditFiles.activeBytes > 0 && report.pilot.notVerified.includes('host-egress'))
  assert.deepEqual(await fingerprints(), before, 'Pilot preflight changed persistent bytes.')
  for (const secret of [ownerKey, ownerHash, invite.json.accessKey, historyInvite.json.accessKey, 'local-test-key', 'PRIVATE KEY']) assert.ok(!check.stdout.includes(secret))
  assert.equal(await call('/api/health').catch(() => null), null, 'Preflight started a workbench listener.')
  console.log('PASS: offline HTTPS preflight validates the stopped store, credential envelopes, TLS/build/audit configuration without writing data or starting a listener.')

  const bundle = join(directory, 'pre-upgrade-bundle')
  const rollbackDir = join(directory, 'rollback-data')
  const backup = (...args) => exec(process.execPath, ['scripts/pilot-backup.mjs', ...args], probeOptions)
  await backup('create', join(directory, 'data'), bundle)
  api = await launch()
  const candidateOwner = await login(ownerKey)
  const candidateOnly = await register(candidateOwner, 'candidate-only-project')
  assert.ok((await call('/api/workbench', { cookie: candidateOwner })).json.projects.some(({ id }) => id === candidateOnly.id))
  await stop(api)

  await backup('restore', bundle, rollbackDir)
  const restoredConfig = { ZHIDIAN_DATA_DIR: rollbackDir }
  const restoredReport = JSON.parse((await preflight(restoredConfig)).stdout)
  assert.deepEqual(restoredReport.counts, report.counts)
  assert.deepEqual(restoredReport.credentials, report.credentials)
  assert.equal(restoredReport.pilot.certificateFingerprint256, report.pilot.certificateFingerprint256)
  assert.equal(await readFile(join(rollbackDir, 'audit.jsonl'), 'utf8'), await readFile(join(bundle, 'files', 'audit.jsonl'), 'utf8'))
  api = await launch(restoredConfig, { expectFailure: false })
  assert.equal((await call('/api/workbench', { cookie: candidateOwner })).status, 401)
  const rollbackOwner = await login(ownerKey)
  const rollbackHome = await call('/api/workbench', { cookie: rollbackOwner })
  assert.ok(rollbackHome.json.projects.some(({ id }) => id === project.id) && !rollbackHome.json.projects.some(({ id }) => id === candidateOnly.id))
  assert.equal((await call(`/api/workbench/tasks/${first.json.task.id}`, { cookie: rollbackOwner })).json.task.status, 'approved')
  const rollbackMember = await login(historyInvite.json.accessKey, historyInvite.json.member.id)
  assert.equal((await call(historyUrl, { cookie: rollbackMember })).status, 200)
  assert.equal((await call(`/api/member/tasks/${first.json.task.id}`, { cookie: rollbackMember })).status, 404)
  await stop(api)
  await backup('verify', bundle)
  console.log('PASS: HTTPS rollback opens a verified pre-change copy with original tasks, grants, credentials and audit, excluding candidate-only writes.')

  console.log('PASS: audit persists redacted control-plane events across restart and blocks new mutations if audit storage fails; logout remains available.')
  console.log('PASS: unchanged authorized workflow polls are empty and private; writes and restart invalidate workflow validators without bypassing authorization.')
  console.log('PASS: compact workbench and SSE, paginated history/search, old task detail and existing schedule sources remain owner-only.')
  console.log('PASS: raw TCP relay preserves TLS and certificate trust; the probe requires a trusted CA and sees anonymous/Origin requests denied.')
  console.log('PASS: verified loopback TLS, built UI assets, required auth and Secure cookies, origin/host guards, outbound policy, isolated sessions, SSE cursor reconnect, and durable task/follow-up deduplication.')
} finally {
  await cleanup()
}

async function cleanup() {
  for (const socket of sockets) socket.destroy()
  await new Promise((resolve) => relay.close(resolve))
  await Promise.all(children.map(stop))
  const resolved = await realpath(directory)
  if (dirname(resolved) !== await realpath(tmpdir()) || !basename(resolved).startsWith('zhidian-https-e2e-')) throw new Error(`Unexpected test cleanup target: ${resolved}`)
  await rm(resolved, { recursive: true, force: true, maxRetries: 2 })
}
