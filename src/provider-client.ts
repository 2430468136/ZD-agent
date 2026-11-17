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
