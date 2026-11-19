import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

const liveFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input))
  if (url.origin === 'https://open.feishu.cn') {
    assert.equal(init.redirect, 'manual')
    const body = JSON.parse(init.body)
    if (url.pathname === '/open-apis/bot/v2/hook/test-denied-token') return Response.json({ code: 19021 })
    if (url.pathname === '/open-apis/bot/v2/hook/test-ambiguous-token') return new Response(null, { status: 503 })
    if (url.pathname === '/open-apis/bot/v2/hook/test-task-link-token') {
      const post = body.content?.post?.zh_cn
      const id = /^任务编号：(task-[a-z0-9-]+)$/.exec(post?.content?.[0]?.[0]?.text ?? '')?.[1]
      assert.ok(id)
      const href = `${process.env.ZHIDIAN_HTTPS_ORIGIN}/#task=${id}`
      assert.deepEqual(body, { msg_type: 'post', content: { post: { zh_cn: {
        title: '织点 | 验收通过', content: [[{ tag: 'text', text: `任务编号：${id}` }], [{ tag: 'a', text: '打开织点任务', href }]],
      } } } })
      appendFileSync(join(process.env.ZHIDIAN_DATA_DIR, 'mock-task-links.log'), `${href}\n`)
      return Response.json({ code: 0 })
    }
    if (url.pathname === '/open-apis/auth/v3/tenant_access_token/internal') {
      assert.deepEqual(body, { app_id: 'cli_e2e', app_secret: 'e2e-app-secret' })
      return Response.json({ code: 0, tenant_access_token: 'fixture-tenant-token' })
    }
    if (url.pathname === '/open-apis/im/v1/messages/om_e2e_status/reply') {
      assert.equal(init.headers.authorization, 'Bearer fixture-tenant-token')
      assert.equal(body.msg_type, 'text')
      assert.equal(body.reply_in_thread, true)
      assert.match(body.uuid, /^[a-f0-9-]{36}$/)
      assert.deepEqual(JSON.parse(body.content), { text: '织点 | 当前任务状态 approved' })
      return Response.json({ code: 0, data: { message_id: 'om_reply_fixture' } })
    }
    throw new Error('Unexpected Feishu outbound request in the HTTPS fixture.')
  }
  if (String(input) !== 'https://api.deepseek.com/v1/chat/completions' || init.redirect !== 'error') throw new Error('Unexpected outbound request in the HTTPS fixture.')
  const payload = JSON.parse(init.body)
  assert.deepEqual(payload.thinking, { type: 'disabled' })
  if (payload.messages?.[0]?.content === 'You are a connectivity check.') {
    assert.equal(payload.messages[1]?.content, 'Reply with exactly OK.')
    assert.equal(payload.max_tokens, 16)
    if (payload.model === 'probe-denied') return Response.json({ error: { message: `Rejected ${init.headers.authorization}` } }, { status: 401 })
    assert.equal(init.headers.authorization, 'Bearer local-test-key')
    if (payload.model === 'probe-empty') return Response.json({ choices: [{ message: { content: null, reasoning_content: 'not final text' } }] })
    assert.equal(payload.model, 'deepseek-flash')
    return Response.json({ choices: [{ message: { content: 'private mock output' } }] })
  }
  return liveFetch(`http://127.0.0.1:${process.env.MOCK_PROVIDER_PORT}/v1/chat/completions`, init)
}
