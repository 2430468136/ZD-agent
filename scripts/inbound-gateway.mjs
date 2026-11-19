import { X509Certificate } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { request as requestTls } from 'node:https'
import { isAbsolute } from 'node:path'
import { parseHttpsOrigin } from '../server/https-workbench.mjs'

const bind = '127.0.0.1'
const maxBodyBytes = 64 * 1024
const maxResponseBytes = 4096
const maxInFlight = 32
const deadlineMs = 2500
const signatureHeaders = ['x-lark-request-timestamp', 'x-lark-request-nonce', 'x-lark-signature']
const callbackStatuses = new Set([400, 401, 403, 404, 413, 415, 429, 503])
const configError = 'Set ZHIDIAN_GATEWAY_PORT, ZHIDIAN_GATEWAY_PROJECT_ID, ZHIDIAN_GATEWAY_UPSTREAM (exact HTTPS loopback origin), and ZHIDIAN_GATEWAY_CA (absolute public PEM file).'

function failure(status) { return Object.assign(new Error('Callback rejected.'), { status }) }

async function readLimited(stream, limit, overflowStatus) {
  const chunks = []
  let bytes = 0
  for await (const chunk of stream.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length
    if (bytes > limit) throw failure(overflowStatus)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, bytes)
}

function respond(response, status, body = { error: 'Callback not accepted.' }) {
  if (response.writableEnded || response.destroyed) return
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', connection: 'close' })
  response.end(JSON.stringify(body))
}

async function forward(url, ca, headers, body, signal) {
  const upstream = await new Promise((resolve, reject) => {
    const request = requestTls(url, { method: 'POST', agent: false, ca, rejectUnauthorized: true, minVersion: 'TLSv1.2', headers, signal }, resolve)
    request.on('error', reject)
    request.end(body)
  })
  try {
    if (callbackStatuses.has(upstream.statusCode)) return { status: upstream.statusCode }
    if (upstream.statusCode !== 200 || !/^application\/json(?:\s*;|$)/i.test(upstream.headers['content-type'] ?? '')) throw failure(502)
    const payload = JSON.parse((await readLimited(upstream, maxResponseBytes, 502)).toString('utf8'))
    if (payload && typeof payload.challenge === 'string' && payload.challenge.length > 0 && payload.challenge.length <= 512) {
      return { status: 200, payload: { challenge: payload.challenge } }
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== 0) throw failure(502)
    return { status: 200, payload: {} }
  } finally { upstream.destroy() }
}

async function main() {
  const { ZHIDIAN_GATEWAY_PORT: configuredPort, ZHIDIAN_GATEWAY_PROJECT_ID: project, ZHIDIAN_GATEWAY_UPSTREAM: configuredOrigin, ZHIDIAN_GATEWAY_CA: caPath } = process.env
  let origin
  try { origin = parseHttpsOrigin(configuredOrigin) } catch { throw new Error(configError) }
  const port = Number(configuredPort)
  if (!/^\d{1,5}$/.test(configuredPort ?? '') || port < 1 || port > 65535 || !/^[A-Za-z0-9_-]{1,128}$/.test(project ?? '') || origin?.hostname !== bind || Number(origin.port || 443) === port || !caPath || !isAbsolute(caPath)) {
    throw new Error(configError)
  }
  let ca
  try { ca = await readFile(caPath); new X509Certificate(ca) } catch { throw new Error('The gateway CA must be a readable public PEM certificate.') }
  const path = `/api/inbound/${project}`
  const upstream = new URL(path, origin)
  let inFlight = 0
  const listener = createServer({ maxHeaderSize: 8192, headersTimeout: 3000, requestTimeout: 3500, connectionsCheckingInterval: 500 }, (request, response) => {
    if (request.method !== 'POST' || request.url !== path || request.headers.host !== `${bind}:${port}`) { respond(response, 404); return }
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '') || (request.headers['content-encoding'] ?? 'identity') !== 'identity') { respond(response, 415); return }
    if (Number(request.headers['content-length']) > maxBodyBytes) { respond(response, 413); return }
    if (inFlight >= maxInFlight) { respond(response, 429); return }
    inFlight += 1
    const abort = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; respond(response, 504); abort.abort() }, deadlineMs)
    response.once('close', () => abort.abort())
    void (async () => {
      try {
        const body = await readLimited(request, maxBodyBytes, 413)
        if (abort.signal.aborted) return
        const headers = { 'content-type': 'application/json', 'content-length': body.length }
        for (const name of signatureHeaders) {
          const values = request.headersDistinct[name]
          if (!values) continue
          if (values.length !== 1 || values[0].length > 128) throw failure(400)
          headers[name] = values[0]
        }
        const { status, payload } = await forward(upstream, ca, headers, body, abort.signal)
        respond(response, status, payload)
      } catch (error) {
        if (!timedOut) respond(response, [400, 413].includes(error.status) ? error.status : 502)
      } finally {
        clearTimeout(timer)
        inFlight -= 1
      }
    })()
  })
  listener.maxConnections = 128
  listener.on('checkContinue', (_request, response) => respond(response, 417))
  listener.on('checkExpectation', (_request, response) => respond(response, 417))
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(port, bind, resolve) })
  console.log(`Feishu/Lark gateway listening on http://${bind}:${port}${path} (loopback only)`)
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => listener.close())
}

main().catch((error) => { console.error(error.code ? `Callback gateway failed to start (${error.code}).` : error.message); process.exitCode = 1 })
