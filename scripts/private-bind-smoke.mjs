import { execFile, execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { isPrivateIpv4, normalizeIpv4 } from '../server/deployment-config.mjs'

const exec = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))

function resolveOpenSsl() {
  const configured = process.env.ZHIDIAN_TEST_OPENSSL?.trim()
  if (configured) return configured
  if (process.platform !== 'win32') return 'openssl'
  const candidates = [
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    'C:\\Program Files\\OpenSSL-Win64\\bin\\openssl.exe',
    'C:\\Program Files\\OpenSSL\\bin\\openssl.exe',
  ]
  for (const candidate of candidates) {
    try {
      const result = execFileSync(candidate, ['version'], { encoding: 'utf8', windowsHide: true })
      if (result.trim()) return candidate
    } catch { /* Try the next known installation path. */ }
  }
  return 'openssl'
}

function freePort() {
  const listener = createServer()
  return new Promise((resolve, reject) => {
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', () => {
      const port = listener.address().port
      listener.close(() => resolve(port))
    })
  })
}

async function waitForPort(child, host, port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`私网绑定服务提前退出：${child.diagnostics || '无错误输出'}`)
    const connected = await new Promise((resolve) => {
      const socket = connect({ host, port })
      socket.once('connect', () => { socket.destroy(); resolve(true) })
      socket.once('error', () => { socket.destroy(); resolve(false) })
    })
    if (connected) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('私网绑定服务未在预期时间内监听。')
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return
  const exited = new Promise((resolve) => child.once('close', resolve))
  child.kill('SIGINT')
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))])
  if (child.exitCode === null && process.platform === 'win32' && child.pid) {
    try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch { /* The process may have exited between checks. */ }
  }
}

async function main() {
  const host = normalizeIpv4(process.env.ZHIDIAN_SMOKE_HOST, 'ZHIDIAN_SMOKE_HOST')
  const client = normalizeIpv4(process.env.ZHIDIAN_SMOKE_CLIENT || host, 'ZHIDIAN_SMOKE_CLIENT')
  if (!isPrivateIpv4(host) || !isPrivateIpv4(client)) throw new Error('私网绑定 smoke 只接受私有 IPv4 地址。')
  const port = await freePort()
  const directory = await mkdtemp(join(tmpdir(), 'zhidian-private-bind-'))
  const dataDir = join(directory, 'data')
  const cert = join(directory, 'server.pem')
  const tlsKey = join(directory, 'server-key.pem')
  const keyring = join(directory, 'keyring.json')
  const openssl = resolveOpenSsl()
  const ownerKey = randomBytes(32).toString('base64url')
  const ownerHash = createHash('sha256').update(ownerKey).digest('hex')
  let child
  try {
    execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', `/CN=${host}`, '-addext', `subjectAltName=IP:${host}`, '-keyout', tlsKey, '-out', cert], { windowsHide: true, stdio: 'ignore' })
    await chmod(tlsKey, 0o600)
    await writeFile(keyring, JSON.stringify({ active: 'smoke', keys: { smoke: randomBytes(32).toString('hex') } }), { mode: 0o600 })
    const env = {
      ...process.env,
      ZHIDIAN_BIND_HOST: host,
      ZHIDIAN_PRIVATE_BIND_CONFIRM: 'I_UNDERSTAND_PRIVATE_TLS',
      ZHIDIAN_PRIVATE_CLIENTS: client,
      ZHIDIAN_API_PORT: String(port),
      ZHIDIAN_HTTPS_ORIGIN: `https://${host}:${port}`,
      ZHIDIAN_STORAGE: 'sqlite',
      ZHIDIAN_DATA_DIR: dataDir,
      ZHIDIAN_OWNER_KEY_HASH: ownerHash,
      ZHIDIAN_CREDENTIAL_KEYRING: keyring,
      ZHIDIAN_TLS_CERT: cert,
      ZHIDIAN_TLS_KEY: tlsKey,
    }
    child = spawn(process.execPath, ['server.mjs'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    child.diagnostics = ''
    child.stderr.setEncoding('utf8').on('data', (chunk) => { child.diagnostics = `${child.diagnostics}${chunk}`.slice(-16_000) })
    await waitForPort(child, host, port)
    const probe = await exec(process.execPath, ['scripts/pilot-probe.mjs', `https://${host}:${port}`, cert], { cwd: root, windowsHide: true, maxBuffer: 64 * 1024 })
    const report = JSON.parse(probe.stdout)
    process.stdout.write(`${JSON.stringify({ ok: true, scope: 'same-host-private-bind-only', listener: { host, port, client }, probe: report })}\n`)
  } finally {
    await stopChild(child)
    await rm(directory, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(`Private-bind smoke failed: ${error.code ?? error.message}`)
  process.exitCode = 1
})
