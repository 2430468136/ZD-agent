const MAX_ERROR_DETAIL = 320
export const deepSeekApiUrl = 'https://api.deepseek.com'
export const deepSeekDefaultModel = 'deepseek-flash'

export function isOfficialDeepSeekUrl(url) {
  return url === deepSeekApiUrl || url === `${deepSeekApiUrl}/v1`
}

function extractText(payload) {
  const content = payload?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) return content.map((item) => typeof item === 'string' ? item : typeof item?.text === 'string' ? item.text : '').join('').trim()
  return ''
}

export async function runDeepSeekApi({ baseUrl, apiKey, model, agentName = 'DeepSeek Agent', system, prompt, maxTokens = 1600, timeoutMs = 60_000, fetchImpl = fetch, onEvent = () => undefined, signal }) {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) throw new Error('请先在模型接入页配置 DeepSeek API 地址。')
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('请先在模型接入页保存 DeepSeek API Key。')
  if (typeof model !== 'string' || !model.trim()) throw new Error(`${agentName} 没有填写 DeepSeek Model ID。`)

  const base = baseUrl.trim().replace(/\/+$/, '')
  const modelId = model.trim()
  const official = isOfficialDeepSeekUrl(base)
  const endpoint = `${base}/chat/completions`
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }
  const payload = {
    model: modelId,
    temperature: 0.15,
    max_tokens: maxTokens,
    ...(official && { thinking: { type: 'disabled' } }),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ],
  }
  onEvent({ type: 'provider.requested', message: `正在调用 DeepSeek（${modelId}）。` })

  let response
  let responseBody
  const deadline = AbortSignal.timeout(timeoutMs)
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: requestSignal,
    })
    responseBody = await response.json().catch(() => {
      requestSignal.throwIfAborted()
      return null
    })
    requestSignal.throwIfAborted()
  } catch (error) {
    if (signal?.aborted) throw Object.assign(new Error(`${agentName} DeepSeek 请求已取消。`), { name: 'AbortError', code: 'ABORT_ERR', status: 499 })
    if (deadline.aborted || error?.name === 'TimeoutError') throw Object.assign(new Error(`${agentName} DeepSeek 请求超时。`), { name: 'TimeoutError', status: 504 })
    const message = typeof error?.message === 'string' ? error.message.replaceAll(apiKey, '[已隐藏]') : '网络错误'
    throw Object.assign(new Error(`${agentName} 无法连接 DeepSeek：${message}`), { status: 502 })
  }

  if (!response.ok) {
    const detail = responseBody?.error?.message ?? responseBody?.message
    const safeDetail = typeof detail === 'string'
      ? detail.replaceAll(apiKey, '[已隐藏]').slice(0, MAX_ERROR_DETAIL)
      : `服务商返回 HTTP ${response.status}。`
    throw Object.assign(new Error(`${agentName} DeepSeek 请求失败：${safeDetail}`), { status: 502 })
  }

  const output = extractText(responseBody)
  if (!output) throw Object.assign(new Error(`${agentName} 从 DeepSeek 收到空结果。`), { status: 502 })
  onEvent({ type: 'provider.completed', message: `DeepSeek（${modelId}）已返回结果。` })
  return { output, executor: 'deepseek-api', provider: 'DeepSeek', model: modelId }
}
