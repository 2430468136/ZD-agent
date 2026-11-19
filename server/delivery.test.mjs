import test from 'node:test'
import assert from 'node:assert/strict'
import { buildBotPayload, nextDeliveryState, transmitBot, transmitInboundReply, validateBotUrl } from './delivery.mjs'

const url = 'https://open.feishu.cn/open-apis/bot/v2/hook/fixture-token'
const config = { channel: 'feishu', url, secret: 'fixture-secret' }
const item = { event: 'approved', taskId: 'task-fixture', title: 'private-title', brief: 'private-brief', output: 'private-output' }

test('delivery payload is signed and only contains fixed status and a safe task ID', () => {
  const payload = buildBotPayload(item, config.secret, 1_700_000_000_000)
  assert.equal(payload.timestamp, '1700000000')
  assert.equal(payload.sign, 'eSSBpPPdWfBl7avPl9BWSBfQOnLGZ91Xn8G5oZis0sc=')
  assert.equal(payload.content.text, '织点 | 验收通过\n任务编号：task-fixture')
  assert.doesNotMatch(JSON.stringify(payload), /private-|fixture-secret/)
})

test('only an HTTPS origin and a valid task ID produce a signed rich notification with a task link', () => {
  const origin = new URL('https://192.168.1.10:9443')
  const time = 1_700_000_000_000
  const payload = buildBotPayload(item, config.secret, time, origin)
  assert.equal(payload.msg_type, 'post')
  assert.equal(payload.sign, buildBotPayload(item, config.secret, time).sign)
  assert.deepEqual(payload.content.post.zh_cn, {
    title: '织点 | 验收通过',
    content: [[{ tag: 'text', text: '任务编号：task-fixture' }], [{ tag: 'a', text: '打开织点任务', href: 'https://192.168.1.10:9443/#task=task-fixture' }]],
  })
  assert.doesNotMatch(JSON.stringify(payload), /private-|fixture-secret|fixture-token/)
  assert.equal(buildBotPayload({ ...item, taskId: '//invalid' }, '', time, origin).msg_type, 'text')
  assert.equal(buildBotPayload({ ...item, event: 'test' }, '', time, origin).content.text, '织点 | 测试通知')
  assert.equal(buildBotPayload(item, '', time, new URL('http://127.0.0.1')).msg_type, 'text')
})

test('only exact official HTTPS robot URLs are accepted', () => {
  assert.equal(validateBotUrl('feishu', url), url)
  assert.throws(() => validateBotUrl('lark', url), /官方/)
  for (const invalid of [url.replace('https:', 'http:'), url.replace('open.feishu.cn', 'open.feishu.cn.example.com'), url.replace('open.feishu.cn', 'abc@open.feishu.cn'), url + '?token=leak', url + '#foo', url.replace('open.feishu.cn', '127.0.0.1')]) assert.throws(() => validateBotUrl('feishu', invalid), /官方/)
})

test('delivery transport refuses redirects and only confirms explicit acknowledgements', async () => {
  const call = async (...args) => {
    assert.equal(args[0], url)
    assert.equal(args[1].redirect, 'manual')
    return Response.json({ code: 0 })
  }
  assert.equal((await transmitBot(config, item, { fetchImpl: call })).status, 'sent')
  const redirected = await transmitBot(config, item, { fetchImpl: async () => Response.redirect('https://example.com') })
  assert.equal(redirected.status, 'failed')
  assert.equal((await transmitBot(config, item, { fetchImpl: async () => Response.json({ code: 19021, msg: config.secret }) })).error, '渠道拒绝通知（19021）。')
  assert.equal((await transmitBot(config, item, { fetchImpl: async () => Response.json({ echo: 'x'.repeat(9000) }) })).status, 'unknown')
  assert.equal((await transmitBot(config, item, { fetchImpl: async () => { throw new Error(config.url) } })).status, 'unknown')
})

test('explicit throttling persists bounded retry time and caps retry attempts', async () => {
  const result = await transmitBot(config, item, { fetchImpl: async () => new Response(null, { status: 429, headers: { 'retry-after': '40' } }) })
  assert.equal(result.status, 'retry-wait')
  assert.equal(nextDeliveryState({ attempts: 1 }, result, 0).retryAt, new Date(40_000).toISOString())
  assert.equal(nextDeliveryState({ attempts: 3 }, result, 0).retryAt, new Date(60_000).toISOString())
  assert.equal(nextDeliveryState({ attempts: 4 }, result, 0).status, 'failed')
})

test('application replies never follow redirects or retry ambiguous delivery', async () => {
  const settings = { channel: 'lark', appId: 'cli_fixture', appSecret: 'private-app-secret' }
  const reply = { messageId: 'om_fixture', replyText: '织点 | 已收到请求', replyUuid: 'fixture-reply-id' }
  let calls = 0
  const unknown = await transmitInboundReply(settings, reply, { fetchImpl: async (url, init) => {
    assert.equal(init.redirect, 'manual')
    calls += 1
    if (calls === 1) {
      assert.equal(url, 'https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal')
      return Response.json({ code: 0, tenant_access_token: 'fixture-token' })
    }
    assert.equal(url, 'https://open.larksuite.com/open-apis/im/v1/messages/om_fixture/reply')
    assert.equal(init.headers.authorization, 'Bearer fixture-token')
    assert.equal(JSON.parse(init.body).uuid, reply.replyUuid)
    throw new Error('private-app-secret')
  } })
  assert.equal(calls, 2)
  assert.equal(nextDeliveryState({ attempts: 1 }, unknown).status, 'unknown')
  assert.doesNotMatch(JSON.stringify(unknown), /private-app-secret|fixture-token/)
  const redirected = await transmitInboundReply(settings, reply, { fetchImpl: async () => Response.redirect('https://example.com') })
  assert.equal(redirected.status, 'failed')
})
