export const providerOptions = [
  { id: 'OpenAI', label: 'OpenAI', description: 'GPT 模型', baseUrl: 'https://api.openai.com/v1', keyRequired: true },
  { id: 'Anthropic', label: 'Anthropic', description: 'Claude 模型', baseUrl: 'https://api.anthropic.com', keyRequired: true },
  { id: 'DeepSeek', label: 'DeepSeek', description: 'DeepSeek 模型', baseUrl: 'https://api.deepseek.com', keyRequired: true },
  { id: 'OpenAI Compatible', label: '兼容接口', description: '自定义服务商', baseUrl: '', keyRequired: true },
  { id: 'Local', label: '本地模型', description: 'Ollama 等本机服务', baseUrl: 'http://localhost:11434/v1', keyRequired: false },
] as const

export type ProviderId = (typeof providerOptions)[number]['id']

export type ProviderStatus = {
  baseUrl: string
  hasApiKey: boolean
  maskedApiKey: string
}

export type ProviderStatuses = Record<ProviderId, ProviderStatus>

export type ExecutorCapabilities = {
  projectRead: string
  workspaceAccess: string
  fileWrite: string
  commandExecution: string
  networkAccess: string
  readOnlySpecialist?: 'snapshot-result-only'
}

export type HarnessStatus = {
  id: string
  name: string
  installed: boolean | null
  compatible: boolean
  status: 'connected' | 'login-required' | 'connection-unknown' | 'connection-error' | 'not-installed' | 'incompatible' | 'integration-pending' | string
  version: string | null
  minimumVersion?: string
  capabilities: string[]
  message?: string
}

export type ExecutorDefinition = {
  id: string
  name: string
  description: string
  provider: string
  defaultModel: string
  modelPlaceholder: string
  capabilities: ExecutorCapabilities
}

export type PlanningSkill = {
  name: string
  description: string
  verification: string
}

export type PlanningTask = {
  title: string
  brief: string
  channel: string
}

export type PlanningRun = {
  id: string
  status: 'running' | 'completed' | 'failed'
  mode: 'plan-only'
  agentName: string
  provider: ProviderId | string
  model: string
  taskTitle: string
  skillNames: string[]
  createdAt: string
  completedAt?: string
  output?: string
  error?: string
}

export type WorkflowAgentConfig = {
  name: string
  provider: ProviderId | string
  model: string
  skills: PlanningSkill[]
  executor?: string
  id?: string
}

export type ProjectAccessMode = 'read-only' | 'write' | 'execute'

export type WorkflowProject = {
  id: string
  name: string
  path: string
  accessMode: ProjectAccessMode
  allowedCommands: string[]
  verificationCommands?: string[]
  createdAt: string
  updatedAt: string
}

export type WorkflowSession = {
  id: string
  projectId: string
  threadId: string
  title: string
  status: string
  createdAt: string
  updatedAt: string
}

export type WorkflowThread = {
  id: string
  projectId: string
  projectName?: string
  title: string
  status: string
  messageCount?: number
  taskCount?: number
  lastMessage?: WorkflowMessage | null
  createdAt: string
  updatedAt: string
}

export type WorkflowMessage = {
  id: string
  threadId: string
  taskId?: string
  role: 'user' | 'assistant' | string
  content: string
  runId?: string
  createdAt: string
  updatedAt?: string
}

export type WorkflowThreadDetail = {
  thread: WorkflowThread
  messages: WorkflowMessage[]
  tasks: WorkflowTask[]
  runs: WorkflowRun[]
  reviews: WorkflowReview[]
}

export type WorkflowRun = {
  id: string
  taskId: string
  sessionId: string
  phase: 'ceo-plan' | 'specialist-execute' | 'qa-review' | string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | string
  mode: ProjectAccessMode
  agentName: string
  provider: ProviderId | string
  model: string
  taskTitle: string
  skillNames: string[]
  createdAt: string
  completedAt?: string
  output?: string
  error?: string
  plan?: Record<string, unknown>
  executor?: string
  harnessThreadId?: string
  harnessTurnId?: string
  agentId?: string
  subtask?: string
  execution?: WorkflowExecution
  review?: WorkflowReview
  events?: WorkflowEvent[]
}

export type WorkflowTask = {
  id: string
  sessionId: string
  threadId?: string
  title: string
  brief: string
  status: string
  executionMode: ProjectAccessMode
  createdAt: string
  updatedAt: string
  agents?: { ceo?: WorkflowAgentConfig; specialist?: WorkflowAgentConfig; specialists?: WorkflowAgentConfig[]; qa?: WorkflowAgentConfig }
  specialists?: WorkflowAgentConfig[]
  currentSpecialistIndex?: number
  contextSnapshot?: WorkflowContextEntry[]
  plan?: Record<string, unknown> | null
  execution?: WorkflowExecution | null
  reviewId?: string | null
  reworkNote?: string
  nextRunId?: string
}

export type WorkflowExecution = {
  summary?: string
  writtenFiles?: string[]
  commandResults?: Array<{ command: string; exitCode: number | null; skipped?: boolean; timedOut?: boolean; stdout?: string; stderr?: string }>
  acceptanceNotes?: string[]
  specialists?: Array<{ agentId?: string; agentName: string; executor: string; summary: string; writtenFiles: string[]; commandResults: Array<{ command: string; exitCode: number | null; skipped?: boolean; timedOut?: boolean; stdout?: string; stderr?: string }>; acceptanceNotes: string[] }>
  verificationResults?: Array<{ command: string; exitCode: number | null; timedOut?: boolean; stdout?: string; stderr?: string }>
}

export type WorkflowReview = {
  id: string
  taskId: string
  runId: string
  status: 'passed' | 'failed' | string
  summary: string
  checks: Array<{ name: string; passed: boolean; evidence?: string }>
  followups: string[]
  verificationResults?: WorkflowExecution['verificationResults']
  decision?: { value: DeliveryDecision; decidedAt: string; note?: string }
  createdAt: string
}

export type DeliveryDecision = 'approve' | 'return'

export type WorkflowEvent = {
  id?: string
  runId?: string
  at?: string
  type: string
  message?: string
  nextRunId?: string
  run?: WorkbenchRun
  nextRun?: WorkbenchRun
  plan?: Record<string, unknown>
  execution?: WorkflowExecution
  review?: WorkflowReview
}

export type WorkflowContextEntry = {
  id: string
  scope: 'personal' | 'project'
  projectId?: string
  title: string
  content: string
  tags: string[]
  createdAt: string
  updatedAt: string
}

export type WorkbenchTask = Pick<WorkflowTask, 'id' | 'threadId' | 'title' | 'brief' | 'status' | 'executionMode' | 'updatedAt'> & {
  projectId?: string
  projectPath?: string
  filesWritten: number
}

export type WorkbenchRun = Pick<WorkflowRun, 'id' | 'taskId' | 'taskTitle' | 'phase' | 'status' | 'agentId' | 'agentName'> & { projectId?: string }
export type WorkbenchRunDetail = { run: WorkflowRun; project: Pick<WorkflowProject, 'id' | 'name'> | null }

export type WorkbenchSnapshot = {
  deliveryAlerts: DeliveryAlert[]
  projects: WorkflowProject[]
  tasks: WorkbenchTask[]
  activeRuns: WorkbenchRun[]
  recentRuns: WorkbenchRun[]
  activeTaskCount: number
  approvalQueue: { count: number; preview: WorkbenchTask[] }
  threadCount: number
  latestThreadId: string | null
  hasScheduleSources: boolean
}

export type WorkbenchTaskDetail = {
  summary: WorkbenchTask
  task: WorkflowTask
  runs: WorkflowRun[]
  review: WorkflowReview | null
}

export type HistoryPage<T> = { items: T[]; next: string | null }

async function sendRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-zhidian-client': 'web-ui',
      ...init.headers,
    },
  })
  if (response.status === 401 && !path.startsWith('/api/auth/')) window.dispatchEvent(new Event('zhidian-session-expired'))
  return response
}

async function parseResponse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `本地服务请求失败（${response.status}）。`)
  return body as T
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  return parseResponse<T>(await sendRequest(path, init))
}

export type AuthStatus = { required: boolean; signedIn: boolean; role?: 'owner' | 'viewer' }

export function loadLocalAuth() {
  return request<AuthStatus>('/api/auth/status')
}

export function loginLocal(key: string, memberId?: string) {
  return request('/api/auth/login', { method: 'POST', body: JSON.stringify({ key, memberId }) })
}

export function logoutLocal() {
  return request('/api/auth/logout', { method: 'POST' })
}

export type ProjectMember = { id: string; name: string; projectIds: string[]; enabled: boolean }
export type MemberTaskStatus = { id: string; status: string; updatedAt: string; projectId: string; projectName: string; threadTitle: string }
export type MemberHistoryKind = 'threads' | 'runs' | 'schedules' | 'deliveries'
export type MemberHistory = HistoryPage<{ id: string; title: string; status: string; at?: string; taskId?: string }> & {
  projects: { id: string; name: string }[]
  projectId: string | null
  kind: MemberHistoryKind
}

export function loadMemberTaskStatus(id: string, signal: AbortSignal) {
  return request<MemberTaskStatus>(`/api/member/tasks/${encodeURIComponent(id)}`, { signal })
}

export function loadMembers() { return request<{ members: ProjectMember[] }>('/api/members') }

export function saveMember(input: Omit<ProjectMember, 'id'> & { rotateKey?: boolean }, id?: string) {
  return request<{ member: ProjectMember; accessKey?: string }>(id ? `/api/members/${encodeURIComponent(id)}` : '/api/members', { method: id ? 'PUT' : 'POST', body: JSON.stringify(input) })
}

export async function loadMemberHistory(params: string, signal: AbortSignal, etag?: string) {
  const response = await sendRequest(`/api/member/history?${params}`, { signal, headers: etag ? { 'if-none-match': etag } : {} })
  return { etag: response.headers.get('etag') ?? undefined, snapshot: response.status === 304 ? null : await parseResponse<MemberHistory>(response) }
}

export function loadHarnessStatuses() {
  return request<{ harnesses: HarnessStatus[] }>('/api/harnesses').then((result) => result.harnesses)
}

export function loadExecutorCatalog() {
  return request<{ executors: ExecutorDefinition[] }>('/api/executors').then((result) => result.executors)
}

export function loadProviderStatuses() {
  return request<{ providers: ProviderStatuses }>('/api/providers').then((result) => result.providers)
}

export function saveProvider(id: ProviderId, body: { baseUrl: string; apiKey?: string; clearApiKey?: boolean }) {
  return request<{ saved: boolean; hasApiKey: boolean }>(`/api/providers/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

export function deleteProviderKey(id: ProviderId) {
  return request<{ deleted: boolean }>(`/api/providers/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function testProviderConnection(id: ProviderId, body: { baseUrl: string; model: string; apiKey?: string }) {
  return request<{ message: string; latencyMs: number }>(`/api/providers/${encodeURIComponent(id)}/test`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function createPlanningRun(body: { agentName: string; provider: ProviderId; model: string; task: PlanningTask; skills: PlanningSkill[] }) {
  return request<{ run: PlanningRun }>('/api/runs/plan', {
    method: 'POST',
    body: JSON.stringify(body),
  }).then((result) => result.run)
}

export function loadPlanningRuns() {
  return request<{ runs: PlanningRun[] }>('/api/runs').then((result) => result.runs)
}

export async function loadWorkbench(etag?: string) {
  const response = await sendRequest('/api/workbench', { headers: etag ? { 'if-none-match': etag } : {} })
  return {
    etag: response.headers.get('etag') ?? undefined,
    snapshot: response.status === 304 ? null : await parseResponse<WorkbenchSnapshot>(response),
  }
}

export function loadTaskHistory(params: URLSearchParams, signal: AbortSignal) {
  return request<HistoryPage<WorkbenchTask>>(`/api/workbench/tasks?${params}`, { signal })
}

export function loadThreadHistory(params: URLSearchParams, signal: AbortSignal) {
  return request<HistoryPage<WorkflowThread>>(`/api/workbench/threads?${params}`, { signal })
}

export function loadTaskDetail(taskId: string, signal: AbortSignal) {
  return request<WorkbenchTaskDetail>(`/api/workbench/tasks/${encodeURIComponent(taskId)}`, { signal })
}

export function loadRunDetail(runId: string, signal: AbortSignal) {
  return request<WorkbenchRunDetail>(`/api/workbench/runs/${encodeURIComponent(runId)}`, { signal })
}

export function loadThreadDetail(threadId: string) {
  return request<WorkflowThreadDetail>(`/api/threads/${encodeURIComponent(threadId)}`)
}

export type Recurrence = { kind: 'once'; runAt: string; timezone?: string } | { kind: 'daily' | 'weekly'; time: string; timezone: string; days?: number[] }

export type ScheduleInput = {
  sourceTaskId: string
  title: string
  brief: string
  recurrence: Recurrence
  enabled: boolean
  misfire: 'skip' | 'run-once'
  maxRetries: number
  timeoutMs: number
}

export type WorkSchedule = ScheduleInput & {
  id: string
  projectId: string
  projectName: string
  sourceTaskTitle?: string
  nextRunAt: string | null
  requiresAuthorization: boolean
  agentNames: string[]
}

export type WorkOccurrence = {
  id: string
  scheduleId: string
  status: string
  scheduledFor: string
  error?: string
  retryAt?: string
  taskIds: string[]
}

export function loadSchedules() {
  return request<{ schedules: WorkSchedule[]; occurrences: WorkOccurrence[] }>('/api/schedules')
}

export function saveSchedule(body: Partial<ScheduleInput>, id?: string) {
  return request<{ schedule: WorkSchedule }>(id ? `/api/schedules/${encodeURIComponent(id)}` : '/api/schedules', { method: id ? 'PUT' : 'POST', body: JSON.stringify(body) })
}

export function deleteSchedule(id: string) {
  return request(`/api/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function runScheduleNow(id: string, requestId: string) {
  return request(`/api/schedules/${encodeURIComponent(id)}/run-now`, { method: 'POST', body: JSON.stringify({ requestId }) })
}

export function cancelScheduleOccurrence(id: string) {
  return request(`/api/occurrences/${encodeURIComponent(id)}/cancel`, { method: 'POST' })
}

export type DeliveryTarget = {
  projectId: string
  channel: 'feishu' | 'lark'
  events: string[]
  enabled: boolean
  hasSigningSecret: boolean
  includeTaskLink: boolean
}

export type DeliveryRecord = {
  id: string
  projectId: string
  channel: DeliveryTarget['channel']
  event: string
  status: string
  attempts: number
  updatedAt: string
  retryAt?: string
  error?: string
  taskId?: string
}

export type DeliveryAlert = { projectId: string; failed: number; unknown: number }

export function loadDelivery(projectId: string, signal: AbortSignal) {
  return request<{ targets: DeliveryTarget[]; deliveries: DeliveryRecord[] }>(`/api/delivery?projectId=${encodeURIComponent(projectId)}`, { signal })
}

export function saveDelivery(id: string, body: Partial<Pick<DeliveryTarget, 'channel' | 'events' | 'enabled' | 'includeTaskLink'>> & { webhook?: string; signingSecret?: string }) {
  return request<{ target: DeliveryTarget }>(`/api/delivery/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) })
}

export function revokeDelivery(id: string) {
  return request(`/api/delivery/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function testDelivery(id: string) {
  return request(`/api/delivery/${encodeURIComponent(id)}/test`, { method: 'POST' })
}

export type InboundTarget = {
  projectId: string
  channel: 'feishu' | 'lark'
  enabled: boolean
  allowedUsers: string[]
  allowedChats: string[]
  intents: string[]
  appId: string
  tenantKey: string
  hasVerificationToken: boolean
  hasEncryptKey: boolean
  hasAppSecret?: boolean
}

export type InboundEvent = {
  id: string
  projectId: string
  channel: InboundTarget['channel']
  status: string
  intent?: string | null
  userId?: string
  chatId?: string
  taskId?: string | null
  threadId?: string | null
  taskStatus?: string
  draft?: { title?: string; brief?: string; message?: string }
  createdAt: string
  updatedAt: string
}

export function loadInbound(projectId: string) {
  return request<{ enabled: boolean; targets: InboundTarget[]; events: InboundEvent[] }>(`/api/inbound?projectId=${encodeURIComponent(projectId)}`)
}

export function saveInbound(id: string, body: Partial<InboundTarget> & { verificationToken?: string; encryptKey?: string; appSecret?: string; clearAppSecret?: boolean }) {
  return request<{ target: InboundTarget }>(`/api/inbound/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) })
}

export function revokeInbound(id: string) {
  return request(`/api/inbound/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function decideInbound(id: string, decision: 'accept' | 'dismiss', sourceTaskId?: string) {
  return request<{ event: InboundEvent }>(`/api/inbound/requests/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify({ decision, sourceTaskId }) })
}

const pendingWorkflowStorageKey = 'zhidian-pending-workflow-v1'
const pendingWorkflowLimit = 32
type WorkflowReceipt = { thread: WorkflowThread; session: WorkflowSession; task: WorkflowTask; run: WorkflowRun }

function restorePendingWorkflowRequests() {
  const pending = new Map<string, string>()
  try {
    const records: unknown = JSON.parse(window.sessionStorage.getItem(pendingWorkflowStorageKey) ?? '[]')
    if (!Array.isArray(records)) return pending
    for (const pair of records.slice(-pendingWorkflowLimit)) {
      if (Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && /^[0-9a-f]{64}$/.test(pair[0]) && typeof pair[1] === 'string' && /^[0-9a-f-]{36}$/.test(pair[1])) {
        pending.set(pair[0], pair[1])
      }
    }
  } catch { /* Browser storage is optional. */ }
  return pending
}

const pendingWorkflowRequests = restorePendingWorkflowRequests()

function savePendingWorkflowRequests() {
  try {
    if (pendingWorkflowRequests.size) window.sessionStorage.setItem(pendingWorkflowStorageKey, JSON.stringify([...pendingWorkflowRequests]))
    else window.sessionStorage.removeItem(pendingWorkflowStorageKey)
  } catch { /* Same-page retries still use the in-memory map. */ }
}

async function submitWorkflowRequest(path: string, payload: object) {
  const body = JSON.stringify(payload)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${path}\n${body}`))
  const fingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  const previous = pendingWorkflowRequests.get(fingerprint)
  const key = previous ?? crypto.randomUUID()
  if (pendingWorkflowRequests.size >= pendingWorkflowLimit && !previous) pendingWorkflowRequests.delete(pendingWorkflowRequests.keys().next().value!)
  pendingWorkflowRequests.set(fingerprint, key)
  savePendingWorkflowRequests()
  const response = await sendRequest(path, {
    method: 'POST', body, headers: { 'idempotency-key': key },
  })
  const result = await parseResponse<WorkflowReceipt>(response)
  if (response.status !== 202 || ![result?.thread, result?.session, result?.task, result?.run].every((record) => typeof record?.id === 'string' && record.id)) {
    throw new Error('未收到有效的任务提交回执。')
  }
  if (pendingWorkflowRequests.get(fingerprint) === key) {
    pendingWorkflowRequests.delete(fingerprint)
    savePendingWorkflowRequests()
  }
  return result
}

export function followupThread(threadId: string, message: string) {
  return submitWorkflowRequest(`/api/threads/${encodeURIComponent(threadId)}/followups`, { message })
}

export function loadContextEntries() {
  return request<{ entries: WorkflowContextEntry[] }>('/api/context').then((result) => result.entries)
}

export function saveContextEntry(body: Pick<WorkflowContextEntry, 'scope' | 'title' | 'content' | 'tags'> & { projectId?: string }, id?: string) {
  return request<{ entry: WorkflowContextEntry }>(id ? `/api/context/${encodeURIComponent(id)}` : '/api/context', {
    method: id ? 'PUT' : 'POST',
    body: JSON.stringify(body),
  }).then((result) => result.entry)
}

export function deleteContextEntry(id: string) {
  return request<{ deleted: boolean }>(`/api/context/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function registerProject(body: { name?: string; path: string; accessMode: ProjectAccessMode; allowedCommands: string[]; verificationCommands?: string[] }) {
  return request<{ project: WorkflowProject }>('/api/projects', {
    method: 'POST',
    body: JSON.stringify(body),
  }).then((result) => result.project)
}

export function startWorkflow(body: {
  projectId: string
  title: string
  brief: string
  agents: { ceo: WorkflowAgentConfig; specialists?: WorkflowAgentConfig[]; specialist?: WorkflowAgentConfig; qa: WorkflowAgentConfig }
}) {
  return submitWorkflowRequest('/api/workflow/start', body)
}

export function decideWorkflowDelivery(taskId: string, reviewId: string, decision: DeliveryDecision, note?: string) {
  return request<{ task: WorkflowTask; review: WorkflowReview }>(`/api/workflow/${encodeURIComponent(taskId)}/decision`, {
    method: 'POST',
    body: JSON.stringify({ reviewId, decision, note }),
  })
}

export function retryWorkflowPhase(taskId: string, phase: 'plan' | 'execute' | 'review', body: WorkflowAgentConfig) {
  return request<{ run: WorkflowRun; task: WorkflowTask }>(`/api/workflow/${encodeURIComponent(taskId)}/${phase}`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function cancelWorkflowRun(runId: string) {
  return request<{ cancelled?: boolean; cancellationRequested?: boolean; run: WorkflowRun; task?: WorkflowTask }>(`/api/runs/${encodeURIComponent(runId)}/cancel`, {
    method: 'POST',
  })
}

export function startSpecialistExecution(taskId: string, body: WorkflowAgentConfig) {
  return request<{ run: WorkflowRun; task: WorkflowTask }>(`/api/workflow/${encodeURIComponent(taskId)}/execute`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function startReview(taskId: string, body: WorkflowAgentConfig) {
  return request<{ run: WorkflowRun; task: WorkflowTask }>(`/api/workflow/${encodeURIComponent(taskId)}/review`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function subscribeWorkflowRun(runId: string, onEvent: (event: WorkflowEvent) => void, onError?: () => void) {
  const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events?view=summary`)
  source.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data) as WorkflowEvent)
    } catch {
      // Ignore malformed events; the persisted workflow remains the source of truth.
    }
  }
  source.onerror = () => onError?.()
  return () => source.close()
}
