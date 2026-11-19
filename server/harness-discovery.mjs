import { spawn as nodeSpawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stopProcess } from './codex-app-server-executor.mjs'

const MIN_CODEX_VERSION = [0, 151, 0]
const MAX_CAPTURE = 8_192

function safeEnv() {
  const allowed = [
    'PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'USERPROFILE',
    'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'TEMP', 'TMP',
    'OS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'CODEX_HOME',
  ]
  return Object.fromEntries(allowed.filter((key) => process.env[key]).map((key) => [key, process.env[key]]))
}

function deepSeekSafeEnv(dshHome) {
  const env = safeEnv()
  for (const key of ['CODEX_HOME', 'DSH_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH']) delete env[key]
  env.DSH_HOME = dshHome
  env.HOME = dshHome
  env.USERPROFILE = dshHome
  env.APPDATA = join(dshHome, 'AppData', 'Roaming')
  env.LOCALAPPDATA = join(dshHome, 'AppData', 'Local')
  return env
}
function parseVersion(text) {
  const match = text.match(/codex-cli\s+(\d+)\.(\d+)\.(\d+)/i) ?? text.match(/\b(\d+)\.(\d+)\.(\d+)\b/)
  return match ? match.slice(1, 4).map(Number) : null
}

function versionAtLeast(actual, minimum) {
  if (!actual) return false
  for (let i = 0; i < minimum.length; i += 1) {
    if (actual[i] > minimum[i]) return true
    if (actual[i] < minimum[i]) return false
  }
  return true
}

function capture(executable, args, { spawnImpl = nodeSpawn, timeoutMs = 4_000, env = safeEnv() } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawnImpl(executable, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'], env })
    } catch {
      resolve(null)
      return
    }
    let output = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    child.stdout?.setEncoding('utf8').on('data', (chunk) => { output = `${output}${chunk}`.slice(-MAX_CAPTURE) })
    child.once('error', () => finish(null))
    child.once('close', (code) => finish(code === 0 ? output : null))
    const timer = setTimeout(() => {
      child.kill()
      finish(null)
    }, timeoutMs)
  })
}

function appServerAccountProbe(executable, argsPrefix, { spawnImpl = nodeSpawn, timeoutMs = 5_000, env = safeEnv() } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawnImpl(executable, [...argsPrefix, 'app-server', '--stdio'], {
        cwd: process.cwd(), windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'], env,
      })
    } catch {
      resolve('unavailable')
      return
    }

    let buffer = ''
    let nextId = 0
    let initialized = false
    let settled = false
    const requests = new Map()
    const finish = (status) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      for (const reject of requests.values()) reject(new Error('probe stopped'))
      requests.clear()
      void stopProcess(child, 700).finally(() => resolve(status))
    }
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`)
    const rpc = (method, params = {}) => new Promise((resolveRpc, rejectRpc) => {
      const id = ++nextId
      requests.set(id, (error, value) => error ? rejectRpc(error) : resolveRpc(value))
      send({ jsonrpc: '2.0', id, method, params })
    })
    const onLine = (line) => {
      if (!line) return
      let message
      try { message = JSON.parse(line) } catch { finish('connection-error'); return }
      if (message.id !== undefined && requests.has(message.id)) {
        const settle = requests.get(message.id)
        requests.delete(message.id)
        if (message.error) settle(new Error('request failed'))
        else settle(null, message.result)
        return
      }
      if (!initialized && message.method === 'account/updated') {
        const authMode = message.params?.authMode
        if (typeof authMode === 'string') finish('connected')
      }
    }
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      buffer += chunk
      if (Buffer.byteLength(buffer, 'utf8') > MAX_CAPTURE) { finish('connection-error'); return }
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) onLine(line)
    })
    child.once('error', () => finish('connection-error'))
    child.once('close', () => { if (!settled) finish('connection-error') })
    const timer = setTimeout(() => finish('connection-error'), timeoutMs)

    void (async () => {
      const initializedResult = await rpc('initialize', {
        clientInfo: { name: 'zhidian', title: '织点 Harness 检查', version: '0.0.0' },
        capabilities: { experimentalApi: false },
      })
      if (!initializedResult) throw new Error('initialize failed')
      initialized = true
      send({ jsonrpc: '2.0', method: 'initialized', params: {} })
      const account = await rpc('account/read', {})
      if (account?.requiresOpenaiAuth === true) finish('login-required')
      else if (account?.account != null || account?.requiresOpenaiAuth === false || typeof account?.authMode === 'string') finish('connected')
      else finish('connection-unknown')
    })().catch(() => finish('connection-error'))
  })
}

export async function inspectCodexHarness({
  executable = process.env.ZHIDIAN_CODEX_PATH || 'codex',
  argsPrefix = [],
  spawnImpl = nodeSpawn,
  versionTimeoutMs = 4_000,
  probeTimeoutMs = 5_000,
} = {}) {
  const versionOutput = await capture(executable, [...argsPrefix, '--version'], { spawnImpl, timeoutMs: versionTimeoutMs })
  if (!versionOutput) {
    return { id: 'codex-app-server', name: 'Codex App Server', installed: false, compatible: false, status: 'not-installed', version: null, capabilities: ['thread-resume', 'events', 'cancel', 'approval-deny'] }
  }
  const parsed = parseVersion(versionOutput)
  const version = parsed?.join('.') ?? 'unknown'
  if (!versionAtLeast(parsed, MIN_CODEX_VERSION)) {
    return { id: 'codex-app-server', name: 'Codex App Server', installed: true, compatible: false, status: 'incompatible', version, minimumVersion: MIN_CODEX_VERSION.join('.'), capabilities: ['thread-resume', 'events', 'cancel', 'approval-deny'] }
  }
  const status = await appServerAccountProbe(executable, argsPrefix, { spawnImpl, timeoutMs: probeTimeoutMs })
  return { id: 'codex-app-server', name: 'Codex App Server', installed: true, compatible: true, status, version, capabilities: ['thread-resume', 'events', 'cancel', 'approval-deny'] }
}


export async function inspectDeepSeekHarness({
  executable = 'dsh',
  argsPrefix = [],
  spawnImpl = nodeSpawn,
  versionTimeoutMs = 4_000,
} = {}) {
  const windowsCommandShim = process.platform === 'win32' && executable === 'dsh' && argsPrefix.length === 0
  const probeExecutable = windowsCommandShim ? (process.env.ComSpec || 'cmd.exe') : executable
  const probeArgs = windowsCommandShim ? ['/d', '/s', '/c', 'dsh --version'] : [...argsPrefix, '--version']
  const probeHome = await mkdtemp(join(tmpdir(), 'zhidian-dsh-probe-'))
  let versionOutput
  try {
    versionOutput = await capture(probeExecutable, probeArgs, { spawnImpl, timeoutMs: versionTimeoutMs, env: deepSeekSafeEnv(probeHome) })
  } finally {
    await rm(probeHome, { recursive: true, force: true })
  }
  if (!versionOutput) {
    return {
      id: 'deepseek-harness', name: 'DeepSeek Harness', installed: false, compatible: false,
      status: 'not-installed', version: null, capabilities: [],
      message: '未发现 dsh 命令；检查只尝试读取 CLI 版本，不检查 Harness 登录态或私密配置。',
    }
  }
  const match = versionOutput.match(/\bdsh(?:-cli)?\s+v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/i)
    ?? versionOutput.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/)
  const version = match?.[1] ?? 'unknown'
  return {
    id: 'deepseek-harness', name: 'DeepSeek Harness', installed: true, compatible: false,
    status: 'integration-pending', version, capabilities: [],
    message: '已发现 dsh CLI；目前只完成版本探测。SDK 运行时、独立 DSH_HOME、隐私补丁与真实任务验收尚未完成，因此不会分配任务，也不会读取或复用桌面端配置。',
  }
}