import { spawn } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'

const host = '127.0.0.1'
const port = Number(process.env.ZHIDIAN_API_PORT ?? 8787)
const dataDir = process.env.ZHIDIAN_DATA_DIR ?? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Zhidian')
const configPath = join(dataDir, 'providers.json')
const maxBodyBytes = 16 * 1024

const providerDefinitions = {
  OpenAI: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', keyRequired: true, kind: 'openai' },
  Anthropic: { label: 'Anthropic / Claude', baseUrl: 'https://api.anthropic.com', keyRequired: true, kind: 'anthropic' },
  DeepSeek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', keyRequired: true, kind: 'openai' },
  'OpenAI Compatible': { label: '兼容 OpenAI API', baseUrl: '', keyRequired: true, kind: 'openai' },
  Local: { label: '本地模型', baseUrl: 'http://localhost:11434/v1', keyRequired: false, kind: 'openai' },
}

const providers = new Map(Object.entries(providerDefinitions).map(([id, definition]) => [id, {
  baseUrl: definition.baseUrl,
  apiKey: '',
}]))

function powershell(operation) {
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security | Out-Null; $inputValue=[Console]::In.ReadToEnd(); $bytes=[Convert]::FromBase64String($inputValue); ${operation === 'protect'
    ? '$result=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);'
    : '$result=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);'} [Console]::Out.Write([Convert]::ToBase64String($result))`
  const encodedScript = Buffer.from(script, 'utf16le').toString('base64')

  return (payload) => new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      reject(new Error('当前版本使用 Windows 用户级凭据加密；此系统暂不支持保存 API Key。'))
      return
    }
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => reject(new Error(`Windows 凭据加密失败：${error.message}`)))
    child.on('close', (code) => {
      if (code !== 0 || !stdout.trim()) {
        reject(new Error(`Windows 凭据加密失败：${stderr.trim() || 'PowerShell 未返回结果'}`))
        return
      }
      resolve(stdout.trim())
    })
    child.stdin.end(Buffer.from(payload, 'utf8').toString('base64'))
  })
}

const protect = powershell('protect')
const unprotect = powershell('unprotect')

async function loadProviders() {
  try {
    const stored = JSON.parse(await readFile(configPath, 'utf8'))
    for (const [id, value] of Object.entries(stored)) {
      if (!providers.has(id) || !value || typeof value !== 'object') continue
      const current = providers.get(id)
      current.baseUrl = typeof value.baseUrl === 'string' ? value.baseUrl : current.baseUrl
      if (typeof value.encryptedApiKey === 'string' && value.encryptedApiKey) {
        current.apiKey = Buffer.from(await unprotect(value.encryptedApiKey), 'base64').toString('utf8')
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(`Could not load provider settings: ${error.message}`)
    }
  }
}

async function persistProviders() {
  await mkdir(dataDir, { recursive: true })
  const stored = {}
  for (const [id, provider] of providers) {
    stored[id] = {
      baseUrl: provider.baseUrl,
      encryptedApiKey: provider.apiKey ? await protect(provider.apiKey) : '',
    }
  }
  const tempPath = `${configPath}.tmp`
  await writeFile(tempPath, JSON.stringify(stored, null, 2), { encoding: 'utf8', mode: 0o600 })
  await rename(tempPath, configPath)
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(JSON.stringify(value))
}

function isLocalOrigin(value) {
  if (!value) return false
  try {
    const origin = new URL(value)
    return origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
  } catch {
    return false
  }
}

async function readJson(request) {
  let body = ''
  for await (const chunk of request) {
    body += chunk
    if (Buffer.byteLength(body) > maxBodyBytes) throw Object.assign(new Error('请求内容过大。'), { status: 413 })
  }
  try {
    return JSON.parse(body || '{}')
  } catch {
    throw Object.assign(new Error('请求内容不是有效 JSON。'), { status: 400 })
  }
}

function normalizeBaseUrl(value, allowBlank = false) {
  const baseUrl = typeof value === 'string' ? value.trim().replace(/\/+$/, '') : ''
  if (!baseUrl && allowBlank) return ''
  let parsed
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw Object.assign(new Error('请输入有效的服务商 API 地址。'), { status: 400 })
  }
  const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
    throw Object.assign(new Error('API 地址必须使用 HTTPS；仅本机地址允许 HTTP。'), { status: 400 })
  }
  return baseUrl
}

async function testProvider(id, body) {
  const definition = providerDefinitions[id]
  const saved = providers.get(id)
  const baseUrl = normalizeBaseUrl(body.baseUrl ?? saved.baseUrl)
  const apiKey = typeof body.apiKey === 'string' && body.apiKey.trim() ? body.apiKey.trim() : saved.apiKey
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  if (!model) throw Object.assign(new Error('请填写用于连接测试的 Model ID。'), { status: 400 })
  if (definition.keyRequired && !apiKey) throw Object.assign(new Error('请先填写并保存 API Key，或在连接测试时临时填写。'), { status: 400 })

  const endpoint = definition.kind === 'anthropic'
    ? `${baseUrl.replace(/\/v1$/, '')}/v1/messages`
    : `${baseUrl}/chat/completions`
  const headers = { 'content-type': 'application/json' }
  const payload = { model, max_tokens: 8, messages: [{ role: 'user', content: 'Reply with exactly OK.' }] }
  if (definition.kind === 'anthropic') {
    headers['x-api-key'] = apiKey
    headers['anthropic-version'] = '2023-06-01'
  } else if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`
  }

  const started = Date.now()
  let upstream
  try {
    upstream = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    })
  } catch (error) {
    if (error.name === 'TimeoutError') throw Object.assign(new Error('连接超时，请检查地址、网络或本地模型服务。'), { status: 504 })
    throw Object.assign(new Error(`无法连接服务商：${error.message}`), { status: 502 })
  }

  if (!upstream.ok) {
    const responseBody = await upstream.json().catch(() => ({}))
    const detail = responseBody?.error?.message ?? responseBody?.message
    const safeDetail = typeof detail === 'string' ? detail.replaceAll(apiKey, '[已隐藏]').slice(0, 320) : `服务商返回 HTTP ${upstream.status}。`
    throw Object.assign(new Error(safeDetail), { status: 502 })
  }

  return { message: '连接成功，模型已返回响应。', latencyMs: Date.now() - started }
}

await loadProviders()

const server = createServer(async (request, response) => {
  const origin = request.headers.origin
  if (!isLocalOrigin(origin) || request.headers['x-zhidian-client'] !== 'web-ui') {
    sendJson(response, 403, { error: '请求来源未获允许。' })
    return
  }

  const url = new URL(request.url ?? '/', `http://${host}:${port}`)
  if (request.method === 'GET' && url.pathname === '/api/health') {
    sendJson(response, 200, { ok: true })
    return
  }

  if (request.method === 'GET' && url.pathname === '/api/providers') {
    sendJson(response, 200, {
      providers: Object.fromEntries([...providers].map(([id, value]) => [id, {
        baseUrl: value.baseUrl,
        hasApiKey: Boolean(value.apiKey),
        maskedApiKey: value.apiKey ? `••••${value.apiKey.slice(-4)}` : '',
      }])),
    })
    return
  }

  const providerMatch = url.pathname.match(/^\/api\/providers\/([^/]+)(?:\/(test))?$/)
  const providerId = providerMatch ? decodeURIComponent(providerMatch[1]) : ''
  if (providerMatch && providers.has(providerId)) {
    const id = providerId
    const action = providerMatch[2]
    try {
      const body = await readJson(request)
      if (action === 'test' && request.method === 'POST') {
        sendJson(response, 200, await testProvider(id, body))
        return
      }
      if (!action && request.method === 'PUT') {
        const current = providers.get(id)
        const baseUrl = normalizeBaseUrl(body.baseUrl, id === 'OpenAI Compatible')
        const apiKey = body.clearApiKey === true
          ? ''
          : typeof body.apiKey === 'string' && body.apiKey.trim()
            ? body.apiKey.trim()
            : current.apiKey
        if (apiKey && process.platform !== 'win32') {
          throw Object.assign(new Error('当前系统暂不支持安全保存 API Key。'), { status: 501 })
        }
        providers.set(id, { baseUrl, apiKey })
        await persistProviders()
        sendJson(response, 200, { saved: true, hasApiKey: Boolean(apiKey) })
        return
      }
      if (!action && request.method === 'DELETE') {
        providers.set(id, { baseUrl: providers.get(id).baseUrl, apiKey: '' })
        await persistProviders()
        sendJson(response, 200, { deleted: true })
        return
      }
      sendJson(response, 405, { error: '不支持的请求方法。' })
    } catch (error) {
      sendJson(response, error.status ?? 500, { error: error.message ?? '本地服务发生错误。' })
    }
    return
  }

  sendJson(response, 404, { error: '找不到请求的本地接口。' })
})

server.listen(port, host, () => {
  console.log(`Zhidian local API listening on http://${host}:${port}`)
})

process.on('SIGINT', () => server.close(() => process.exit(0)))
process.on('SIGTERM', () => server.close(() => process.exit(0)))
