import { spawn } from 'node:child_process'

const MAX_OUTPUT = 1_000_000
const MAX_STDERR = 24_000
const MAX_HELP = 64_000
const requiredFlags = ['--mode', '--no-session', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--tools']

function abortError(message = 'Pi 运行已取消。') {
  return Object.assign(new Error(message), { name: 'AbortError', code: 'ABORT_ERR' })
}

function timeoutError(message) {
  return Object.assign(new Error(message), { name: 'TimeoutError', code: 'EXECUTOR_TIMEOUT' })
}

export function buildPiArgs({ model, readOnly, prompt }) {
  const tools = readOnly ? 'read,grep,find,ls' : 'read,grep,find,ls,edit,write'
  const args = [
    '--mode', 'json',
    '--no-session',
    '--no-extensions',
    '--no-mcp',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--no-context-files',
    '--no-approve',
    '--tools', tools,
  ]
  if (model) args.push('--model', model)
  args.push('--', prompt)
  return args
}

function textFromContent(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content.map((part) => {
    if (typeof part === 'string') return part
    if (typeof part?.text === 'string') return part.text
    return ''
  }).join('').trim()
}

function finalMessage(events) {
  for (const event of [...events].reverse()) {
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      const output = textFromContent(event.message.content)
      if (output) return output
    }
    if (event.type === 'agent_end' && Array.isArray(event.messages)) {
      for (const message of [...event.messages].reverse()) {
        if (message?.role !== 'assistant') continue
        const output = textFromContent(message.content)
        if (output) return output
      }
    }
  }
  return ''
}

function emitEvent(event, onEvent) {
  if (typeof onEvent !== 'function' || !event?.type) return
  const messages = {
    agent_start: 'Pi 已开始执行。',
    turn_start: 'Pi 正在生成本轮结果。',
    tool_execution_start: `Pi 正在调用受限工具${event.toolName ? `：${event.toolName}` : ''}。`,
    tool_execution_end: 'Pi 已完成受限工具调用。',
    agent_end: 'Pi 已完成一次 Agent 运行。',
    agent_settled: 'Pi 已结束本次执行。',
  }
  onEvent({ type: `pi.${event.type}`, message: messages[event.type] ?? `Pi 事件：${event.type}。` })
}

function checkCompatibility({ executable, cwd, argsPrefix, spawnImpl, timeoutMs, signal }) {
  if (signal?.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawnImpl(executable, [...argsPrefix, '--help'], { cwd, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      reject(new Error(`无法启动 Pi CLI：${error.message}`))
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    let timer
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve()
    }
    const terminate = () => {
      if (child.pid && process.platform === 'win32') {
        const killer = spawnImpl('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        killer.unref?.()
      } else child.kill('SIGTERM')
    }
    const onAbort = () => {
      terminate()
      finish(abortError())
    }
    timer = setTimeout(() => {
      terminate()
      finish(timeoutError('读取 Pi CLI 帮助超时。'))
    }, timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) { onAbort(); return }
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(0, MAX_HELP) })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(0, MAX_HELP) })
    child.on('error', (error) => finish(new Error(`无法启动 Pi CLI：${error.message}`)))
    child.on('close', (code) => {
      if (code !== 0) {
        finish(new Error(`Pi CLI 帮助检查退出码 ${code ?? 'unknown'}：${stderr.trim() || '无错误输出'}`))
        return
      }
      const help = `${stdout}\n${stderr}`
      const missing = requiredFlags.filter((flag) => !help.includes(flag))
      if (missing.length) {
        finish(new Error(`Pi CLI 缺少织点所需参数：${missing.join(', ')}`))
        return
      }
      finish()
    })
  })
}

export async function runPi({ prompt, cwd, model, readOnly, timeoutMs = 600_000, onEvent = () => undefined, executable = process.env.ZHIDIAN_PI_PATH || 'pi', argsPrefix = [], spawnImpl = spawn, signal }) {
  await checkCompatibility({ executable, cwd, argsPrefix, spawnImpl, timeoutMs: Math.min(timeoutMs, 10_000), signal })
  if (signal?.aborted) throw abortError()
  return new Promise((resolve, reject) => {
    const args = [...argsPrefix, ...buildPiArgs({ model, readOnly, prompt })]
    let child
    try {
      child = spawnImpl(executable, args, { cwd, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      reject(new Error(`无法启动 Pi CLI：${error.message}`))
      return
    }
    let stdout = ''
    let stderr = ''
    let pendingLine = ''
    const events = []
    let settled = false
    let timer
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
        killer.unref?.()
      } else if (child.pid) {
        try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
      } else child.kill('SIGTERM')
    }
    const onAbort = () => {
      terminate()
      finish(abortError())
    }
    timer = setTimeout(() => {
      terminate()
      finish(timeoutError(`Pi CLI 超时（${Math.round(timeoutMs / 1000)} 秒），已终止本次运行。`))
    }, timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) { onAbort(); return }
    const consume = (line) => {
      if (!line.trim()) return
      let event
      try { event = JSON.parse(line) } catch { return }
      if (!event || typeof event !== 'object') return
      events.push(event)
      emitEvent(event, onEvent)
    }
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      if (settled) return
      if (stdout.length + chunk.length > MAX_OUTPUT) {
        terminate()
        finish(new Error('Pi CLI 输出超过大小限制，已终止本次运行。'))
        return
      }
      stdout += chunk
      const lines = `${pendingLine}${chunk}`.split('\n')
      pendingLine = lines.pop() ?? ''
      for (const line of lines) consume(line.replace(/\r$/, ''))
    })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { if (stderr.length < MAX_STDERR) stderr += chunk.slice(0, MAX_STDERR - stderr.length) })
    child.on('error', (error) => finish(new Error(`无法启动 Pi CLI：${error.message}`)))
    child.on('close', (code) => {
      if (pendingLine) consume(pendingLine)
      if (settled) return
      if (code !== 0) {
        finish(new Error(`Pi CLI 退出码 ${code ?? 'unknown'}：${stderr.trim() || '无错误输出'}`))
        return
      }
      const output = finalMessage(events)
      if (!output) {
        finish(new Error('Pi CLI 未返回最终 Agent 结果。'))
        return
      }
      finish(null, { output, executor: 'pi-cli' })
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end()
  })
}
