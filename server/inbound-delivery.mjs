import { createHash, createDecipheriv, timingSafeEqual } from 'node:crypto'

export const inboundIntents = ['create', 'status', 'approve', 'reply']
const clockSkew = 300_000
const externalId = /^[A-Za-z0-9_-]{1,128}$/
const authError = () => Object.assign(new Error('入站认证失败。'), { status: 401 })
const isRecord = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const matchesToken = (actual, expected) => typeof actual === 'string' && timingSafeEqual(
  createHash('sha256').update(actual).digest(), createHash('sha256').update(expected).digest(),
)

function externalIds(values) {
  if (!Array.isArray(values) || values.length > 64 || values.some((value) => typeof value !== 'string' || !externalId.test(value))) {
    throw new Error('用户或群聊 ID 格式不正确。')
  }
  return [...new Set(values)]
}

export function normalizeInboundSettings(input, previous) {
  if (!isRecord(input)) throw new Error('入站配置无效。')
  const channel = input.channel ?? previous?.channel
  const enabled = input.enabled ?? previous?.enabled ?? false
  const allowedUsers = externalIds(input.allowedUsers ?? previous?.allowedUsers ?? [])
  const allowedChats = externalIds(input.allowedChats ?? previous?.allowedChats ?? [])
  const intents = input.intents ?? previous?.intents ?? ['status']
  const appId = input.appId ?? previous?.appId
  const tenantKey = input.tenantKey ?? previous?.tenantKey
  if (!['feishu', 'lark'].includes(channel) || typeof enabled !== 'boolean') throw new Error('入站渠道或开关无效。')
  if (![appId, tenantKey].every((id) => typeof id === 'string' && externalId.test(id))) throw new Error('请配置应用 ID 和租户 Key。')
  if (!allowedUsers.length && !allowedChats.length) throw new Error('至少配置一个允许的用户或群聊身份。')
  if (!Array.isArray(intents) || !intents.length || intents.length > inboundIntents.length || intents.some((intent) => !inboundIntents.includes(intent))) throw new Error('入站意图配置无效。')
  return { channel, enabled, allowedUsers, allowedChats, intents: [...new Set(intents)], appId, tenantKey }
}

export function buildInboundSignature(timestamp, nonce, encryptKey, rawBody) {
  return createHash('sha256').update(`${timestamp}${nonce}${encryptKey}`).update(rawBody).digest('hex')
}

function verifyInboundSignature(headers, rawBody, encryptKey, time) {
  const { 'x-lark-request-timestamp': timestamp, 'x-lark-request-nonce': nonce, 'x-lark-signature': signature } = headers
  if ([timestamp, nonce, signature].every((value) => value === undefined)) return false
  if (!/^\d{10}$/.test(timestamp ?? '') || typeof nonce !== 'string' || !externalId.test(nonce) || !/^[a-f0-9]{64}$/.test(signature ?? '')) throw authError()
  if (Math.abs(time - Number(timestamp) * 1000) > clockSkew) throw authError()
  const expected = buildInboundSignature(timestamp, nonce, encryptKey, rawBody)
  if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'))) throw authError()
  return true
}

export function decodeInboundPayload({ rawBody, headers, verificationToken, encryptKey, now = Date.now() }) {
  const signed = verifyInboundSignature(headers, rawBody, encryptKey, now)
  let payload
  try {
    payload = JSON.parse(rawBody.toString('utf8'))
    if (typeof payload?.encrypt === 'string') {
      const bytes = Buffer.from(payload.encrypt, 'base64')
      if (bytes.toString('base64') !== payload.encrypt || bytes.length <= 16 || bytes.length % 16 !== 0) throw authError()
      const key = createHash('sha256').update(encryptKey).digest()
      const decipher = createDecipheriv('aes-256-cbc', key, bytes.subarray(0, 16))
      payload = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(16)), decipher.final()]).toString('utf8'))
    }
    if (!isRecord(payload)) throw authError()
  } catch { throw authError() }
  if (payload.type === 'url_verification') {
    if (typeof payload.challenge !== 'string' || !payload.challenge || payload.challenge.length > 512 || !matchesToken(payload.token, verificationToken)) throw authError()
    return { kind: 'challenge', challenge: payload.challenge }
  }
  if (!signed || payload.schema !== '2.0' || !matchesToken(payload.header?.token, verificationToken)) throw authError()
  return { kind: 'event', payload }
}

export function extractInboundMessage({ header, event }, settings, time = Date.now()) {
  if (header.app_id !== settings.appId || header.tenant_key !== settings.tenantKey) throw authError()
  if (header.event_type !== 'im.message.receive_v1') return null
  const eventId = header.event_id
  const sentAt = /^\d{13}$/.test(header.create_time ?? '') ? Number(header.create_time) : NaN
  if (typeof eventId !== 'string' || !externalId.test(eventId) || !Number.isFinite(sentAt) || sentAt < time - 3_600_000 || sentAt > time + clockSkew) throw authError()
  const { message, sender } = event ?? {}
  if (sender?.sender_type !== 'user' || message?.message_type !== 'text') return null
  const userId = sender.sender_id?.open_id
  const chatId = message.chat_id
  if (![userId, chatId].every((id) => typeof id === 'string' && externalId.test(id))) throw authError()
  let text
  try { text = JSON.parse(message.content)?.text } catch { return null }
  if (typeof text !== 'string' || text.length > 4_000) return null
  const mention = Array.isArray(message.mentions) && message.mentions.find((item) => typeof item?.key === 'string' && item.key && text.startsWith(`${item.key} `))
  const messageId = typeof message.message_id === 'string' && /^om_[A-Za-z0-9_-]{1,100}$/.test(message.message_id) ? message.message_id : undefined
  return { eventId, userId, chatId, ...(messageId && { messageId }), text: mention ? text.slice(mention.key.length).trimStart() : text }
}

export function parseInboundCommand(text) {
  const value = text.trim()
  let match = value.match(/^\/?(?:status|状态|查询)\s+([A-Za-z0-9_-]{3,100})$/i)
  if (match) return { intent: 'status', taskId: match[1] }
  match = value.match(/^\/?(?:approve|批准|审批)\s+([A-Za-z0-9_-]{3,100})$/i)
  if (match) return { intent: 'approve', taskId: match[1] }
  match = value.match(/^\/?(?:reply|回复)\s+([A-Za-z0-9_-]{3,100})(?:\s*[:：]\s*|\s+)([\s\S]{1,3800})$/i)
  if (match?.[2].trim()) return { intent: 'reply', threadId: match[1], message: match[2].trim() }
  match = value.match(/^\/?(?:task|任务|创建任务)(?:\s*[:：]\s*|\s+)([\s\S]{1,3800})$/i)
  if (match?.[1].trim()) {
    const [firstLine, ...rest] = match[1].trim().split(/\r?\n/)
    return { intent: 'create', title: firstLine.trim().slice(0, 200), brief: rest.join('\n').trim() }
  }
  return null
}

export function identityAllowed({ allowedUsers, allowedChats }, { userId, chatId }) {
  return Boolean(allowedUsers.length || allowedChats.length) &&
    (!allowedUsers.length || allowedUsers.includes(userId)) && (!allowedChats.length || allowedChats.includes(chatId))
}

export function inboundEventRecordId(projectId, appId, tenantKey, eventId) {
  const digest = createHash('sha256').update(JSON.stringify([projectId, appId, tenantKey, eventId])).digest('hex')
  return `inbound-${digest}`
}

export function publicInboundTarget({ encryptedCredentials: _encryptedCredentials, revision: _revision, ...target }) {
  return target
}

export function publicInboundEvent({ revision: _revision, grant: _grant, ...event }) {
  return event
}
