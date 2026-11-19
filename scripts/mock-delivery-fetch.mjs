import { createHmac } from 'node:crypto'

const fetchLive = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = new URL(input)
  if (url.host !== 'open.feishu.cn' && url.host !== 'open.larksuite.com') return fetchLive(input, init)
  if (url.pathname.endsWith('/test-throttle-token')) return new Response(null, { status: 429, headers: { 'retry-after': '60' } })
  if (url.pathname.endsWith('/test-signed-token')) {
    const body = JSON.parse(init.body)
    const signature = createHmac('sha256', `${body.timestamp}\nfixture-webhook-secret`).digest('base64')
    const accepted = body.sign === signature && init.redirect === 'manual' && Object.keys(body.content).join(',') === 'text' && /^织点 \| (测试通知|验收通过\n任务编号：task-[\w-]+)$/.test(body.content.text)
    return Response.json({ code: accepted ? 0 : 19021 })
  }
  throw new Error('The delivery fixture refused a non-test webhook.')
}
