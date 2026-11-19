import { spawn } from 'node:child_process'

const MAX_OUTPUT = 1_000_000
const MAX_STDERR = 24_000
const MIN_CLAUDE_VERSION = [2, 1, 314]

export function buildClaudeCodeArgs({ model, readOnly }) {
  const tools = readOnly ? 'Read,Grep,Glob' : 'Read,Edit,Write,Grep,Glob'
  const settings = JSON.stringify({
    permissions: {
      blockReadsOutsideWorkingDirectories: true,
      blockWritesOutsideWorkingDirectories: true,
    },
  })
  const args = [
    '--restricted',
    '--print',
    '--output-format', 'json',
    '--permission-mode', readOnly ? 'plan' : 'acceptEdits',
    '--tools', tools,
    '--settings', settings,
    '--no-session-persistence',
    '--max-turns', '12',
  ]
  if (model) args.push('--model', model)
  return args
}

export function parseClaudeVersion(text) {
  const match = text.match(/\b(\d+)\.(\d+)\.(\d+)\b/)
  return match ? match.slice(1).map(Number) : null
}

function isSupportedVersion(version) {
  if (!version) return false
  for (let i = 0; i < MIN_CLAUDE_VERSION.length; i += 1) {
    if (version[i] !== MIN_CLAUDE_VERSION[i]) return version[i] > MIN_CLAUDE_VERSION[i]
  }
  return true
}

function checkVersion({ executable, cwd, argsPrefix, spawnImpl, timeoutMs, signal }) {
  if (signal?.aborted) return Promise.reject(Object.assign(new Error('Claude Code CLI 运行已取消。'), { name: 'AbortError', code: 'ABORT_ERR' }))
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawnImpl(executable, [...argsPrefix, '--version'], { cwd, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      reject(new Error(`无法启动 Claude Code CLI：${error.message}`))
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (error, version) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve(version)
    }
    const onAbort = () => {
      child.kill('SIGTERM')
      finish(Object.assign(new Error('Claude Code CLI 运行已取消。'), { name: 'AbortError', code: 'ABORT_ERR' }))
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish(Object.assign(new Error('读取 Claude Code CLI 版本超时。'), { name: 'TimeoutError', code: 'EXECUTOR_TIMEOUT' }))
    }, timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) { onAbort(); return }
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(0, 2_000) })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(0, 2_000) })
    child.on('error', (error) => finish(new Error(`无法启动 Claude Code CLI：${error.message}`)))
    child.on('close', (code) => {
      const version = parseClaudeVersion(stdout) ?? parseClaudeVersion(stderr)
      if (code !== 0 || !version) {
        finish(new Error(`无法确认 Claude Code CLI 版本；请安装或更新 Claude Code。${stderr.trim() ? ` ${stderr.trim()}` : ''}`))
        return
      }
      if (!isSupportedVersion(version)) {
        finish(new Error(`Claude Code CLI ${version.join('.')} 版本过旧；此执行器要求 2.1.314 或更高版本，以确保工作区外读写限制可用。`))
        return
      }
      finish(null, version)
    })
  })
}

function extractResult(stdout) {
  const trimmed = stdout.trim()
  if (!trimmed) return ''
  try {
    const parsed = JSON.parse(trimmed)
    if (typeof parsed.result === 'string') return parsed.result.trim()
    if (Array.isArray(parsed.content)) return parsed.content.map((item) => item.text ?? '').join('\n').trim()
  } catch {
    // Keep compatibility with CLI builds that return plain text despite JSON mode.
  }
  return trimmed
}

export async function runClaudeCode({ prompt, cwd, model, readOnly, timeoutMs = 600_000, onEvent = () => undefined, executable = process.env.ZHIDIAN_CLAUDE_PATH || 'claude', argsPrefix = [], spawnImpl = spawn, signal }) {
  await checkVersion({ executable, cwd, argsPrefix, spawnImpl, timeoutMs: Math.min(timeoutMs, 10_000), signal })
  if (signal?.aborted) throw Object.assign(new Error('Claude Code CLI 运行已取消。'), { name: 'AbortError', code: 'ABORT_ERR' })
  return new Promise((resolve, reject) => {
    const args = [...argsPrefix, ...buildClaudeCodeArgs({ model, readOnly })]
    let child
    try {
      child = spawnImpl(executable, args, { cwd, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      reject(new Error(`无法启动 Claude Code CLI：${error.message}`))
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve(value)
    }
    const terminate = () => {
      if (child.pid && process.platform === 'win32') {
        const killer = spawnImpl('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        killer.unref()
      } else child.kill('SIGTERM')
    }
    const timer = setTimeout(() => {
      terminate()
      finish(Object.assign(new Error(`Claude Code CLI 超时（${Math.round(timeoutMs / 1000)} 秒），已终止本次运行。`), { name: 'TimeoutError', code: 'EXECUTOR_TIMEOUT' }))
    }, timeoutMs)
    const onAbort = () => {
      terminate()
      finish(Object.assign(new Error('Claude Code CLI 运行已取消。'), { name: 'AbortError', code: 'ABORT_ERR' }))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) { onAbort(); return }
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      if (stdout.length + chunk.length > MAX_OUTPUT) {
        terminate()
        finish(new Error('Claude Code CLI 输出超过大小限制，已终止本次运行。'))
        return
      }
      stdout += chunk
    })
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      if (stderr.length < MAX_STDERR) stderr += chunk.slice(0, MAX_STDERR - stderr.length)
    })
    child.on('error', (error) => finish(new Error(`无法启动 Claude Code CLI：${error.message}`)))
    child.on('close', (code) => {
      if (code !== 0) {
        const detail = stderr.trim() || stdout.trim().slice(0, 500) || '无错误输出'
        finish(new Error(`Claude Code CLI 退出码 ${code ?? 'unknown'}：${detail}`))
        return
      }
      const output = extractResult(stdout)
      if (!output) {
        finish(new Error('Claude Code CLI 未返回最终结果。'))
        return
      }
      onEvent({ type: 'harness.completed', message: 'Claude Code CLI 已完成本次运行。' })
      finish(null, { output, executor: 'claude-code' })
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(prompt)
  })
}
