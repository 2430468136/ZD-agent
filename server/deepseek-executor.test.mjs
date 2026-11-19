import test from 'node:test'
import assert from 'node:assert/strict'
import { runDeepSeekApi } from './deepseek-executor.mjs'

const fixture = {
  baseUrl: 'https://api.deepseek.com/v1/',
  apiKey: 'fixture-secret-key',
  model: 'deepseek-flash',
  agentName: '测试 Agent',
  system: 'fixture system',
  prompt: 'fixture prompt',
}

test('DeepSeek executor calls configured chat endpoint with model, prompt and bearer key', async () => {
  const events = []
  let request
  const result = await runDeepSeekApi({
    ...fixture,
    maxTokens: 900,
    fetchImpl: async (url, init) => {
      request = { url, init }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'mock DeepSeek result' } }] }), { status: 200 })
    },
    onEvent: (event) => events.push(event),
  })

  assert.equal(request.url, 'https://api.deepseek.com/v1/chat/completions')
  assert.equal(request.init.method, 'POST')
  assert.equal(request.init.headers.authorization, 'Bearer fixture-secret-key')
  const payload = JSON.parse(request.init.body)
  assert.equal(payload.model, 'deepseek-flash')
  assert.deepEqual(payload.thinking, { type: 'disabled' })
  assert.equal(payload.max_tokens, 900)
  assert.deepEqual(payload.messages, [
    { role: 'system', content: 'fixture system' },
    { role: 'user', content: 'fixture prompt' },
  ])
  assert.deepEqual(result, { output: 'mock DeepSeek result', executor: 'deepseek-api', provider: 'DeepSeek', model: 'deepseek-flash' })
  assert.ok(events.some((event) => event.type === 'provider.requested'))
  assert.ok(events.some((event) => event.type === 'provider.completed'))
})

test('DeepSeek uses the current root endpoint while preserving an explicitly configured legacy prefix', async () => {
  const root = new URL('/', fixture.baseUrl).origin
  await runDeepSeekApi({ ...fixture, baseUrl: root, fetchImpl: async (url) => {
    assert.equal(new URL(url).pathname, '/chat/completions')
    return Response.json({ choices: [{ message: { content: 'root endpoint' } }] })
  } })
  await runDeepSeekApi({ ...fixture, fetchImpl: async (url) => {
    assert.equal(new URL(url).pathname, '/v1/chat/completions')
    return Response.json({ choices: [{ message: { content: 'legacy endpoint' } }] })
  } })
})

test('DeepSeek executor requires its own key and model configuration', async () => {
  await assert.rejects(runDeepSeekApi({ ...fixture, apiKey: '' }), /保存 DeepSeek API Key/)
  await assert.rejects(runDeepSeekApi({ ...fixture, model: '' }), /没有填写 DeepSeek Model ID/)
  await assert.rejects(runDeepSeekApi({ ...fixture, model: 123 }), /没有填写 DeepSeek Model ID/)
})

test('DeepSeek executor redacts API key from upstream errors', async () => {
  await assert.rejects(runDeepSeekApi({
    ...fixture,
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'invalid fixture-secret-key' } }), { status: 401 }),
  }), /请求失败：invalid \[已隐藏\]/)
})

test('DeepSeek executor propagates cancellation to the provider request', async () => {
  const controller = new AbortController()
  let requestSignal
  const pending = runDeepSeekApi({
    baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-key', model: 'deepseek-chat', system: 'system', prompt: 'prompt',
    signal: controller.signal,
    fetchImpl: async (_url, options) => {
      requestSignal = options.signal
      assert.ok(!Object.hasOwn(JSON.parse(options.body), 'thinking'))
      assert.equal(JSON.parse(options.body).model, 'deepseek-chat')
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true }))
    },
  })
  await new Promise((resolveDelay) => setImmediate(resolveDelay))
  controller.abort()
  await assert.rejects(pending, { code: 'ABORT_ERR', name: 'AbortError' })
  assert.equal(requestSignal.aborted, true)
})

test('DeepSeek executor rejects success without final text', async () => {
  for (const content of [null, '  ', [{ text: true }]]) {
    await assert.rejects(runDeepSeekApi({ ...fixture, fetchImpl: async () => Response.json({ choices: [{ message: { content } }] }) }), { status: 502, message: /空结果/ })
  }
})

test('DeepSeek deadline covers reading the body after headers arrive', async () => {
  const timer = setTimeout(() => {}, 1000)
  try {
    await assert.rejects(runDeepSeekApi({ ...fixture, timeoutMs: 20, fetchImpl: async (_url, { signal }) => ({
      ok: true,
      json: () => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
    }) }), { name: 'TimeoutError', status: 504 })
  } finally { clearTimeout(timer) }
})
