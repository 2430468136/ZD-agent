import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { openSqliteWorkflow } from '../server/sqlite-workflow.mjs'
import { CURRENT_WORKFLOW_SCHEMA_VERSION } from '../server/workflow-store.mjs'

const taskCount = Number(process.argv[2] ?? 1000)
assert.ok(Number.isSafeInteger(taskCount) && taskCount >= 1 && taskCount <= 10_000, 'Task count must be an integer from 1 to 10,000.')
const sessions = 8
const rounds = 6
const commits = 20
const at = '2026-01-01T00:00:00.000Z'
const root = new URL('../', import.meta.url)
const directory = await mkdtemp(join(tmpdir(), 'zhidian-pilot-capacity-'))
const ownerKey = randomBytes(32).toString('base64url')
const ownerHash = createHash('sha256').update(ownerKey).digest('hex')
const memberKey = randomBytes(32).toString('base64url')
const memberId = 'benchmark-member'

function distribution(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  const metric = (p) => Number(sorted[Math.ceil(sorted.length * p) - 1].toFixed(2))
  return { p50Ms: metric(0.50), p95Ms: metric(0.95) }
}

function seed() {
  const data = { schemaVersion: CURRENT_WORKFLOW_SCHEMA_VERSION, projects: [{ id: 'project-bench', name: 'Benchmark', path: directory, accessMode: 'read-only' }], sessions: [], tasks: [], reviews: [], contextEntries: [], threads: [], messages: [], runs: [], schedules: [], occurrences: [], deliveryTargets: [], deliveries: [], members: [] }
  data.members.push({ id: memberId, name: 'Benchmark viewer', enabled: true, projectIds: ['project-bench'], keyHash: createHash('sha256').update(memberKey).digest('hex'), createdAt: at, updatedAt: at })
  for (let index = 0; index < taskCount; index += 1) {
    const threadId = `thread-${index}`
    const sessionId = `session-${index}`
    const taskId = `task-${index}`
    const output = `Output for task ${index}\n${'fixture-'.repeat(512)}`
    data.threads.push({ id: threadId, projectId: 'project-bench', title: `Benchmark ${index}`, status: 'completed', createdAt: at, updatedAt: at })
    data.sessions.push({ id: sessionId, projectId: 'project-bench', threadId, title: `Benchmark ${index}`, status: 'completed', createdAt: at, updatedAt: at })
    data.tasks.push({ id: taskId, sessionId, threadId, title: `Benchmark ${index}`, brief: 'Synthetic history', status: 'approved', executionMode: 'read-only', createdAt: at, updatedAt: at })
    data.messages.push({ id: `message-${index}`, threadId, taskId, role: 'user', content: 'Synthetic history', createdAt: at })
    data.runs.push({ id: `run-${index}`, taskId, sessionId, threadId, phase: 'ceo-plan', status: 'completed', agentName: 'CEO Agent', output, events: [], createdAt: at, completedAt: at })
    data.reviews.push({ id: `review-${index}`, taskId, status: 'passed', summary: 'Synthetic result' })
  }
  return data
}

async function portNumber() {
  const listener = createServer()
  return new Promise((resolve, reject) => {
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', () => {
      const port = listener.address().port
      listener.close(() => resolve(port))
    })
  })
}

let child
async function cleanup() {
  if (child && child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve) => { child.once('exit', resolve); child.kill() })
  }
  const target = await realpath(directory)
  assert.equal(dirname(target), await realpath(tmpdir()))
  assert.ok(basename(target).startsWith('zhidian-pilot-capacity-'))
  await rm(target, { recursive: true, force: true, maxRetries: 2 })
}

try {
  const store = openSqliteWorkflow(join(directory, 'workflow.sqlite'))
  const fixture = seed()
  const commitTimes = []
  try {
    store.write(fixture)
    for (let index = 0; index < commits; index += 1) {
      fixture.runs.at(-1).error = `Synthetic change ${index}`
      const start = performance.now()
      store.write(fixture)
      commitTimes.push(performance.now() - start)
    }
    assert.equal(store.read().runs.at(-1).error, `Synthetic change ${commits - 1}`)
  } finally { store.close() }

  const port = await portNumber()
  const origin = `http://127.0.0.1:${port}`
  let diagnostic = ''
  child = spawn(process.execPath, ['server.mjs'], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env: {
    ...process.env, ZHIDIAN_DATA_DIR: directory, ZHIDIAN_API_PORT: String(port), ZHIDIAN_UI_PORT: '5173', ZHIDIAN_OWNER_KEY_HASH: ownerHash,
    ZHIDIAN_STORAGE: 'sqlite', ZHIDIAN_HTTPS_ORIGIN: undefined, ZHIDIAN_CREDENTIAL_KEYRING: undefined,
  } })
  child.stderr.setEncoding('utf8').on('data', (value) => { diagnostic += value })
  const call = (path, init = {}) => fetch(`${origin}${path}`, { ...init, signal: AbortSignal.timeout(8_000), headers: { origin: 'http://127.0.0.1:5173', 'x-zhidian-client': 'web-ui', ...init.headers } })
  let ready = false
  for (let n = 0; n < 100 && child.exitCode === null; n += 1) {
    ready = (await call('/api/health').catch(() => null))?.ok
    if (ready) break
    await wait(50)
  }
  assert.ok(ready, diagnostic || 'Benchmark API did not start.')
  const cookies = []
  const memberCookies = []
  const login = async (body) => {
    const response = await call('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    assert.equal(response.status, 200)
    const cookie = response.headers.get('set-cookie').split(';', 1)[0]
    await response.arrayBuffer()
    return cookie
  }
  for (let n = 0; n < sessions; n += 1) {
    cookies.push(await login({ key: ownerKey }))
    memberCookies.push(await login({ key: memberKey, memberId }))
  }
  const payload = async (path, cookie = cookies[0]) => {
    const result = await call(path, { headers: { cookie } })
    assert.equal(result.status, 200)
    const text = await result.text()
    return { tag: result.headers.get('etag'), bytes: Buffer.byteLength(text), json: JSON.parse(text) }
  }
  const legacy = await payload('/api/workflow')
  const first = await payload('/api/workbench')
  assert.equal(first.json.tasks.length, Math.min(taskCount, 40))
  assert.equal(first.json.threadCount, taskCount)
  assert.ok(!('sessions' in first.json) && !('reviews' in first.json) && !first.json.tasks.some((task) => 'contextSnapshot' in task))
  const etag = first.tag
  const pollTimes = []
  let pollPayloadBytes = 0
  let notModified = 0
  for (let round = 0; round < rounds; round += 1) {
    await Promise.all(cookies.map(async (cookie) => {
      const start = performance.now()
      const response = await call('/api/workbench', { headers: { cookie, 'if-none-match': etag } })
      assert.equal(response.status, 304)
      if (response.status === 304) notModified += 1
      const bytes = (await response.arrayBuffer()).byteLength
      pollPayloadBytes += bytes
      pollTimes.push(performance.now() - start)
    }))
  }
  const page = await payload('/api/workbench/tasks')
  const old = await payload('/api/workbench/tasks/task-0')
  assert.equal(old.json.runs[0].output, legacy.json.runs.find((run) => run.taskId === 'task-0').output)
  const memberPath = '/api/member/history?kind=threads&projectId=project-bench'
  const legacyMember = await payload('/api/member/workspace', memberCookies[0])
  const memberFirst = await payload(memberPath, memberCookies[0])
  assert.equal(legacyMember.json.threads.length, taskCount)
  assert.equal(memberFirst.json.items.length, Math.min(taskCount, 40))
  const memberTimes = []
  let memberPollBytes = 0
  const pollMembers = () => Promise.all(memberCookies.map(async (cookie) => {
    const start = performance.now()
    const response = await call(memberPath, { headers: { cookie, 'if-none-match': memberFirst.tag } })
    assert.equal(response.status, 304)
    memberPollBytes += (await response.arrayBuffer()).byteLength
    memberTimes.push(performance.now() - start)
  }))
  for (let round = 0; round < rounds; round += 1) await pollMembers()
  const newProject = join(directory, 'revision-fixture')
  await mkdir(newProject)
  const update = await call('/api/projects', { method: 'POST', headers: { cookie: cookies[0], 'content-type': 'application/json' }, body: JSON.stringify({ path: newProject, accessMode: 'read-only' }) })
  assert.equal(update.status, 200, await update.text())
  const changedPollTimes = []
  let changedPollBytes = 0
  await Promise.all(cookies.map(async (cookie) => {
    const start = performance.now()
    const response = await call('/api/workbench', { headers: { cookie, 'if-none-match': etag } })
    assert.equal(response.status, 200)
    assert.notEqual(response.headers.get('etag'), etag)
    changedPollBytes += (await response.arrayBuffer()).byteLength
    changedPollTimes.push(performance.now() - start)
  }))
  const memberIdleTimes = distribution(memberTimes)
  await pollMembers()
  assert.equal(memberPollBytes, 0)
  console.log(JSON.stringify({ node: process.version, platform: process.platform, taskCount, rows: 2 + taskCount * 6, sessions, sqlite: { commits, ...distribution(commitTimes) },
    initial: { legacyBytes: legacy.bytes, workbenchBytes: first.bytes, taskHistoryPageBytes: page.bytes, oneTaskDetailBytes: old.bytes },
    idlePolling: { requests: rounds * sessions, notModified, pollPayloadBytes, ...distribution(pollTimes) },
    changedPolling: { requests: sessions, changedPollBytes, ...distribution(changedPollTimes) },
    memberHistory: { legacyBytes: legacyMember.bytes, pageBytes: memberFirst.bytes, idleRequests: rounds * sessions, unrelatedWriteRequests: sessions, pollPayloadBytes: memberPollBytes, ...memberIdleTimes },
  }, null, 2))
} finally { await cleanup() }
