import { spawn } from 'node:child_process'

const MAX_OUTPUT = 1_000_000
const MAX_STDERR = 24_000

function parseJsonLines(stdout) {
  return stdout.split(/\r?\n/).map((line) => {
    try { return JSON.parse(line) } catch { return null }
  }).filter(Boolean)
}

function finalMessage(events) {
  for (const event of [...events].reverse()) {
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
      if (typeof event.item.text === 'string') return event.item.text
      if (Array.isArray(event.item.content)) return event.item.content.map((item) => item.text ?? '').join('\n').trim()
    }
    if (event.type === 'turn.completed' && typeof event.last_agent_message === 'string') return event.last_agent_message
  }
  return ''
}

export function buildCodexExecArgs({ cwd, model, readOnly }) {
  const args = [
    '--ask-for-approval', 'never',
    'exec', '--json', '--sandbox', readOnly ? 'read-only' : 'workspace-write', '--cd', cwd,
    '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '--color', 'never',
  ]
  if (model) args.push('--model', model)
  return [...args, '-']
}

export function runCodexCli({ prompt, cwd, model, readOnly, timeoutMs = 600_000, onEvent = () => undefined, executable = process.env.ZHIDIAN_CODEX_PATH || 'codex', argsPrefix = [], signal }) {
  if (signal?.aborted) return Promise.reject(Object.assign(new Error('Codex CLI 运行已取消。'), { name: 'AbortError', code: 'ABORT_ERR' }))
  return new Promise((resolve, reject) => {
    const args = [...argsPrefix, ...buildCodexExecArgs({ cwd, model, readOnly })]
    let child
    try {
      child = spawn(executable, args, { cwd, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      reject(new Error(`无法启动 Codex CLI：${error.message}`))
      return
    }
    let stdout = ''
    let stderr = ''
    let pendingLine = ''
    let settled = false
    const terminate = () => {
      if (child.pid && process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        killer.unref()
      } else child.kill('SIGTERM')
    }
    const onAbort = () => {
      terminate()
      finish(Object.assign(new Error('Codex CLI 运行已取消。'), { name: 'AbortError', code: 'ABORT_ERR' }))
    }
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(() => {
      terminate()
      finish(Object.assign(new Error(`Codex CLI 超时（${Math.round(timeoutMs / 1000)} 秒），已终止本次运行。`), { name: 'TimeoutError', code: 'EXECUTOR_TIMEOUT' }))
    }, timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) { onAbort(); return }
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      if (stdout.length + chunk.length > MAX_OUTPUT) {
        terminate()
        finish(new Error('Codex CLI 输出超过大小限制，已终止本次运行。'))
        return
      }
      stdout += chunk
      const lines = `${pendingLine}${chunk}`.split(/\r?\n/)
      pendingLine = lines.pop() ?? ''
      for (const line of lines) {
        try {
          const event = JSON.parse(line)
          if (event.type) onEvent({ type: event.type, message: event.item?.type === 'command_execution' ? 'Codex 正在处理工作区命令。' : undefined })
        } catch {
          // Codex JSONL may emit partial lines between stream chunks.
        }
      }
    })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { if (stderr.length < MAX_STDERR) stderr += chunk.slice(0, MAX_STDERR - stderr.length) })
    child.on('error', (error) => finish(new Error(`无法启动 Codex CLI：${error.message}`)))
    child.on('close', (code) => {
      const message = finalMessage(parseJsonLines(stdout))
      if (code !== 0) {
        finish(new Error(`Codex CLI 退出码 ${code ?? 'unknown'}：${stderr.trim() || message.slice(0, 500) || '无错误输出'}`))
        return
      }
      if (!message) {
        finish(new Error('Codex CLI 未返回最终结果；请确认本机已登录并支持 codex exec --json。'))
        return
      }
      finish(null, { output: message, executor: 'codex-cli' })
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(prompt)
  })
}
