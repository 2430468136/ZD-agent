import { createServer, request as httpRequest } from 'node:http'
import { copyFile, link, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'

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

function startProcess(args, env = {}, capture = false) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'ignore',
    windowsHide: true,
  })
  if (capture) {
    child.output = ''
    child.diagnostics = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { child.output += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { child.diagnostics += chunk })
    child.outputClosed = new Promise((resolve) => child.once('close', resolve))
  }
  children.push(child)
  return child
}

function startApi(directory = dataDir, ownerKeyHash, storage, keyring, args = [], capture = false) {
  return startProcess(['--import', './scripts/mock-delivery-fetch.mjs', 'server.mjs', ...args], { ZHIDIAN_API_PORT: String(apiPort), ZHIDIAN_UI_PORT: '5173', ZHIDIAN_DATA_DIR: directory, ZHIDIAN_OWNER_KEY_HASH: ownerKeyHash, ZHIDIAN_STORAGE: storage, ZHIDIAN_CREDENTIAL_KEYRING: keyring }, capture)
}

async function waitForExit(child, expected) {
  const deadline = Date.now() + 10_000
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
  if (child.exitCode !== null) await child.outputClosed
  assert(child.exitCode === expected, `Expected API to exit ${expected}, got ${child.exitCode ?? child.signalCode ?? 'timeout'}. ${child.diagnostics ?? ''}`)
}

async function offlineBackup(expected, ...args) {
  const child = startProcess(['scripts/pilot-backup.mjs', ...args], {}, true)
  await waitForExit(child, expected)
  return expected === 0 ? JSON.parse(child.output) : child.diagnostics
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

function requestWithHostOverride(hostHeader) {
  return new Promise((resolveResponse, rejectResponse) => {
    const outgoing = httpRequest({
      hostname: '127.0.0.1',
      port: apiPort,
      path: '/api/workflow',
      method: 'GET',
      headers: { host: hostHeader, origin: 'http://localhost:5173', 'x-zhidian-client': 'web-ui' },
    }, (response) => {
      let body = ''
      response.setEncoding('utf8').on('data', (chunk) => { body += chunk })
      response.on('end', () => resolveResponse({ status: response.statusCode, body }))
    })
    outgoing.on('error', rejectResponse)
    outgoing.end()
  })
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function agent(name, id = name) {
  return { id, name, provider: 'Local', model: 'mock-model', skills: [{ name: `${name} skill`, description: 'e2e fixture' }] }
}

async function waitForOccurrence(scheduleId, status, timeout = 20_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const { result } = await request('/api/schedules')
    const item = result.occurrences?.find((occurrence) => occurrence.scheduleId === scheduleId && occurrence.status === status)
    if (item) return item
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  throw new Error(`Expected schedule ${scheduleId} to reach ${status}: ${JSON.stringify((await request('/api/schedules')).result)}`)
}

async function waitForDelivery(predicate) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const { result } = await request('/api/delivery')
    const item = result.deliveries?.find(predicate)
    if (item) return item
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  throw new Error(`Expected delivery not found: ${JSON.stringify((await request('/api/delivery')).result)}`)
}

async function createWorkflow(title, path = projectDir, accessMode = 'execute', brief = 'Run the deterministic end-to-end fixture.', specialists = [agent('专业 Agent')], verificationCommands = ['node --version']) {
  const { response: projectResponse, result: projectResult } = await request('/api/projects', {
    method: 'POST',
    body: { path, accessMode, allowedCommands: ['node --version'], verificationCommands },
  })
  assert(projectResponse.ok, `Project registration failed: ${projectResult.error ?? projectResponse.status}`)
  const { response, result } = await request('/api/workflow/start', {
    method: 'POST',
    body: {
      projectId: projectResult.project.id,
      title,
      brief,
      agents: { ceo: agent('CEO Agent', 'ceo'), specialists, specialist: specialists[0], qa: agent('测试 Agent', 'qa') },
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
    if (task && ['awaiting-approval', 'approved', 'failed', 'needs-fix', 'cancelled'].includes(task.status)) {
      if (task.status !== expectedStatus) throw new Error(`Task ${taskId} finished as ${task.status}, expected ${expectedStatus}. Runs: ${JSON.stringify(result.runs?.filter((run) => run.taskId === taskId).map((run) => ({ phase: run.phase, agentId: run.agentId, status: run.status, error: run.error })))}`)
      return { task, snapshot: result }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  throw new Error(`Task ${taskId} did not finish within ${timeout}ms.`)
}

function decide(task, decision = 'approve', note) {
  return request(`/api/workflow/${task.id}/decision`, { method: 'POST', body: { reviewId: task.reviewId, decision, note } })
}

async function confirmDelivery(taskId) {
  const { task } = await waitForTask(taskId, 'awaiting-approval')
  const { response, result } = await decide(task)
  assert(response.ok && result.task.status === 'approved' && result.review.decision.value === 'approve', `Human approval failed: ${JSON.stringify(result)}`)
  return waitForTask(taskId, 'approved')
}

async function waitForRunStatus(taskId, phase, expectedStatus, timeout = 10_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const { result } = await request('/api/workflow')
    const run = result.runs?.filter((item) => item.taskId === taskId && item.phase === phase).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
    if (run?.status === expectedStatus) return run
    if (run && ['failed', 'completed', 'cancelled'].includes(run.status)) throw new Error(`Run ${run.id} finished as ${run.status}, expected ${expectedStatus}.`)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50))
  }
  throw new Error(`Run for task ${taskId} did not reach ${expectedStatus} within ${timeout}ms.`)
}

let apiProcess
try {
  await mkdir(projectDir, { recursive: true })
  await mkdir(outsideDir, { recursive: true })
  await writeFile(join(projectDir, 'README.md'), '# E2E fixture\n')
  await writeFile(join(projectDir, 'package.json'), JSON.stringify({ name: 'fixture', private: true, scripts: { lint: 'node -e "process.stdout.write(\\\'fixture-lint-ok\\\')"' } }, null, 2))
  await symlink(outsideDir, join(projectDir, 'escape-link'), 'junction')

  startProcess(['scripts/mock-provider.mjs'], { MOCK_PROVIDER_PORT: String(providerPort) })
  apiProcess = startApi()
  await waitForHealth()

  const deniedOriginResponse = await fetch(`${apiUrl}/api/workflow`, { headers: { origin: 'http://localhost:5174', 'x-zhidian-client': 'web-ui' } })
  assert(deniedOriginResponse.status === 403, 'API accepted a browser origin outside the exact local UI allowlist.')
  const missingClientHeaderResponse = await fetch(`${apiUrl}/api/workflow`, { headers: { origin: 'http://localhost:5173' } })
  assert(missingClientHeaderResponse.status === 403, 'API accepted a non-SSE request without the required custom client header.')
  const hostOverrideResponse = await requestWithHostOverride('attacker.example')
  assert(hostOverrideResponse.status === 403, 'API accepted an untrusted Host header that could enable DNS rebinding.')
  const deniedStartResponse = await fetch(`${apiUrl}/api/workflow/start`, {
    method: 'POST',
    headers: { origin: 'https://attacker.example', 'x-zhidian-client': 'web-ui', 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'must not start' }),
  })
  assert(deniedStartResponse.status === 403, 'API accepted a workflow-start request from an untrusted origin.')
  const emptyWorkflow = await request('/api/workflow')
  assert(emptyWorkflow.result.tasks.length === 0 && emptyWorkflow.result.runs.length === 0, 'A rejected request changed workflow state.')
  const catalog = await request('/api/executors')
  const executorIds = catalog.result.executors?.map((executor) => executor.id) ?? []
  assert(catalog.response.ok && ['model-api', 'deepseek-api', 'codex-cli', 'codex-app-server', 'claude-code'].every((id) => executorIds.includes(id)), 'The server executor registry is missing an existing built-in adapter.')
  if (process.env.ZHIDIAN_ENABLE_PI === '1') assert(executorIds.includes('pi-cli'), 'Pi was explicitly enabled but is missing from the executor registry.')
  else assert(!executorIds.includes('pi-cli'), 'Pi must remain unavailable unless ZHIDIAN_ENABLE_PI=1 is explicitly set.')
  assert(catalog.result.executors.every((executor) => ['projectRead', 'workspaceAccess', 'fileWrite', 'commandExecution', 'networkAccess'].every((key) => typeof executor.capabilities?.[key] === 'string')), 'An executor is missing an explicit capability declaration.')
  console.log('PASS: exact UI Origin, loopback Host, client-header, rejected-write and executor-catalog guards.')
  const harnessStatus = await request('/api/harnesses')
  const codexHarness = harnessStatus.result.harnesses?.find((harness) => harness.id === 'codex-app-server')
  const deepSeekHarness = harnessStatus.result.harnesses?.find((harness) => harness.id === 'deepseek-harness')
  assert(harnessStatus.response.ok && codexHarness && ['connected', 'login-required', 'connection-unknown', 'connection-error', 'not-installed', 'incompatible'].includes(codexHarness.status), 'The Codex discovery endpoint returned an invalid status.')
  assert(!('account' in codexHarness) && !('apiKey' in codexHarness), 'Codex discovery exposed account or credential fields.')
  assert(deepSeekHarness && deepSeekHarness.compatible === false && ['integration-pending', 'not-installed'].includes(deepSeekHarness.status), 'DeepSeek Harness must remain clearly unavailable until its supported SDK adapter is verified.')
  console.log('PASS: local Harness discovery exposes status only, never Codex account or key data; unsupported DeepSeek Harness is not misreported as connected.')

  const { response: providerResponse, result: providerResult } = await request('/api/providers/Local', {
    method: 'PUT',
    body: { baseUrl: providerUrl },
  })
  assert(providerResponse.ok && providerResult.saved, `Could not configure mock provider: ${providerResult.error ?? providerResponse.status}`)

  const contextProject = await request('/api/projects', { method: 'POST', body: { path: projectDir, accessMode: 'execute', allowedCommands: ['node --version'], verificationCommands: ['node --version'] } })
  const unknownExecutor = await request('/api/workflow/start', { method: 'POST', body: { projectId: contextProject.result.project.id, title: 'unknown executor must fail closed', brief: 'fixture', agents: { ceo: { ...agent('CEO Agent', 'ceo'), executor: 'unregistered-fixture' }, specialists: [agent('专业 Agent')], qa: agent('测试 Agent', 'qa') } } })
  assert(unknownExecutor.response.status === 400 && /缺少执行器或模型配置/.test(unknownExecutor.result.error), 'Workflow admission accepted an unregistered executor.')
  const afterUnknownExecutor = await request('/api/workflow')
  assert(afterUnknownExecutor.result.tasks.length === 0 && afterUnknownExecutor.result.runs.length === 0, 'Rejected unknown executor changed persisted workflow state.')
  console.log('PASS: unregistered executor is rejected before task/run persistence.')
  const otherProjectDir = join(tempRoot, 'other-context-project')
  await mkdir(otherProjectDir, { recursive: true })
  const otherContextProject = await request('/api/projects', { method: 'POST', body: { path: otherProjectDir, accessMode: 'read-only', allowedCommands: [] } })
  const personalContext = await request('/api/context', { method: 'POST', body: { scope: 'personal', title: 'React 协作偏好', content: 'React 修改后附上实际运行过的测试命令。', tags: ['React', '测试'] } })
  const projectContext = await request('/api/context', { method: 'POST', body: { scope: 'project', projectId: contextProject.result.project.id, title: 'React 项目约定', content: '此项目组件统一使用 React 函数组件。', tags: ['React'] } })
  const otherProjectContext = await request('/api/context', { method: 'POST', body: { scope: 'project', projectId: otherContextProject.result.project.id, title: 'React 外部项目资料', content: '不应跨项目注入这条 React 资料。', tags: ['React'] } })
  assert(contextProject.response.ok && otherContextProject.response.ok && personalContext.response.ok && projectContext.response.ok && otherProjectContext.response.ok, 'Could not create context retrieval fixtures.')
  const contextTask = await createWorkflow('React context snapshot test', projectDir, 'execute', 'Implement a React component and run its checks.')
  const contextTaskResult = await waitForTask(contextTask.task.id, 'awaiting-approval')
  const matchedContextIds = contextTaskResult.task.contextSnapshot.map((entry) => entry.id)
  assert(matchedContextIds.includes(personalContext.result.entry.id) && matchedContextIds.includes(projectContext.result.entry.id), 'Relevant personal/project context was not snapshotted into the task.')
  assert(!matchedContextIds.includes(otherProjectContext.result.entry.id), 'Context from a different project leaked into the task.')
  const changedContext = await request(`/api/context/${encodeURIComponent(personalContext.result.entry.id)}`, { method: 'PUT', body: { scope: 'personal', title: 'Updated React preference', content: 'Updated preference text.', tags: ['React'] } })
  assert(changedContext.response.ok && contextTaskResult.task.contextSnapshot.find((entry) => entry.id === personalContext.result.entry.id)?.content === 'React 修改后附上实际运行过的测试命令。', 'Task context snapshot should stay immutable after editing library entries.')
  const removedContext = await request(`/api/context/${encodeURIComponent(personalContext.result.entry.id)}`, { method: 'DELETE' })
  assert(removedContext.response.ok, 'Context entry could not be deleted.')
  console.log('PASS: context CRUD, task-time relevance snapshots, immutability, and project-scope isolation.')

  const normal = await createWorkflow('正常流程与白名单命令验证')
  const deniedEventResponse = await fetch(`${apiUrl}/api/runs/${encodeURIComponent(normal.run.id)}/events`, { headers: { origin: 'http://localhost:5174' } })
  assert(deniedEventResponse.status === 403, 'SSE endpoint accepted a non-allowlisted UI origin.')
  const eventResponse = await fetch(`${apiUrl}/api/runs/${encodeURIComponent(normal.run.id)}/events`, { headers: { origin: 'http://localhost:5173' } })
  assert(eventResponse.ok && eventResponse.headers.get('content-type')?.includes('text/event-stream'), 'Run events endpoint did not return SSE.')
  const eventReader = eventResponse.body.getReader()
  const eventChunk = await eventReader.read()
  await eventReader.cancel()
  const eventText = new TextDecoder().decode(eventChunk.value)
  assert(eventText.includes('run.snapshot'), 'SSE stream did not include its initial run snapshot.')
  const pendingNormal = await waitForTask(normal.task.id, 'awaiting-approval')
  const decisionRace = await Promise.all([decide(pendingNormal.task), decide(pendingNormal.task)])
  assert(decisionRace.every((item) => item.response.status === 200 && item.result.task.status === 'approved'), 'Concurrent approval must be idempotent.')
  assert(decisionRace[0].result.review.decision.decidedAt === decisionRace[1].result.review.decision.decidedAt, 'Decision timestamp changed on replay.')
  assert((await decide(pendingNormal.task, 'return', 'Conflicting decision')).response.status === 409, 'A conflicting decision overwrote an approval.')
  const completed = await waitForTask(normal.task.id, 'approved')
  const normalTask = completed.task
  assert(normalTask.execution?.writtenFiles?.includes('agent-output.md'), 'Specialist output file was not written.')
  const command = normalTask.execution?.commandResults?.find((item) => item.command === 'node --version')
  assert(command && command.exitCode === 0 && command.stdout?.includes('v'), 'Whitelisted node --version command did not execute successfully.')
  assert((await readFile(join(projectDir, 'agent-output.md'), 'utf8')).includes('generated by mock specialist'), 'Expected specialist output was not found on disk.')
  assert(completed.snapshot.runs.some((run) => run.phase === 'ceo-plan' && run.status === 'completed'), 'CEO planning run is missing or incomplete.')
  assert(completed.snapshot.runs.some((run) => run.phase === 'specialist-execute' && run.status === 'completed'), 'Specialist execution run is missing or incomplete.')
  const completedQa = completed.snapshot.runs.find((run) => run.taskId === normal.task.id && run.phase === 'qa-review')
  assert(completedQa?.status === 'completed', 'Independent QA run is missing or incomplete.')
  assert(completedQa.events?.some((event) => event.type === 'verification.completed'), 'Independent QA command event was not streamed and persisted.')
  assert(completed.snapshot.reviews.some((review) => review.taskId === normal.task.id && review.status === 'passed'), 'QA review record was not persisted as passed.')
  assert(normalTask.execution?.verificationResults?.some((item) => item.command === 'node --version' && item.exitCode === 0), 'Independent QA verification command did not run successfully.')
  console.log('PASS: CEO → specialist → independent QA; actual verification command; persisted records and SSE.')

  const threadDetailBefore = await request(`/api/threads/${encodeURIComponent(normal.thread.id)}`)
  assert(threadDetailBefore.response.ok && threadDetailBefore.result.messages.some((message) => message.role === 'assistant' && message.taskId === normal.task.id), 'Completed workflow did not append an assistant result to its persistent thread.')
  assert(threadDetailBefore.result.tasks.some((task) => task.threadId === normal.thread.id) && threadDetailBefore.result.runs.some((run) => run.threadId === normal.thread.id), 'Thread detail is missing linked tasks or runs.')
  const crossProjectFollowup = await request(`/api/threads/${encodeURIComponent(normal.thread.id)}/followups`, { method: 'POST', body: { projectId: otherContextProject.result.project.id, message: 'must not switch projects' } })
  assert(crossProjectFollowup.response.status === 403, 'Thread follow-up accepted a different project.')
  const followup = await request(`/api/threads/${encodeURIComponent(normal.thread.id)}/followups`, { method: 'POST', body: { message: '沿用之前的实现，再做一次回归检查。\napi_key=SECRET_THREAD_SHOULD_REDACT_12345' } })
  assert(followup.response.status === 202 && followup.result.task.threadId === normal.thread.id && followup.result.session.threadId === normal.thread.id, `Thread follow-up did not reuse the existing thread: ${JSON.stringify(followup.result)}`)
  const followupCompleted = await confirmDelivery(followup.result.task.id)
  const threadDetailAfter = await request(`/api/threads/${encodeURIComponent(normal.thread.id)}`)
  assert(threadDetailAfter.response.ok && threadDetailAfter.result.tasks.length === 2 && threadDetailAfter.result.messages.filter((message) => message.role === 'user').length === 2, 'Follow-up task/message history was not appended to the same thread.')
  assert(threadDetailAfter.result.messages.every((message) => !message.content.includes('SECRET_THREAD_SHOULD_REDACT_12345')), 'A thread message retained a credential-like value.')
  assert(!followupCompleted.task.brief.includes('SECRET_THREAD_SHOULD_REDACT_12345'), 'A follow-up task persisted a credential-like value.')
  const observedPrompts = await fetch(`${providerUrl.replace('/v1', '')}/__test/prompts`).then((response) => response.json())
  assert(observedPrompts.prompts.some((item) => item.prompt.includes('同线程历史') && item.prompt.includes('正常流程与白名单命令验证')), 'Follow-up prompt did not receive bounded history from its own thread.')
  assert(observedPrompts.prompts.every((item) => !item.prompt.includes('SECRET_THREAD_SHOULD_REDACT_12345')), 'A credential-like follow-up value leaked into a provider prompt.')
  const listedThreads = await request('/api/threads')
  assert(listedThreads.response.ok && listedThreads.result.threads.some((thread) => thread.id === normal.thread.id && thread.taskCount === 2), 'Thread list did not expose the updated persistent thread.')
  console.log('PASS: same-thread follow-up, project isolation, history context, result messages, and secret redaction.')

  const multiDir = join(tempRoot, 'multi-specialist')
  await mkdir(multiDir, { recursive: true })
  const multi = await createWorkflow('multi-specialist handoff test', multiDir, 'execute', 'Verify serial handoff in CEO plan order.', [agent('后端 Agent', 'backend'), agent('前端 Agent', 'frontend')])
  const multiCompleted = await confirmDelivery(multi.task.id)
  const specialistRuns = multiCompleted.snapshot.runs.filter((run) => run.taskId === multi.task.id && run.phase === 'specialist-execute')
  assert(specialistRuns.length === 2, `Expected two specialist runs, got ${specialistRuns.length}.`)
  assert(specialistRuns.map((run) => run.agentId).join(',') === 'frontend,backend', `CEO plan order was not used: ${specialistRuns.map((run) => run.agentId).join(',')}`)
  assert(multiCompleted.task.execution?.specialists?.length === 2, 'Serial handoff results were not aggregated on the task.')
  console.log('PASS: CEO assignment order drives serial multi-specialist handoffs and aggregated execution history.')

  const failedQaDir = join(tempRoot, 'failed-qa')
  await mkdir(failedQaDir, { recursive: true })
  const failedQa = await createWorkflow('independent verification failure test', failedQaDir, 'execute', 'A failing verification command must block approval.', [agent('专业 Agent')], ['node -e "process.exit(9)"'])
  const failedQaResult = await waitForTask(failedQa.task.id, 'needs-fix')
  assert((await decide(failedQaResult.task)).response.status === 409, 'A failed QA record was accepted for approval.')
  assert(failedQaResult.task.execution?.verificationResults?.[0]?.exitCode !== 0, `QA failure command exit code was not recorded: ${JSON.stringify(failedQaResult.task.execution?.verificationResults)}`)
  assert(failedQaResult.snapshot.reviews.find((review) => review.taskId === failedQa.task.id)?.status === 'failed', 'QA approved despite an actual failing verification command.')
  console.log('PASS: nonzero independent QA command is recorded and blocks task approval.')

  const blockedCommandDir = join(tempRoot, 'blocked-command')
  await mkdir(blockedCommandDir, { recursive: true })
  const blockedCommandTask = await createWorkflow('blocked command must not approve', blockedCommandDir, 'execute')
  const blockedCommandCompleted = await waitForTask(blockedCommandTask.task.id, 'needs-fix')
  assert(blockedCommandCompleted.task.execution?.commandResults?.some((item) => item.command === 'pnpm test' && item.skipped), 'The non-allowlisted command was not recorded as skipped.')
  assert(blockedCommandCompleted.snapshot.reviews.some((review) => review.taskId === blockedCommandTask.task.id && review.status === 'failed'), 'QA approved despite a skipped command.')
  console.log('PASS: QA cannot approve when an agent-requested command was skipped by the allowlist.')

  const readOnlyDir = join(tempRoot, 'readonly')
  await mkdir(readOnlyDir, { recursive: true })
  await writeFile(join(readOnlyDir, 'README.md'), 'READONLY_ANALYSIS_FIXTURE\n')
  const readOnlyProject = await request('/api/projects', { method: 'POST', body: { path: readOnlyDir, accessMode: 'read-only', allowedCommands: [] } })
  const directCli = { ...agent('专业 Agent'), executor: 'claude-code' }
  const readOnly = await request('/api/workflow/start', { method: 'POST', body: { projectId: readOnlyProject.result.project.id, title: 'readonly CLI permission test', brief: 'Must be denied before execution.', agents: { ceo: agent('CEO Agent', 'ceo'), specialists: [directCli], qa: agent('测试 Agent', 'qa') } } })
  assert(readOnly.response.status === 403, `Read-only project accepted a direct-workspace specialist: ${JSON.stringify(readOnly.result)}`)
  assert(!(await request('/api/workflow')).result.tasks.some((item) => item.title === 'readonly CLI permission test'), 'Permission-denied workflow was persisted.')
  const analysis = await createWorkflow('read-only summary fixture', readOnlyDir, 'read-only', 'Summarize README only.')
  const completedAnalysis = (await confirmDelivery(analysis.task.id)).task
  assert(completedAnalysis.execution?.summary === 'mock read-only analysis', 'Read-only work returned no analysis.')
  assert(completedAnalysis.execution?.acceptanceNotes?.includes('READONLY_ANALYSIS_FIXTURE'), 'The read-only specialist did not see the authorized snapshot.')
  assert(completedAnalysis.execution.writtenFiles.length === 0 && completedAnalysis.execution.commandResults.length === 0 && completedAnalysis.execution.verificationResults.length === 0, 'Read-only workflow unexpectedly produced side effects.')

  for (const attempt of ['file', 'command']) {
    const task = await createWorkflow(`read-only ${attempt} proposal fixture`, readOnlyDir, 'read-only')
    const failed = (await waitForTask(task.task.id, 'failed')).snapshot.runs.filter((run) => run.taskId === task.task.id)
    assert(failed.some((run) => run.phase === 'specialist-execute' && /只读分析不能提出文件修改或命令/.test(run.error ?? '')), `Read-only ${attempt} proposal was not rejected.`)
    assert(!failed.some((run) => run.phase === 'qa-review'), 'Read-only workflow sent a denied modification to QA.')
  }

  const preserve = await createWorkflow('scheduler timeout fixture read-only file proposal fixture', readOnlyDir, 'read-only')
  await waitForRunStatus(preserve.task.id, 'ceo-plan', 'running')
  const upgrade = await request('/api/projects', { method: 'POST', body: { path: readOnlyDir, accessMode: 'write' } })
  assert(upgrade.response.ok && upgrade.result.project.accessMode === 'write', 'Could not expand the test project grant.')
  const finished = (await waitForTask(preserve.task.id, 'failed')).snapshot.runs.filter((run) => run.taskId === preserve.task.id)
  assert(finished.some((run) => run.phase === 'specialist-execute' && /只读分析不能提出文件修改或命令/.test(run.error ?? '')), 'An already submitted read-only task gained write access after a project grant change.')
  assert(!(await exists(join(readOnlyDir, 'agent-output.md'))), 'Read-only project unexpectedly received a written file.')
  assert(await readFile(join(readOnlyDir, 'README.md'), 'utf8') === 'READONLY_ANALYSIS_FIXTURE\n', 'Read-only fixture changed bytes on disk.')
  console.log('PASS: snapshot-only API analysis completes, refuses files and commands, and preserves the original read-only task after a grant expansion; direct CLI is denied.')

  const cancelledDir = join(tempRoot, 'cancelled')
  await mkdir(cancelledDir, { recursive: true })
  const cancellable = await createWorkflow('cancel specialist fixture', cancelledDir, 'write')
  const activeSpecialistRun = await waitForRunStatus(cancellable.task.id, 'specialist-execute', 'running')
  const cancelResult = await request(`/api/runs/${encodeURIComponent(activeSpecialistRun.id)}/cancel`, { method: 'POST' })
  assert(cancelResult.response.status === 202, `Active run cancellation was not accepted: ${JSON.stringify(cancelResult.result)}`)
  const cancelled = await waitForTask(cancellable.task.id, 'cancelled')
  assert(cancelled.snapshot.runs.find((run) => run.id === activeSpecialistRun.id)?.status === 'cancelled', 'Cancelled run did not reach a terminal cancelled status.')
  assert(cancelled.snapshot.runs.find((run) => run.id === activeSpecialistRun.id)?.events?.some((event) => event.type === 'run.cancellation_requested'), 'Cancellation request was not recorded in the run event history.')
  assert(!(await exists(join(cancelledDir, 'agent-output.md'))), 'A cancelled API patch was written after cancellation.')
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  const afterCancel = await request('/api/workflow')
  assert(afterCancel.result.runs.filter((run) => run.taskId === cancellable.task.id && run.phase === 'specialist-execute').length === 1, 'Cancelled write stage was automatically replayed.')
  assert(!['queued', 'running'].includes(afterCancel.result.tasks.find((task) => task.id === cancellable.task.id)?.status), 'Cancelled task remained active.')
  console.log('PASS: active run cancellation aborts provider work, records terminal status, and does not replay writes.')

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
  const retryCompleted = await confirmDelivery(retry.task.id)
  assert(retryCompleted.task.execution?.writtenFiles?.includes('agent-output.md'), 'Retry did not complete specialist execution.')
  console.log('PASS: failed specialist phase can be retried; duplicate concurrent retry is rejected.')

  const readonlyApi = await request('/api/projects', { method: 'POST', body: { path: join(tempRoot, 'does-not-exist'), accessMode: 'write', allowedCommands: [] } })
  assert(!readonlyApi.response.ok, 'Project registration accepted a nonexistent directory.')
  const { result: finalSnapshot } = await request('/api/workflow')
  assert(finalSnapshot.sessions.length >= 7 && finalSnapshot.tasks.length >= 7, 'Session/Task persistence did not retain workflow history.')
  assert(finalSnapshot.runs.length >= 17, 'Run persistence did not retain workflow history.')
  console.log('PASS: invalid project paths rejected; Session/Task/Run/Review records persist.')

  const duplicateInstance = startProcess(['server.mjs'], { ZHIDIAN_API_PORT: String(await freePort()), ZHIDIAN_DATA_DIR: dataDir })
  const lockExit = await new Promise((resolveExit, reject) => {
    const timeout = setTimeout(() => reject(new Error('Duplicate instance did not exit.')), 3000)
    duplicateInstance.once('exit', (code) => { clearTimeout(timeout); resolveExit(code) })
  })
  assert(lockExit === 1, 'The same data directory admitted a second scheduler instance.')
  const futureOnce = { kind: 'once', runAt: new Date(Date.now() + 3_600_000).toISOString() }
  const scheduleConfig = { sourceTaskId: normal.task.id, recurrence: futureOnce, enabled: false }
  const createdSchedule = await request('/api/schedules', { method: 'POST', body: { ...scheduleConfig, title: 'manual scheduler test' } })
  assert(createdSchedule.response.status === 201, `Schedule creation failed: ${JSON.stringify(createdSchedule.result)}`)
  const scheduleId = createdSchedule.result.schedule.id
  const triggerPath = `/api/schedules/${scheduleId}/run-now`
  const triggers = await Promise.all([1, 2].map(() => request(triggerPath, { method: 'POST', body: { requestId: 'same-request-123' } })))
  assert(triggers.every((item) => item.response.status === 202 && item.result.occurrence.id === triggers[0].result.occurrence.id), 'Manual trigger replay created two occurrences.')
  const waitingManual = await waitForOccurrence(scheduleId, 'awaiting-approval')
  const { task: manualTask, snapshot: waitingSnapshot } = await waitForTask(waitingManual.taskIds[0], 'awaiting-approval')
  assert((await decide(manualTask, 'return', ' ')).response.status === 400, 'Empty return reason was accepted.')
  const returned = await decide(manualTask, 'return', 'Review the wording and re-run checks.')
  assert(returned.response.status === 200 && returned.result.task.status === 'needs-fix' && returned.result.review.status === 'passed', 'Return must preserve the QA result.')
  assert((await waitForOccurrence(scheduleId, 'failed')).id === waitingManual.id, 'Returned occurrence did not leave the approval queue.')
  assert((await waitForTask(manualTask.id, 'needs-fix')).snapshot.runs.length === waitingSnapshot.runs.length, 'Return unexpectedly queued a run.')
  assert((await request(`/api/workflow/${manualTask.id}/review`, { method: 'POST', body: agent('测试 Agent', 'qa') })).response.status === 409, 'Return allowed skipping specialist rework.')
  const rework = await request(`/api/workflow/${manualTask.id}/execute`, { method: 'POST', body: {} })
  assert(rework.response.status === 202, `Could not queue rework: ${JSON.stringify(rework.result)}`)
  const { task: reworked, snapshot: reworkSnapshot } = await waitForTask(manualTask.id, 'awaiting-approval')
  assert(reworked.reviewId !== manualTask.reviewId && reworkSnapshot.reviews.some((review) => review.id === manualTask.reviewId && review.decision?.value === 'return'), 'Rework did not retain the old decision separately.')
  assert((await decide(manualTask)).response.status === 409, 'A stale QA record approved new work.')
  await confirmDelivery(reworked.id)
  const manual = await waitForOccurrence(scheduleId, 'completed')
  assert(manual.taskIds.length === 1, 'The manual occurrence did not create exactly one task.')
  console.log('PASS: human approval is idempotent; return preserves QA and requires re-execution with a fresh review; scheduled status tracks the decision.')
  const retrySchedule = await request('/api/schedules', { method: 'POST', body: { ...scheduleConfig, title: 'scheduler timeout fixture', timeoutMs: 1000, maxRetries: 1 } })
  const retryScheduleId = retrySchedule.result.schedule?.id
  assert(retryScheduleId, 'Could not create the schedule timeout fixture.')
  const retrySchedulePath = `/api/schedules/${retryScheduleId}/run-now`
  const retryTrigger = await request(retrySchedulePath, { method: 'POST', body: { requestId: 'timeout-fixture-001' } })
  assert(retryTrigger.response.status === 202, 'Could not trigger the schedule timeout fixture.')
  const collision = await request(retrySchedulePath, { method: 'POST', body: { requestId: 'timeout-fixture-002' } })
  assert(collision.response.status === 409, 'The same schedule accepted a second concurrent occurrence.')
  const waitingRetry = await waitForOccurrence(retryScheduleId, 'retry-wait')
  assert(waitingRetry.taskIds.length === 1 && Date.parse(waitingRetry.retryAt) > Date.now(), 'The scheduler did not persist the timeout retry and backoff.')
  const cancelRetry = await request(`/api/occurrences/${waitingRetry.id}/cancel`, { method: 'POST' })
  assert(cancelRetry.response.status === 200 && (await waitForOccurrence(retryScheduleId, 'cancelled')).taskIds.length === 1, 'Scheduled retry could not be cancelled.')
  const other = await request('/api/schedules', { method: 'POST', body: { ...scheduleConfig, enabled: true, title: 'catch-up scheduler test', misfire: 'run-once' } })
  const skip = await request('/api/schedules', { method: 'POST', body: { ...scheduleConfig, enabled: true, title: 'skip scheduler test' } })
  const denied = await request('/api/schedules', { method: 'POST', body: { ...scheduleConfig, sourceTaskId: multi.task.id, enabled: true, title: 'denied scheduler test', misfire: 'run-once' } })
  assert([other, skip, denied].every((item) => item.response.status === 201), 'Could not create restart schedule fixtures.')
  const changedGrant = await request('/api/projects', { method: 'POST', body: { path: multiDir, accessMode: 'read-only' } })
  assert(changedGrant.response.ok, 'Could not change project grant before trigger.')
  const deniedTrigger = await request(`/api/schedules/${denied.result.schedule.id}/run-now`, { method: 'POST', body: { requestId: 'grant-denied-123' } })
  assert(deniedTrigger.response.status === 403, 'Manual scheduler bypassed current project grant.')
  await stopProcess(apiProcess)
  const workflowFile = join(dataDir, 'workflow.json')
  const workflowState = JSON.parse(await readFile(workflowFile, 'utf8'))
  const runState = workflowState.runs
  for (const uid of [other.result.schedule.id, skip.result.schedule.id, denied.result.schedule.id]) {
    const schedule = workflowState.schedules.find((item) => item.id === uid)
    schedule.nextRunAt = new Date(Date.now() - 120_000).toISOString()
    schedule.recurrence.runAt = schedule.nextRunAt
  }
  const project = workflowState.projects.find((item) => item.path === projectDir)
  const sessionId = `session-recovery-${Date.now()}`
  const taskId = `task-recovery-${Date.now()}`
  const queuedRunId = `run-recovery-${Date.now()}`
  const interruptedRunId = `${queuedRunId}-interrupted`
  const threadId = `thread-recovery-${Date.now()}`
  workflowState.threads.push({ id: threadId, projectId: project.id, title: 'restart recovery', status: 'active', agents: { ceo: agent('CEO Agent'), specialists: [agent('专业 Agent')], qa: agent('测试 Agent') }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
  workflowState.sessions.push({ id: sessionId, projectId: project.id, threadId, title: 'restart recovery', status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
  workflowState.tasks.push({ id: taskId, sessionId, threadId, title: 'restart recovery', brief: 'Verify restart resumes queued work.', status: 'queued', executionMode: 'execute', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), agents: { ceo: agent('CEO Agent'), specialists: [agent('专业 Agent')], specialist: agent('专业 Agent'), qa: agent('测试 Agent') }, plan: null, execution: null, reviewId: null })
  workflowState.messages.push({ id: `message-${taskId}`, threadId, taskId, role: 'user', content: 'restart recovery', createdAt: new Date().toISOString() })
  const runTemplate = { taskId, sessionId, threadId, phase: 'ceo-plan', status: 'queued', mode: 'execute', agentName: 'CEO Agent', provider: 'Local', model: 'mock-model', taskTitle: 'restart recovery', skillNames: [], events: [], createdAt: new Date().toISOString() }
  runState.push({ ...runTemplate, id: queuedRunId })
  runState.push({ ...runTemplate, id: interruptedRunId, phase: 'specialist-execute', status: 'running' })
  await writeFile(workflowFile, JSON.stringify(workflowState, null, 2))
  apiProcess = startApi()
  await waitForHealth()
  const restoredApproval = await waitForTask(contextTask.task.id, 'awaiting-approval')
  assert(restoredApproval.task.reviewId === contextTaskResult.task.reviewId, 'The approval queue lost its QA record on restart.')
  await confirmDelivery(contextTask.task.id)
  assert((await decide(pendingNormal.task)).result.review.decision.decidedAt === decisionRace[0].result.review.decision.decidedAt, 'Approval replay changed after restart.')
  const recovered = await confirmDelivery(taskId)
  const persistedContext = await request('/api/context')
  assert(persistedContext.result.entries.some((entry) => entry.id === projectContext.result.entry.id), 'Project context was not persisted across API restart.')
  assert(!persistedContext.result.entries.some((entry) => entry.id === personalContext.result.entry.id), 'Deleted context entry reappeared after restart.')
  const interrupted = recovered.snapshot.runs.find((run) => run.id === interruptedRunId)
  assert(interrupted?.status === 'failed' && interrupted.error?.includes('运行期间关闭'), 'Interrupted in-flight run was not safely marked failed.')
  console.log('PASS: queued work resumes after restart; interrupted work fails safely instead of replaying.')
  const missed = await waitForOccurrence(skip.result.schedule.id, 'skipped')
  const blocked = await waitForOccurrence(denied.result.schedule.id, 'failed')
  const catchUpWaiting = await waitForOccurrence(other.result.schedule.id, 'awaiting-approval')
  await confirmDelivery(catchUpWaiting.taskIds[0])
  const catchUp = await waitForOccurrence(other.result.schedule.id, 'completed')
  assert(!missed.taskIds.length && !blocked.taskIds.length && catchUp.taskIds.length === 1, 'Recovered schedules did not respect catch-up, skip, and revoked grants.')
  const repeated = await request(triggerPath, { method: 'POST', body: { requestId: 'same-request-123' } })
  assert(repeated.result.occurrence?.id === manual.id && repeated.result.occurrence.taskIds[0] === manual.taskIds[0], 'Manual idempotency did not survive restart.')
  const reopened = await request(`/api/threads/${normal.thread.id}/followups`, { method: 'POST', body: { message: 'resume this thread after restart' } })
  assert(reopened.response.status === 202 && reopened.result.task.threadId === normal.thread.id, 'A previously persisted thread could not be resumed after restart.')
  await confirmDelivery(reopened.result.task.id)
  console.log('PASS: single writer, schedule catch-up and skip, revoked authorization, and idempotent restart.')

  const deliveryPath = `/api/delivery/${normal.thread.projectId}`
  const url = 'https://open.feishu.cn/open-apis/bot/v2/hook/test-signed-token'
  const secret = 'fixture-webhook-secret'
  const invalidHook = await request(deliveryPath, { method: 'PUT', body: { channel: 'feishu', events: ['approved'], webhook: 'http://127.0.0.1/private' } })
  assert(invalidHook.response.status === 400, 'The notification API accepted a non-official endpoint.')
  const httpLink = await request(deliveryPath, { method: 'PUT', body: { channel: 'feishu', events: ['approved'], webhook: url, includeTaskLink: true } })
  assert(httpLink.response.status === 400, 'The HTTP workbench accepted external task links.')
  if (process.platform === 'win32') {
    const config = await request(deliveryPath, { method: 'PUT', body: { channel: 'feishu', events: ['approved'], webhook: url, signingSecret: secret } })
    assert(config.response.ok && config.result.target?.hasSigningSecret && !JSON.stringify(config.result).includes(url), `Could not securely save signed bot config: ${JSON.stringify(config.result)}`)
    const disk = await readFile(workflowFile, 'utf8')
    assert(!disk.includes(url) && !disk.includes(secret) && disk.includes('encryptedCredentials'), 'Expected encrypted webhook credentials on disk.')
    const testPing = await request(`${deliveryPath}/test`, { method: 'POST' })
    assert(testPing.response.status === 202, 'Could not queue test delivery.')
    assert((await request(`${deliveryPath}/test`, { method: 'POST' })).response.status === 429, 'Test delivery was not rate limited.')
    await waitForDelivery((item) => item.event === 'test' && item.status === 'sent')
    const notificationTask = await createWorkflow('private-name-not-for-notifications', projectDir, 'execute', 'private-brief-not-for-notifications')
    await confirmDelivery(notificationTask.task.id)
    const sent = await waitForDelivery((item) => item.taskId === notificationTask.task.id && item.status === 'sent')
    const configList = await request('/api/delivery')
    assert(!JSON.stringify(configList.result).includes(url) && !JSON.stringify(configList.result).includes(secret), 'The delivery API disclosed encrypted configuration material.')
    const throttle = await request(deliveryPath, { method: 'PUT', body: { webhook: url.replace('test-signed-token', 'test-throttle-token') } })
    assert(throttle.response.ok, 'Could not save throttle fixture destination.')
    const throttled = await createWorkflow('delivery throttle fixture')
    await confirmDelivery(throttled.task.id)
    const delayed = await waitForDelivery((item) => item.taskId === throttled.task.id && item.status === 'retry-wait')
    assert(delayed.attempts === 1 && Date.parse(delayed.retryAt) > Date.now(), '429 did not persist retry backoff.')
    // The GET route may see in-memory state while the asynchronous snapshot is still being written.
    let persisted = false
    for (let n = 0; n < 60 && !persisted; n += 1) {
      const saved = JSON.parse(await readFile(workflowFile, 'utf8'))
      persisted = saved.deliveries.some((item) => item.id === delayed.id && item.retryAt === delayed.retryAt)
      if (!persisted) await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert(persisted, '429 backoff never reached disk.')
    await stopProcess(apiProcess)
    apiProcess = startApi()
    await waitForHealth()
    const afterRestart = await request('/api/delivery')
    assert(afterRestart.result.deliveries.filter((item) => item.id === sent.id && item.attempts === 1).length === 1 && afterRestart.result.deliveries.some((item) => item.id === delayed.id && item.retryAt === delayed.retryAt), 'Delivery and backoff did not persist across restart.')
    const revoked = await request(deliveryPath, { method: 'DELETE' })
    assert(revoked.response.ok && (await request(`${deliveryPath}/test`, { method: 'POST' })).response.status === 409, 'Revoked destination still accepted test deliveries.')
    assert((await request('/api/delivery')).result.deliveries.some((item) => item.id === delayed.id && item.status === 'cancelled' && item.retryAt === null), 'Revocation did not cancel a pending retry immediately.')
    console.log('PASS: DPAPI credentials, transmitted signed minimal payload, rate limits, durable retry and revocation (mock bot).')
  }

  // Exercise migration separately, without feeding schedule records to the legacy reader.
  const legacyDir = join(tempRoot, 'legacy-data')
  await mkdir(legacyDir)
  const legacy = JSON.stringify({ projects: [{ id: 'legacy-project', name: 'legacy', path: projectDir }], sessions: [], tasks: [], reviews: [], contextEntries: [] })
  await writeFile(join(legacyDir, 'workflow.json'), legacy)
  await stopProcess(apiProcess)
  const legacyCheck = startApi(legacyDir, undefined, undefined, undefined, ['--check-data'], true)
  await waitForExit(legacyCheck, 0)
  const legacyReport = JSON.parse(legacyCheck.output)
  assert(legacyReport.storage === 'json' && legacyReport.counts.projects === 1, 'Offline checker did not validate the compatible legacy JSON format.')
  assert((await readdir(legacyDir)).join(',') === 'workflow.json' && await readFile(join(legacyDir, 'workflow.json'), 'utf8') === legacy, 'Offline check migrated the legacy snapshot.')
  const missingDir = join(tempRoot, 'nonexistent-backup')
  await waitForExit(startApi(missingDir, undefined, undefined, undefined, ['--check-data']), 1)
  assert(!(await readdir(tempRoot)).includes('nonexistent-backup'), 'Offline check created the missing data directory.')
  const legacyBundle = join(tempRoot, 'before-json-upgrade')
  assert((await offlineBackup(0, 'create', legacyDir, legacyBundle)).storage === 'json', 'Legacy store was not backed up as JSON.')
  apiProcess = startApi(legacyDir)
  await waitForHealth()
  const backupName = (await readdir(legacyDir)).find((name) => name.startsWith('workflow.json.backup-v1-'))
  assert(backupName && await readFile(join(legacyDir, backupName), 'utf8') === legacy, 'Migration failed to preserve an exact backup of the old data.')
  assert((await request('/api/workflow')).result.projects.some((item) => item.id === 'legacy-project'), 'Data migration lost a project with no threads.')
  const legacyRollback = join(tempRoot, 'json-rollback')
  await offlineBackup(0, 'restore', legacyBundle, legacyRollback)
  assert((await readdir(legacyRollback)).join(',') === 'workflow.json' && await readFile(join(legacyRollback, 'workflow.json'), 'utf8') === legacy, 'Rollback did not restore the exact original legacy file.')
  console.log('PASS: exact legacy backup and migration preserve projects with no threads.')

  const ownerKey = randomBytes(32).toString('base64url')
  const ownerKeyHash = createHash('sha256').update(ownerKey).digest('hex')
  await stopProcess(apiProcess)
  const originalJson = await readFile(workflowFile, 'utf8')
  apiProcess = startApi(dataDir, ownerKeyHash, 'sqlite')
  await waitForHealth()
  const locked = await request('/api/auth/status')
  assert(locked.result.required && !locked.result.signedIn, 'Local auth did not start locked.')
  for (const path of ['/api/workflow', '/api/providers', '/api/threads', '/api/schedules', '/api/delivery', `/api/runs/${normal.run.id}/events`]) {
    assert((await request(path)).response.status === 401, `Unauthenticated request reached ${path}.`)
  }
  assert((await request('/api/workflow/start', { method: 'POST', body: {} })).response.status === 401, 'Unauthenticated write was not rejected.')
  assert((await request('/api/auth/login', { method: 'POST', body: { key: ownerKey }, headers: { origin: 'http://localhost:5174' } })).response.status === 403, 'Cross-origin login was accepted.')
  const login = await request('/api/auth/login', { method: 'POST', body: { key: ownerKey } })
  const setCookie = login.response.headers.get('set-cookie')
  assert(login.response.ok && setCookie?.includes('HttpOnly') && setCookie.includes('SameSite=Strict'), 'Login did not issue a safe local session cookie.')
  const cookie = setCookie.split(';', 1)[0]
  const ownerSnapshot = await request('/api/workflow', { headers: { cookie } })
  const legacyProjects = JSON.parse(originalJson).projects
  assert(ownerSnapshot.response.ok && ownerSnapshot.result.projects.length === legacyProjects.length && ownerSnapshot.result.runs.some((run) => run.id === normal.run.id), 'SQLite import lost existing workflow records.')
  assert(await readFile(workflowFile, 'utf8') === originalJson && await exists(join(dataDir, 'workflow.sqlite')), 'SQLite import changed the source JSON or failed to create the database.')
  const invite = async (name, projectId) => {
    const result = await request('/api/members', { method: 'POST', headers: { cookie }, body: { name, projectIds: [projectId], enabled: true } })
    assert(result.response.status === 201 && typeof result.result.accessKey === 'string' && !Object.hasOwn(result.result.member, 'keyHash'), 'Owner invite failed or exposed secret material.')
    return result.result
  }
  const viewerA = await invite('Viewer A', normal.thread.projectId)
  const viewerB = await invite('Viewer B', multi.thread.projectId)
  async function loginViewer(invitation) {
    const loginResponse = await request('/api/auth/login', { method: 'POST', body: { memberId: invitation.member.id, key: invitation.accessKey } })
    assert(loginResponse.response.ok, 'Project member login failed.')
    return { cookie: loginResponse.response.headers.get('set-cookie').split(';', 1)[0] }
  }
  const viewerAHeaders = await loginViewer(viewerA)
  const viewerBHeaders = await loginViewer(viewerB)
  for (const [headers, allowedId, privateId] of [[viewerAHeaders, normal.thread.projectId, multi.thread.projectId], [viewerBHeaders, multi.thread.projectId, normal.thread.projectId]]) {
    const viewerStatus = await request('/api/auth/status', { headers })
    assert(viewerStatus.result.role === 'viewer', 'Viewer was not classified as a viewer.')
    const memberView = await request('/api/member/workspace', { headers })
    assert(memberView.response.ok && memberView.result.projects.length === 1 && memberView.result.projects[0].id === allowedId, 'Viewer received unauthorized project data.')
    assert(memberView.result.runs.length > 0 && Object.values(memberView.result).flat().every((record) => record.projectId === undefined || record.projectId === allowedId), 'Viewer received unauthorized related records.')
    assert(!JSON.stringify(memberView.result).includes(privateId) && !memberView.result.runs.some((run) => run.output || run.events), 'Viewer saw another project ID or raw content.')
    for (const path of ['/api/providers', '/api/workflow', '/api/context', '/api/members', `/api/threads/${normal.thread.id}`]) assert((await request(path, { headers })).response.status === 403, `Viewer reached ${path}.`)
    for (const path of ['/api/projects', '/api/schedules', '/api/workflow/start', `/api/threads/${normal.thread.id}/followups`, `/api/runs/${normal.run.id}/cancel`]) assert((await request(path, { method: 'POST', headers, body: {} })).response.status === 403, `Viewer mutated ${path}.`)
  }
  assert((await request(`/api/runs/${multi.run.id}/events`, { headers: viewerAHeaders })).response.status === 404, 'Cross-project SSE was accepted.')
  const viewerSse = await fetch(`${apiUrl}/api/runs/${normal.run.id}/events`, { headers: { origin: 'http://localhost:5173', ...viewerAHeaders }, signal: AbortSignal.timeout(5_000) })
  assert(viewerSse.ok, 'Allowed project SSE was denied.')
  const viewerReader = viewerSse.body.getReader()
  const frame = new TextDecoder().decode((await viewerReader.read()).value)
  assert(frame.includes(normal.run.id) && !frame.includes('output') && !frame.includes('events') && !frame.includes('message'), 'SSE leaked detailed execution information.')
  const rotate = await request(`/api/members/${viewerA.member.id}`, { method: 'PUT', headers: { cookie }, body: { name: 'Viewer A', projectIds: [multi.thread.projectId], enabled: true, rotateKey: true } })
  assert(rotate.response.ok && rotate.result.accessKey !== viewerA.accessKey, 'Key rotation failed.')
  while (!(await viewerReader.read()).done) { /* Drain already queued SSE data. */ }
  assert((await request('/api/member/workspace', { headers: viewerAHeaders })).response.status === 401, 'Revoked membership retained an active session.')
  assert((await request('/api/auth/login', { method: 'POST', body: { memberId: viewerA.member.id, key: viewerA.accessKey } })).response.status === 401, 'The old member key remained valid.')
  const rotatedHeaders = await loginViewer(rotate.result)
  assert((await request('/api/member/workspace', { headers: rotatedHeaders })).result.projects[0].id === multi.thread.projectId, 'Membership reassignment retained the old project.')
  console.log('PASS: independent project viewers, explicit route denial, minimal SSE, and immediate membership revocation.')
  const authenticatedSse = await fetch(`${apiUrl}/api/runs/${normal.run.id}/events`, { headers: { origin: 'http://localhost:5173', cookie }, signal: AbortSignal.timeout(5_000) })
  assert(authenticatedSse.ok, 'Authenticated SSE was denied.')
  const liveReader = authenticatedSse.body.getReader()
  assert(!(await liveReader.read()).done, 'Authenticated SSE returned no snapshot.')
  assert((await request('/api/auth/logout', { method: 'POST', headers: { cookie } })).response.ok, 'Logout failed.')
  while (!(await liveReader.read()).done) { /* Drain already queued SSE data. */ }
  assert((await request('/api/workflow', { headers: { cookie } })).response.status === 401, 'Logged-out cookie could be reused.')
  await stopProcess(apiProcess)
  apiProcess = startApi(dataDir, ownerKeyHash)
  await waitForHealth()
  assert((await request('/api/member/workspace', { headers: rotatedHeaders })).response.status === 401, 'A pre-restart session remained valid.')
  const restoredViewer = await loginViewer(rotate.result)
  const restoredWorkspace = await request('/api/member/workspace', { headers: restoredViewer })
  assert(restoredWorkspace.result.projects[0].id === multi.thread.projectId && restoredWorkspace.result.runs.some((run) => run.id === multi.run.id), 'SQLite restart lost project membership or existing runs.')
  assert(await readFile(workflowFile, 'utf8') === originalJson, 'SQLite writes modified the frozen JSON source.')
  console.log('PASS: SQLite import preserves source JSON and restarts with persisted project membership and runs.')
  for (let n = 0; n < 8; n += 1) assert((await request('/api/auth/login', { method: 'POST', body: { key: 'invalid-key' } })).response.status === 401, 'Invalid key was accepted.')
  assert((await request('/api/auth/login', { method: 'POST', body: { key: ownerKey } })).response.status === 429, 'Login rate limit did not activate.')
  console.log('PASS: optional owner login, private API and SSE, origin check, stream revocation, and login throttling.')

  const v1 = randomBytes(32).toString('hex')
  const v2 = randomBytes(32).toString('hex')
  async function keyring(active, keys, slug) {
    const path = join(tempRoot, `keys-${slug}.json`)
    await writeFile(path, JSON.stringify({ active, keys }), { mode: 0o600 })
    return path
  }
  const oldRing = await keyring('v1', { v1 }, 'old')
  const bothRing = await keyring('v2', { v1, v2 }, 'rotation')
  const newRing = await keyring('v2', { v2 }, 'new')
  async function ownerHeaders() {
    const login = await request('/api/auth/login', { method: 'POST', body: { key: ownerKey } })
    assert(login.response.ok, 'Could not log in for the credential test.')
    return { cookie: login.response.headers.get('set-cookie').split(';', 1)[0] }
  }
  await stopProcess(apiProcess)
  apiProcess = startApi(dataDir, ownerKeyHash, undefined, oldRing)
  await waitForHealth()
  const vaultOwner = await ownerHeaders()
  const apiKey = randomBytes(32).toString('base64url')
  const configuredProvider = await request('/api/providers/DeepSeek', { method: 'PUT', headers: vaultOwner, body: { baseUrl: 'https://api.deepseek.com/v1', apiKey } })
  assert(configuredProvider.response.ok, 'Could not save provider key with the instance keyring.')
  const vaultDelivery = `/api/delivery/${multi.thread.projectId}`
  const webhook = 'https://open.feishu.cn/open-apis/bot/v2/hook/test-signed-token'
  const config = await request(vaultDelivery, { method: 'PUT', headers: vaultOwner, body: { channel: 'feishu', events: ['approved'], webhook, signingSecret: 'fixture-webhook-secret' } })
  assert(config.response.ok, 'Could not save webhook with the instance keyring.')
  await waitForExit(startApi(dataDir, ownerKeyHash, undefined, bothRing, ['--rotate-credentials']), 1)
  await waitForExit(startApi(dataDir, ownerKeyHash, undefined, oldRing, ['--check-data']), 1)
  const backupDir = join(tempRoot, 'offline-backup')
  const restoredDir = join(tempRoot, 'offline-restored')
  const mixedDir = join(tempRoot, 'half-rotated')
  assert((await offlineBackup(1, 'create', dataDir, backupDir)).includes('Could not lock'), 'Online backup did not report the live instance.')
  assert(!(await readdir(tempRoot)).includes('offline-backup'), 'Rejected online backup created an output directory.')
  await stopProcess(apiProcess)
  const bundle = await offlineBackup(0, 'create', dataDir, backupDir)
  assert(bundle.storage === 'sqlite' && bundle.files.some(({ name }) => name === 'providers.json') && bundle.files.some(({ name }) => name === 'audit.jsonl'), 'Backup did not include SQLite and instance settings.')
  assert(!JSON.stringify(bundle).includes(apiKey) && !JSON.stringify(bundle).includes(webhook), 'Backup report included confidential data.')
  const verified = await offlineBackup(0, 'verify', backupDir)
  assert(JSON.stringify(verified.files) === JSON.stringify(bundle.files), 'Verification did not report the original file digests.')
  await offlineBackup(0, 'restore', backupDir, restoredDir)
  await offlineBackup(0, 'restore', backupDir, mixedDir)
  assert((await offlineBackup(1, 'restore', backupDir, restoredDir)).includes('EEXIST'), 'Restore accepted an existing destination.')
  console.log('PASS: offline backup refuses a live writer, verifies its manifest, restores a new directory, and can recover the exact pre-migration JSON.')
  const hashedFiles = (await readdir(restoredDir)).filter((name) => ['providers.json', 'workflow.json', 'workflow.sqlite', 'workflow.sqlite-wal', 'audit.jsonl', 'audit.previous.jsonl'].includes(name))
  const fingerprints = () => Promise.all(hashedFiles.map(async (file) => createHash('sha256').update(await readFile(join(restoredDir, file))).digest('hex')))
  const beforeCheck = await fingerprints()
  await waitForExit(startApi(restoredDir, ownerKeyHash, undefined, newRing, ['--check-data']), 1)
  const checked = startApi(restoredDir, ownerKeyHash, undefined, oldRing, ['--check-data'], true)
  await waitForExit(checked, 0)
  const report = JSON.parse(checked.output)
  assert(report.ok && report.storage === 'sqlite' && report.counts.members === 2 && report.counts.runs > 0 && report.credentials.providerKeys === 1 && report.credentials.deliveryTargets === 1, 'Restored backup did not pass offline validation.')
  assert(!checked.output.includes(apiKey) && !checked.output.includes(webhook) && !checked.output.includes(rotate.result.accessKey), 'Offline report disclosed a secret.')
  assert(JSON.stringify(await fingerprints()) === JSON.stringify(beforeCheck), 'Offline check changed persistent data bytes.')
  console.log('PASS: offline JSON/SQLite checks preserve data, validate credentials, and refuse mistaken paths or a live instance.')
  apiProcess = startApi(restoredDir, ownerKeyHash, undefined, oldRing)
  await waitForHealth()
  const restoredOwner = await ownerHeaders()
  const restoredSnapshot = await request('/api/workflow', { headers: restoredOwner })
  const restoredProviders = await request('/api/providers', { headers: restoredOwner })
  const restoredMember = await loginViewer(rotate.result)
  assert(restoredSnapshot.result.runs.some((item) => item.id === normal.run.id) && restoredProviders.result.providers.DeepSeek.maskedApiKey.endsWith(apiKey.slice(-4)) && (await request('/api/member/workspace', { headers: restoredMember })).result.projects[0].id === multi.thread.projectId, 'Offline backup restore lost workflow data, provider credentials, or member authorization.')
  await stopProcess(apiProcess)
  const beforeRotation = await readFile(join(dataDir, 'providers.json'), 'utf8')
  assert(beforeRotation.includes('zhidian-v1.v1.') && !beforeRotation.includes(apiKey), 'Provider key was not encrypted under v1.')
  await waitForExit(startApi(dataDir, ownerKeyHash), 1)
  await waitForExit(startApi(dataDir, ownerKeyHash, undefined, newRing, ['--rotate-credentials']), 1)
  assert(await readFile(join(dataDir, 'providers.json'), 'utf8') === beforeRotation, 'A missing key changed provider settings.')
  await waitForExit(startApi(dataDir, ownerKeyHash, undefined, bothRing, ['--rotate-credentials']), 0)
  await copyFile(join(dataDir, 'providers.json'), join(mixedDir, 'providers.json'))
  const halfRotatedProvider = await readFile(join(mixedDir, 'providers.json'), 'utf8')
  assert(halfRotatedProvider.includes('zhidian-v1.v2.'), 'Provider rotation did not use v2.')
  await waitForExit(startApi(mixedDir, ownerKeyHash, undefined, newRing, ['--rotate-credentials']), 1)
  assert(await readFile(join(mixedDir, 'providers.json'), 'utf8') === halfRotatedProvider, 'Failed delivery preflight rewrote the provider file.')
  await waitForExit(startApi(mixedDir, ownerKeyHash, undefined, bothRing, ['--rotate-credentials']), 0)
  apiProcess = startApi(mixedDir, ownerKeyHash, undefined, newRing)
  await waitForHealth()
  const freshOwner = await ownerHeaders()
  const configured = await request('/api/providers', { headers: freshOwner })
  assert(configured.result.providers.DeepSeek.maskedApiKey.endsWith(apiKey.slice(-4)), 'Rotation lost the provider key.')
  assert((await request(`${vaultDelivery}/test`, { method: 'POST', headers: freshOwner })).response.status === 202, 'Rotated bot target could not be queued.')
  const deliveryDeadline = Date.now() + 6_000
  let delivered = false
  while (!delivered && Date.now() < deliveryDeadline) {
    const status = await request('/api/delivery', { headers: freshOwner })
    delivered = status.result.deliveries.some((item) => item.projectId === multi.thread.projectId && item.event === 'test' && item.status === 'sent')
    if (!delivered) await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert(delivered, 'Rotated bot credential did not reach the signed mock delivery.')
  console.log('PASS: offline SQLite backup restores runs and memberships; missing keys fail closed; interrupted two-store rotation retries and opens with v2 only.')
} finally {
  for (const child of children.reverse()) await stopProcess(child)
  await cleanupTestDirectory()
}

async function cleanupTestDirectory() {
  const resolvedTemp = await realpath(tempRoot)
  if (dirname(resolvedTemp) !== await realpath(tmpdir()) || !basename(resolvedTemp).startsWith('zhidian-e2e-')) throw new Error(`Unexpected test cleanup target: ${resolvedTemp}`)
  await rm(resolvedTemp, { recursive: true, force: true })
}

async function exists(path) {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}
