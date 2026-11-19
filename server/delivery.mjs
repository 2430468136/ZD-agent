import { createHmac } from 'node:crypto'

export const deliveryEvents = ['approved', 'failed', 'needs-fix', 'cancelled']
const labels = { approved: '验收通过', failed: '运行失败', 'needs-fix': '验收未通过', cancelled: '运行已取消', test: '测试通知' }
const hosts = { feishu: 'open.feishu.cn', lark: 'open.larksuite.com' }

export function validateBotUrl(channel, value) {
  const host = hosts[channel]
  let url
  try { url = new URL(value) } catch { throw new Error('请输入官方机器人 Webhook 地址。') }
  if (!Object.hasOwn(hosts, channel) || url.protocol !== 'https:' || url.host !== host || url.username || url.password || url.search || url.hash || !/^\/open-apis\/bot\/v2\/hook\/[a-z0-9_-]{8,128}$/i.test(url.pathname)) {
    throw new Error('仅接受所选渠道官方 HTTPS 机器人 Webhook 地址。')
  }
  return url.href
}

export function buildBotPayload(item, secret, time = Date.now(), workbenchOrigin) {
  if (!Object.hasOwn(labels, item.event)) throw new Error('不支持的通知事件。')
  const taskId = item.event !== 'test' && /^[a-zA-Z0-9-]{1,100}$/.test(item.taskId ?? '') ? item.taskId : null
  const title = `织点 | ${labels[item.event]}`
  const taskNumber = `任务编号：${taskId}`
  let payload = { msg_type: 'text', content: { text: taskId ? `${title}\n${taskNumber}` : title } }
  if (taskId && workbenchOrigin?.protocol === 'https:') {
    const link = new URL('/', workbenchOrigin.origin)
    link.hash = new URLSearchParams({ task: taskId }).toString()
    payload = { msg_type: 'post', content: { post: { zh_cn: { title, content: [
      [{ tag: 'text', text: taskNumber }],
      [{ tag: 'a', text: '打开织点任务', href: link.href }],
    ] } } } }
  }
  if (secret) {
    payload.timestamp = String(Math.floor(time / 1000))
    payload.sign = createHmac('sha256', `${payload.timestamp}\n${secret}`).digest('base64')
  }
  return payload
}

async function smallJson(response) {
  if (!response.body) return null
  const reader = response.body.getReader()
  const parts = []
  let bytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.length
    if (bytes > 8_192) { await reader.cancel(); return null }
    parts.push(Buffer.from(value))
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')) } catch { return null }
}

const rateLimited = (retryAfter) => ({ status: 'retry-wait', error: '渠道限流，等待重试。', delayMs: Math.max(15_000, Math.min(300_000, retryAfter || 0)) })

export async function transmitBot(config, item, { fetchImpl = fetch, time = Date.now(), signal = AbortSignal.timeout(12_000), workbenchOrigin } = {}) {
  const url = validateBotUrl(config.channel, config.url)
  try {
    const response = await fetchImpl(url, {
      method: 'POST', redirect: 'manual', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(buildBotPayload(item, config.secret, time, workbenchOrigin)),
    })
    if (response.status === 429) {
      await response.body?.cancel()
      const retryAfter = response.headers.get('retry-after')
      return rateLimited(/^\d+$/.test(retryAfter ?? '') ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - time)
    }
    if (!response.ok) {
      await response.body?.cancel()
      return { status: response.status >= 500 ? 'unknown' : 'failed', error: `渠道返回 HTTP ${response.status}。` }
    }
    const result = await smallJson(response)
    const code = result?.code ?? result?.StatusCode
    if (code === 0) return { status: 'sent', error: null }
    if ([11232, 9499, 230020].includes(code)) return rateLimited()
    if (!Number.isInteger(code)) return { status: 'unknown', error: '未收到可确认的渠道回执。' }
    return { status: 'failed', error: `渠道拒绝通知（${code}）。` }
  } catch {
    return { status: 'unknown', error: '渠道网络结果不明确，未自动重发。' }
  }
}

export function nextDeliveryState(item, result, time = Date.now()) {
  const retry = result.status === 'retry-wait' && item.attempts < 4
  return {
    status: retry ? 'retry-wait' : result.status === 'retry-wait' ? 'failed' : result.status,
    error: result.status === 'retry-wait' && !retry ? '渠道持续限流，重试次数已用完。' : result.error,
    retryAt: retry ? new Date(time + Math.max(result.delayMs, 15_000 * 2 ** (item.attempts - 1))).toISOString() : null,
    updatedAt: new Date(time).toISOString(),
  }
}

export async function transmitInboundReply(config, item, { fetchImpl = fetch, signal = AbortSignal.timeout(12_000), time = Date.now() } = {}) {
  const host = Object.hasOwn(hosts, config.channel) && hosts[config.channel]
  if (!host || !config.appSecret || !/^om_[A-Za-z0-9_-]{1,100}$/.test(item.messageId)) return { status: 'failed', error: '应用回复配置无效。' }
  const origin = `https://${host}/open-apis`
  const headers = { 'content-type': 'application/json' }
  const post = (url, text, extraHeaders) => fetchImpl(`${origin}${url}`, {
    method: 'POST', redirect: 'manual', signal, headers: { ...headers, ...extraHeaders }, body: JSON.stringify(text),
  })
  const throttled = async (response) => {
    await response.body?.cancel()
    const after = response.headers.get('retry-after')
    return rateLimited(/^\d+$/.test(after ?? '') ? Number(after) * 1000 : Date.parse(after) - time)
  }
  let sendingReply = false
  try {
    const auth = await post('/auth/v3/tenant_access_token/internal', { app_id: config.appId, app_secret: config.appSecret })
    if (auth.status === 429) return throttled(auth)
    const credential = await smallJson(auth)
    const token = credential?.tenant_access_token
    if (!auth.ok || credential?.code !== 0 || typeof token !== 'string' || !/^[A-Za-z0-9_.-]{1,2048}$/.test(token)) return { status: 'failed', error: '无法获取应用访问令牌。' }
    sendingReply = true
    const result = await post(`/im/v1/messages/${item.messageId}/reply`, {
      msg_type: 'text', content: JSON.stringify({ text: item.replyText }), reply_in_thread: true, uuid: item.replyUuid,
    }, { authorization: `Bearer ${token}` })
    if (result.status === 429) return throttled(result)
    const reply = await smallJson(result)
    if (result.ok && reply?.code === 0) return { status: 'sent', error: null }
    if ([11232, 9499, 230020].includes(reply?.code)) return rateLimited()
    if (result.status >= 500 || (result.ok && !Number.isInteger(reply?.code))) return { status: 'unknown', error: '渠道未确认回复结果。' }
    return { status: 'failed', error: '渠道拒绝应用回复。' }
  } catch {
    return sendingReply ? { status: 'unknown', error: '渠道未确认回复结果。' } : { status: 'failed', error: '无法连接应用认证服务。' }
  }
}
