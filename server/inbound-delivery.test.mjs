import test from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, createHash } from 'node:crypto'
import { buildInboundSignature, decodeInboundPayload, extractInboundMessage, identityAllowed, inboundEventRecordId, normalizeInboundSettings, parseInboundCommand } from './inbound-delivery.mjs'

const now = 1_800_000_000_000
const verificationToken = 'fixture-verification-token'
const encryptKey = 'fixture-encrypt-key'
const settings = { appId: 'cli_app', tenantKey: 'tenant_1', channel: 'feishu', allowedUsers: ['ou_owner'], allowedChats: ['oc_team'] }
const payload = {
  schema: '2.0', header: { token: verificationToken, app_id: settings.appId, tenant_key: settings.tenantKey, event_id: 'event-1', event_type: 'im.message.receive_v1', create_time: String(now) },
  event: { sender: { sender_type: 'user', sender_id: { open_id: 'ou_owner' } }, message: { message_type: 'text', chat_id: 'oc_team', content: JSON.stringify({text: '状态 task-123'}) } },
}

function encrypt(value) {
  const iv = Buffer.alloc(16, 42)
  const cipher = createCipheriv('aes-256-cbc', createHash('sha256').update(encryptKey).digest(), iv)
  return Buffer.from(JSON.stringify({ encrypt: Buffer.concat([iv, cipher.update(JSON.stringify(value)), cipher.final()]).toString('base64') }))
}

function signed(rawBody, time = now) {
  const timestamp = String(Math.floor(time / 1000))
  const nonce = 'fixture-nonce'
  return { 'x-lark-request-timestamp': timestamp, 'x-lark-request-nonce': nonce, 'x-lark-signature': buildInboundSignature(timestamp, nonce, encryptKey, rawBody) }
}
const decode = (rawBody, headers = {}, extra = {}) => decodeInboundPayload({ rawBody, headers, verificationToken, encryptKey, now, ...extra })
const authFailure = (error) => error.status === 401

test('inbound event verifies exact bytes, timestamp, encrypted payload and verification token', () => {
  const body = encrypt(payload)
  const headers = signed(body)
  assert.deepEqual(decode(body, headers).payload, payload)
  assert.throws(() => decode(Buffer.concat([body, Buffer.from('\n')]), headers), authFailure)
  assert.throws(() => decode(body, signed(body, now - 600_000)), authFailure)
  assert.throws(() => decode(body), authFailure)
  assert.throws(() => decode(body, headers, { verificationToken: 'different-token' }), authFailure)
})

test('both challenge formats require the configured token and return only the challenge', () => {
  const body = { type: 'url_verification', token: verificationToken, challenge: 'challenge-value' }
  for (const encoded of [Buffer.from(JSON.stringify(body)), encrypt(body)]) {
    assert.deepEqual(decode(encoded), { kind: 'challenge', challenge: 'challenge-value' })
    assert.throws(() => decode(encoded, {}, { verificationToken: 'other' }), authFailure)
  }
})

test('inbound messages are scoped to the expected app and tenant, fresh and sent by users', () => {
  assert.deepEqual(extractInboundMessage(payload, settings, now), { eventId: 'event-1', userId: 'ou_owner', chatId: 'oc_team', text: '状态 task-123' })
  assert.throws(() => extractInboundMessage(payload, { ...settings, tenantKey: 'tenant_2' }, now), authFailure)
  assert.throws(() => extractInboundMessage(payload, settings, now + 4_000_000), authFailure)
  assert.equal(extractInboundMessage({ ...payload, event: { ...payload.event, sender: { sender_type: 'app' } } }, settings, now), null)
  assert.equal(identityAllowed(settings, { userId: 'ou_owner', chatId: 'oc_team' }), true)
  assert.equal(identityAllowed(settings, { userId: 'ou_owner', chatId: 'oc_other' }), false)
  assert.equal(identityAllowed({ allowedUsers: [], allowedChats: [] }, {}), false)
  assert.throws(() => normalizeInboundSettings({ ...settings, allowedUsers: [], allowedChats: [] }), /至少配置/)
  assert.notEqual(inboundEventRecordId('project-a', 'app', 'tenant', 'event'), inboundEventRecordId('project-b', 'app', 'tenant', 'event'))
})

test('only supported task intents are parsed', () => {
  assert.deepEqual(parseInboundCommand('状态 task-123'), { intent: 'status', taskId: 'task-123' })
  assert.deepEqual(parseInboundCommand('审批 task-123'), { intent: 'approve', taskId: 'task-123' })
  assert.deepEqual(parseInboundCommand('回复 thread-123：请检查结果'), { intent: 'reply', threadId: 'thread-123', message: '请检查结果' })
  assert.deepEqual(parseInboundCommand('任务：修复登录\n补充回归测试'), { intent: 'create', title: '修复登录', brief: '补充回归测试' })
  assert.equal(parseInboundCommand('powershell --version'), null)
})
