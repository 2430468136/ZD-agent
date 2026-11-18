import { createServer } from 'node:http'
import { link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
const tempRoot = await mkdtemp(join(tmpdir(), 'zhidian-e2e-'))
const dataDir = join(tempRoot, 'data')
const projectDir = join(tempRoot, 'project')
const outsideDir = join(tempRoot, 'outside')
const apiPort = await freePort()
const providerPort = await freePort()
const apiUrl = `http://127.0.0.1:${apiPort}`
const providerUrl = `http://127.0.0.1:${providerPort}/v1`
const children = []

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close((error) => error ? reject(error) : resolvePort(address.port))
    })
  })
}

function startProcess(args, env = {}) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: 'ignore',
    windowsHide: true,
  })
  children.push(child)
  return child
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return
  child.kill()
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 3000)),
  ])
}

async function waitForHealth() {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${apiUrl}/api/health`, { headers: { origin: 'http://localhost:5173', 'x-zhidian-client': 'web-ui' } })
      if (response.ok) return
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  throw new Error('Local API failed to start within 10 seconds.')
}

async function request(path, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: { origin: 'http://localhost:5173', 'x-zhidian-client': 'web-ui', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const result = await response.json().catch(() => ({}))
  return { response, result }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function agent(name) {
  return { name, provider: 'Local', model: 'mock-model', skills: [{ name: `${name} skill`, description: 'e2e fixture' }] }
}

async function createWorkflow(title, path = projectDir, accessMode = 'execute', brief = 'Run the deterministic end-to-end fixture.') {
  const { response: projectResponse, result: projectResult } = await request('/api/projects', {
    method: 'POST',
    body: { path, accessMode, allowedCommands: ['node --version'] },
  })
  assert(projectResponse.ok, `Project registration failed: ${projectResult.error ?? projectResponse.status}`)
  const { response, result } = await request('/api/workflow/start', {
    method: 'POST',
    body: {
      projectId: projectResult.project.id,
      title,
      brief,
      agents: { ceo: agent('CEO Agent'), specialist: agent('专业 Agent'), qa: agent('测试 Agent') },
    },
  })
  assert(response.status === 202, `Workflow start failed: ${result.error ?? response.status}`)
  return result
}

async function waitForTask(taskId, expectedStatus, timeout = 20_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const { result } = await request('/api/workflow')
    const task = result.tasks?.find((item) => item.id === taskId)
    if (task && ['approved', 'failed', 'needs-fix'].includes(task.status)) {
      if (task.status !== expectedStatus) throw new Error(`Task ${taskId} finished as ${task.status}, expected ${expectedStatus}.`)
      return { task, snapshot: result }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  throw new Error(`Task ${taskId} did not finish within ${timeout}ms.`)
}

let apiProcess
try {
  await mkdir(projectDir, { recursive: true })
  await mkdir(outsideDir, { recursive: true })
  await writeFile(join(projectDir, 'README.md'), '# E2E fixture\n')
  await writeFile(join(projectDir, 'package.json'), JSON.stringify({ name: 'fixture', private: true, scripts: { lint: 'node -e "process.stdout.write(\\\'fixture-lint-ok\\\')"' } }, null, 2))
  await symlink(outsideDir, join(projectDir, 'escape-link'), 'junction')

  startProcess(['scripts/mock-provider.mjs'], { MOCK_PROVIDER_PORT: String(providerPort) })
  apiProcess = startProcess(['server.mjs'], { ZHIDIAN_API_PORT: String(apiPort), ZHIDIAN_DATA_DIR: dataDir })
  await waitForHealth()

  const { response: providerResponse, result: providerResult } = await request('/api/providers/Local', {
    method: 'PUT',
    body: { baseUrl: providerUrl },
  })
  assert(providerResponse.ok && providerResult.saved, `Could not configure mock provider: ${providerResult.error ?? providerResponse.status}`)

  const normal = await createWorkflow('正常流程与白名单命令验证')
  const eventResponse = await fetch(`${apiUrl}/api/runs/${encodeURIComponent(normal.run.id)}/events`, { headers: { origin: 'http://localhost:5173' } })
  assert(eventResponse.ok && eventResponse.headers.get('content-type')?.includes('text/event-stream'), 'Run events endpoint did not return SSE.')
  const eventReader = eventResponse.body.getReader()
  const eventChunk = await eventReader.read()
  await eventReader.cancel()
  const eventText = new TextDecoder().decode(eventChunk.value)
  assert(eventText.includes('run.snapshot'), 'SSE stream did not include its initial run snapshot.')
  const completed = await waitForTask(normal.task.id, 'approved')
  const normalTask = completed.task
  assert(normalTask.execution?.writtenFiles?.includes('agent-output.md'), 'Specialist output file was not written.')
  const command = normalTask.execution?.commandResults?.find((item) => item.command === 'node --version')
  assert(command && command.exitCode === 0 && command.stdout?.includes('v'), 'Whitelisted node --version command did not execute successfully.')
  assert((await readFile(join(projectDir, 'agent-output.md'), 'utf8')).includes('generated by mock specialist'), 'Expected specialist output was not found on disk.')
  assert(completed.snapshot.runs.some((run) => run.phase === 'ceo-plan' && run.status === 'completed'), 'CEO planning run is missing or incomplete.')
  assert(completed.snapshot.runs.some((run) => run.phase === 'specialist-execute' && run.status === 'completed'), 'Specialist execution run is missing or incomplete.')
  assert(completed.snapshot.runs.some((run) => run.phase === 'qa-review' && run.status === 'completed'), 'Independent QA run is missing or incomplete.')
  assert(completed.snapshot.reviews.some((review) => review.taskId === normal.task.id && review.status === 'passed'), 'QA review record was not persisted as passed.')
  console.log('PASS: CEO → specialist → QA; persisted records; SSE; allowed command executed.')

  const blockedCommandDir = join(tempRoot, 'blocked-command')
  await mkdir(blockedCommandDir, { recursive: true })
  const blockedCommandTask = await createWorkflow('blocked command must not approve', blockedCommandDir, 'execute')
  const blockedCommandCompleted = await waitForTask(blockedCommandTask.task.id, 'needs-fix')
  assert(blockedCommandCompleted.task.execution?.commandResults?.some((item) => item.command === 'pnpm test' && item.skipped), 'The non-allowlisted command was not recorded as skipped.')
  assert(blockedCommandCompleted.snapshot.reviews.some((review) => review.taskId === blockedCommandTask.task.id && review.status === 'failed'), 'QA approved despite a skipped command.')
  console.log('PASS: QA cannot approve when an agent-requested command was skipped by the allowlist.')

  const readOnlyDir = join(tempRoot, 'readonly')
  await mkdir(readOnlyDir, { recursive: true })
  const readOnly = await createWorkflow('readonly permission test', readOnlyDir, 'read-only')
  await waitForTask(readOnly.task.id, 'failed')
  assert(!(await exists(join(readOnlyDir, 'agent-output.md'))), 'Read-only project unexpectedly received a written file.')
  console.log('PASS: read-only project rejects specialist writes.')

  const traversalDir = join(tempRoot, 'traversal')
  await mkdir(traversalDir, { recursive: true })
  const traversal = await createWorkflow('path traversal test', traversalDir, 'write')
  await waitForTask(traversal.task.id, 'failed')
  assert(!(await exists(join(traversalDir, 'partial-before-escape.txt'))), 'Batch write partially wrote a file before rejecting traversal.')
  assert(!(await exists(join(tempRoot, 'escape.txt'))), 'Path traversal wrote outside the authorized directory.')
  console.log('PASS: path traversal is rejected without partial writes.')

  const symlinkDir = join(tempRoot, 'symlink')
  await mkdir(symlinkDir, { recursive: true })
  await symlink(outsideDir, join(symlinkDir, 'escape-link'), 'junction')
  const symlinkTask = await createWorkflow('symlink escape test', symlinkDir, 'write')
  await waitForTask(symlinkTask.task.id, 'failed')
  assert(!(await exists(join(outsideDir, 'escape.txt'))), 'Symlink traversal wrote outside the authorized directory.')
  console.log('PASS: symlink/junction escape is rejected.')

  const hardLinkDir = join(tempRoot, 'hardlink')
  await mkdir(hardLinkDir, { recursive: true })
  const outsideHardLinkTarget = join(outsideDir, 'linked-source.txt')
  await writeFile(outsideHardLinkTarget, 'original outside content')
  const outsideSecret = join(outsideDir, 'private.md')
  await writeFile(outsideSecret, 'OUTSIDE_PROJECT_SENTINEL_6f98c1')
  await link(outsideSecret, join(hardLinkDir, 'private.md'))
  await link(outsideHardLinkTarget, join(hardLinkDir, 'linked-source.txt'))
  const hardLinkTask = await createWorkflow('hardlink escape test', hardLinkDir, 'write')
  await waitForTask(hardLinkTask.task.id, 'failed')
  assert((await readFile(outsideHardLinkTarget, 'utf8')) === 'original outside content', 'Agent write modified a file through an external hard link.')
  const leakCheck = await fetch(`http://127.0.0.1:${providerPort}/__test/leak-check`).then((response) => response.json())
  assert(leakCheck.externalSentinelLeaked === false, 'A hard-linked outside-project secret was sent to the model provider.')
  console.log('PASS: hard-link target is rejected without modifying the linked file.')

  const retryDir = join(tempRoot, 'retry')
  await mkdir(retryDir, { recursive: true })
  const retry = await createWorkflow('retry workflow test', retryDir, 'execute')
  await waitForTask(retry.task.id, 'failed')
  const retryBody = { ...agent('专业 Agent'), executionMode: 'execute' }
  const retryResponse = await request(`/api/workflow/${encodeURIComponent(retry.task.id)}/execute`, { method: 'POST', body: retryBody })
  assert(retryResponse.response.status === 202, `Failed specialist phase could not be retried: ${retryResponse.result.error ?? retryResponse.response.status}`)
  const duplicateRetry = await request(`/api/workflow/${encodeURIComponent(retry.task.id)}/execute`, { method: 'POST', body: retryBody })
  assert(duplicateRetry.response.status === 409, 'A duplicate retry was accepted while the first retry was active.')
  const retryCompleted = await waitForTask(retry.task.id, 'approved')
  assert(retryCompleted.task.execution?.writtenFiles?.includes('agent-output.md'), 'Retry did not complete specialist execution.')
  console.log('PASS: failed specialist phase can be retried; duplicate concurrent retry is rejected.')

  const readonlyApi = await request('/api/projects', { method: 'POST', body: { path: join(tempRoot, 'does-not-exist'), accessMode: 'write', allowedCommands: [] } })
  assert(!readonlyApi.response.ok, 'Project registration accepted a nonexistent directory.')
  const { result: finalSnapshot } = await request('/api/workflow')
  assert(finalSnapshot.sessions.length >= 7 && finalSnapshot.tasks.length >= 7, 'Session/Task persistence did not retain workflow history.')
  assert(finalSnapshot.runs.length >= 17, 'Run persistence did not retain workflow history.')
  console.log('PASS: invalid project paths rejected; Session/Task/Run/Review records persist.')

  const workflowFile = join(dataDir, 'workflow.json')
  const runsFile = join(dataDir, 'runs.json')
  const workflowState = JSON.parse(await readFile(workflowFile, 'utf8'))
  const runState = JSON.parse(await readFile(runsFile, 'utf8'))
  const project = workflowState.projects.find((item) => item.path === projectDir)
  const sessionId = `session-recovery-${Date.now()}`
  const taskId = `task-recovery-${Date.now()}`
  const queuedRunId = `run-recovery-${Date.now()}`
  const interruptedRunId = `${queuedRunId}-interrupted`
  workflowState.sessions.push({ id: sessionId, projectId: project.id, title: 'restart recovery', status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
  workflowState.tasks.push({ id: taskId, sessionId, title: 'restart recovery', brief: 'Verify restart resumes queued work.', status: 'queued', executionMode: 'execute', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), agents: { ceo: agent('CEO Agent'), specialist: agent('专业 Agent'), qa: agent('测试 Agent') }, plan: null, execution: null, reviewId: null })
  const runTemplate = { taskId, sessionId, phase: 'ceo-plan', status: 'queued', mode: 'execute', agentName: 'CEO Agent', provider: 'Local', model: 'mock-model', taskTitle: 'restart recovery', skillNames: [], events: [], createdAt: new Date().toISOString() }
  runState.push({ ...runTemplate, id: queuedRunId })
  runState.push({ ...runTemplate, id: interruptedRunId, phase: 'specialist-execute', status: 'running' })
  await writeFile(workflowFile, JSON.stringify(workflowState, null, 2))
  await writeFile(runsFile, JSON.stringify(runState, null, 2))
  await stopProcess(apiProcess)
  apiProcess = startProcess(['server.mjs'], { ZHIDIAN_API_PORT: String(apiPort), ZHIDIAN_DATA_DIR: dataDir })
  await waitForHealth()
  const recovered = await waitForTask(taskId, 'approved')
  const interrupted = recovered.snapshot.runs.find((run) => run.id === interruptedRunId)
  assert(interrupted?.status === 'failed' && interrupted.error?.includes('运行期间关闭'), 'Interrupted in-flight run was not safely marked failed.')
  console.log('PASS: queued work resumes after restart; interrupted work fails safely instead of replaying.')
} finally {
  for (const child of children.reverse()) await stopProcess(child)
  await rm(tempRoot, { recursive: true, force: true })
}

async function exists(path) {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}
