export const providerOptions = [
  { id: 'OpenAI', label: 'OpenAI', description: 'GPT 模型', baseUrl: 'https://api.openai.com/v1', keyRequired: true },
  { id: 'Anthropic', label: 'Anthropic', description: 'Claude 模型', baseUrl: 'https://api.anthropic.com', keyRequired: true },
  { id: 'DeepSeek', label: 'DeepSeek', description: 'DeepSeek 模型', baseUrl: 'https://api.deepseek.com/v1', keyRequired: true },
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
}

export type ProjectAccessMode = 'read-only' | 'write' | 'execute'

export type WorkflowProject = {
  id: string
  name: string
  path: string
  accessMode: ProjectAccessMode
  allowedCommands: string[]
  createdAt: string
  updatedAt: string
}

export type WorkflowSession = {
  id: string
  projectId: string
  title: string
  status: string
  createdAt: string
  updatedAt: string
}

export type WorkflowRun = {
  id: string
  taskId: string
  sessionId: string
  phase: 'ceo-plan' | 'specialist-execute' | 'qa-review' | string
  status: 'queued' | 'running' | 'completed' | 'failed' | string
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
  execution?: WorkflowExecution
  review?: WorkflowReview
  events?: WorkflowEvent[]
}

export type WorkflowTask = {
  id: string
  sessionId: string
  title: string
  brief: string
  status: string
  executionMode: ProjectAccessMode
  createdAt: string
  updatedAt: string
  agents?: Record<string, WorkflowAgentConfig>
  plan?: Record<string, unknown> | null
  execution?: WorkflowExecution | null
  reviewId?: string | null
  nextRunId?: string
}

export type WorkflowExecution = {
  summary?: string
  writtenFiles?: string[]
  commandResults?: Array<{ command: string; exitCode: number | null; skipped?: boolean; timedOut?: boolean; stdout?: string; stderr?: string }>
  acceptanceNotes?: string[]
}

export type WorkflowReview = {
  id: string
  taskId: string
  runId: string
  status: 'passed' | 'failed' | string
  summary: string
  checks: Array<{ name: string; passed: boolean; evidence?: string }>
  followups: string[]
  createdAt: string
}

export type WorkflowEvent = {
  id?: string
  runId?: string
  at?: string
  type: string
  message?: string
  nextRunId?: string
  run?: WorkflowRun
  plan?: Record<string, unknown>
  execution?: WorkflowExecution
  review?: WorkflowReview
}

export type WorkflowSnapshot = {
  projects: WorkflowProject[]
  sessions: WorkflowSession[]
  tasks: WorkflowTask[]
  runs: WorkflowRun[]
  reviews: WorkflowReview[]
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-zhidian-client': 'web-ui',
      ...init.headers,
    },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `本地服务请求失败（${response.status}）。`)
  return body as T
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

export function loadWorkflow() {
  return request<WorkflowSnapshot>('/api/workflow')
}

export function registerProject(body: { name?: string; path: string; accessMode: ProjectAccessMode; allowedCommands: string[] }) {
  return request<{ project: WorkflowProject }>('/api/projects', {
    method: 'POST',
    body: JSON.stringify(body),
  }).then((result) => result.project)
}

export function startWorkflow(body: {
  projectId: string
  title: string
  brief: string
  agents: { ceo: WorkflowAgentConfig; specialist: WorkflowAgentConfig; qa: WorkflowAgentConfig }
}) {
  return request<{ session: WorkflowSession; task: WorkflowTask; run: WorkflowRun }>('/api/workflow/start', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function retryWorkflowPhase(taskId: string, phase: 'plan' | 'execute' | 'review', body: WorkflowAgentConfig) {
  return request<{ run: WorkflowRun; task: WorkflowTask }>(`/api/workflow/${encodeURIComponent(taskId)}/${phase}`, {
    method: 'POST',
    body: JSON.stringify(body),
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
  const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events`)
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
