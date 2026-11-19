import { spawn } from 'node:child_process'

const MAX_LINE_BYTES = 1_000_000
const MAX_OUTPUT_CHARS = 1_000_000

function abortError(message = 'Codex app-server 运行已取消。') {
  return Object.assign(new Error(message), { name: 'AbortError', code: 'ABORT_ERR' })
}

function safeFailure(error, fallback = 'Codex app-server 调用失败。') {
  const detail = typeof error?.message === 'string' ? error.message : ''
  const redacted = detail
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|ds-[A-Za-z0-9_-]{12,})\b/g, '[已脱敏凭据]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~-]{12,}/gi, '$1[已脱敏凭据]')
    .replace(/([?&](?:token|key|secret)=)[^&\s]+/gi, '$1[已脱敏]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 320)
  return redacted ? `${fallback} ${redacted}` : fallback
}


function codexEnvironment() {
  const allowed = [
    'PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'USERPROFILE',
    'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'TEMP', 'TMP',
    'OS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'CODEX_HOME',
  ]
  const env = Object.fromEntries(allowed.filter((key) => process.env[key]).map((key) => [key, process.env[key]]))
  env.RUST_LOG = 'error'
  return env
}

function textFromItem(item) {
  if (!item || item.type !== 'agentMessage') return ''
  return typeof item.text === 'string' ? item.text : ''
}

function finalText(turn, completedItems) {
  const fromTurn = Array.isArray(turn?.items) ? turn.items.map(textFromItem).filter(Boolean).join('\n').trim() : ''
  return (fromTurn || completedItems.join('\n').trim()).slice(0, MAX_OUTPUT_CHARS)
}

function eventMessage(method, params) {
  if (method === 'turn/started') return { type: 'codex.turn.started', message: 'Codex 已开始处理。' }
  if (method === 'turn/completed') return { type: `codex.turn.${params?.turn?.status ?? 'completed'}`, message: params?.turn?.status === 'completed' ? 'Codex 已完成本轮。' : 'Codex 本轮已结束。' }
  if (method === 'item/started') {
    const type = params?.item?.type
    return { type: 'codex.item.started', message: type === 'commandExecution' ? 'Codex 正在运行工作区命令。' : type === 'fileChange' ? 'Codex 正在修改授权工作区文件。' : 'Codex 正在处理工作区内容。' }
  }
  if (method === 'item/completed') return { type: 'codex.item.completed', message: 'Codex 完成一个处理步骤。' }
  if (method === 'item/agentMessage/delta') return { type: 'codex.message.delta', message: 'Codex 正在生成回复。' }
  if (method === 'item/commandExecution/outputDelta' || method === 'command/exec/outputDelta') return { type: 'codex.command.output', message: 'Codex 工作区命令有新输出。' }
  if (method === 'turn/plan/updated') return { type: 'codex.plan.updated', message: 'Codex 更新了执行计划。' }
  if (method === 'turn/diff/updated') return { type: 'codex.diff.updated', message: 'Codex 更新了文件差异。' }
  return null
}

function deniedApproval(method) {
  if (method === 'item/commandExecution/requestApproval') return { decision: 'cancel' }
  if (method === 'item/fileChange/requestApproval') return { decision: 'cancel' }
  if (method === 'applyPatchApproval') return { decision: 'abort' }
  if (method === 'execCommandApproval') return { decision: 'abort' }
  return null
}

function waitForProcessEnd(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    const finish = (ended) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(ended)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    child.once('close', () => finish(true))
    child.once('error', () => finish(true))
  })
}

export async function stopProcess(child, timeoutMs = 2_000, {
  platform = process.platform,
  spawnImpl = spawn,
  killerTimeoutMs = 5_000,
  exitTimeoutMs = 3_000,
} = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  try { child.stdin.end() } catch { /* process may already be exiting */ }
  if (await waitForProcessEnd(child, timeoutMs)) return

  if (platform === 'win32' && child.pid) {
    let killer
    try {
      killer = spawnImpl('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } catch { /* Fall back to terminating the child process. */ }
    if (killer) {
      const killerEnded = await waitForProcessEnd(killer, killerTimeoutMs)
      if (!killerEnded) {
        try { killer.kill() } catch { /* helper may have exited during timeout */ }
      }
      // taskkill can return before Node observes the target's close event.
      if (!await waitForProcessEnd(child, 250) && child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGTERM') } catch { /* target may already be gone */ }
      }
    } else {
      try { child.kill('SIGTERM') } catch { /* target may already be gone */ }
    }
  } else {
    try { child.kill('SIGTERM') } catch { /* target may already be gone */ }
  }
  await waitForProcessEnd(child, exitTimeoutMs)
}

export function runCodexAppServer({
  prompt,
  cwd,
  model,
  readOnly = false,
  timeoutMs = 600_000,
  onEvent = () => undefined,
  onHarnessThread = () => undefined,
  harnessThreadId,
  executable = process.env.ZHIDIAN_CODEX_PATH || 'codex',
  argsPrefix = [],
  signal,
}) {
  if (typeof prompt !== 'string' || !prompt.trim()) return Promise.reject(new TypeError('prompt must be a non-empty string.'))
  if (typeof cwd !== 'string' || !cwd.trim()) return Promise.reject(new TypeError('cwd must be a non-empty path.'))
  if (signal?.aborted) return Promise.reject(abortError())

  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(executable, [...argsPrefix, 'app-server', '--stdio'], {
        cwd,
        windowsHide: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: codexEnvironment(),
      })
    } catch (error) {
      reject(new Error(safeFailure(error, '无法启动本机 Codex app-server。')))
      return
    }

    let lineBuffer = ''
    let nextRequestId = 0
    let settled = false
    let threadId = harnessThreadId || null
    let turnId = null
    let completedTurn = null
    let resolveTurnCompletion = null
    const outputItems = []
    const pending = new Map()

    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      for (const request of pending.values()) request.reject(error ?? new Error('Codex app-server connection closed.'))
      pending.clear()
      if (error) resolveTurnCompletion?.(null)
      void stopProcess(child).finally(() => error ? reject(error) : resolve(value))
    }

    const send = (message) => {
      if (child.stdin.destroyed || !child.stdin.writable) throw new Error('Codex app-server input is closed.')
      child.stdin.write(`${JSON.stringify(message)}\n`)
    }

    const rpc = (method, params = {}, requestTimeoutMs = 20_000) => {
      if (signal?.aborted) return Promise.reject(abortError())
      const id = ++nextRequestId
      return new Promise((resolveRequest, rejectRequest) => {
        const requestTimer = setTimeout(() => {
          pending.delete(id)
          rejectRequest(Object.assign(new Error(`${method} request timed out.`), { code: 'EXECUTOR_TIMEOUT' }))
        }, requestTimeoutMs)
        pending.set(id, {
          resolve: (value) => { clearTimeout(requestTimer); resolveRequest(value) },
          reject: (error) => { clearTimeout(requestTimer); rejectRequest(error) },
        })
        try { send({ jsonrpc: '2.0', id, method, params }) } catch (error) {
          clearTimeout(requestTimer)
          pending.delete(id)
          rejectRequest(error)
        }
      })
    }

    const handleMessage = (message) => {
      if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
        const request = pending.get(message.id)
        if (!request) return
        pending.delete(message.id)
        if (message.error) request.reject(Object.assign(new Error(message.error.message || 'app-server request failed.'), { code: message.error.code }))
        else request.resolve(message.result)
        return
      }
      if (message.id !== undefined && typeof message.method === 'string') {
        const decision = deniedApproval(message.method)
        if (decision) {
          try { onEvent({ type: 'codex.approval.denied', message: 'Codex 请求了额外权限；织点未自动批准。' }) } catch { /* event consumers must not break the harness */ }
          try { send({ jsonrpc: '2.0', id: message.id, result: decision }) } catch { /* shutdown will reject the active request */ }
        } else {
          const isPermissionRequest = message.method === 'item/permissions/requestApproval'
          if (isPermissionRequest) {
            try { onEvent({ type: 'codex.approval.denied', message: 'Codex 请求扩大权限；织点未授予额外访问权限。' }) } catch { /* ignore event callback failure */ }
          }
          try { send({ jsonrpc: '2.0', id: message.id, error: { code: isPermissionRequest ? -32000 : -32601, message: isPermissionRequest ? 'Additional permissions were not granted.' : 'Unsupported app-server request.' } }) } catch { /* process is closing */ }
        }
        return
      }
      if (typeof message.method !== 'string') return
      const params = message.params ?? {}
      if (message.method === 'thread/started' && !threadId) {
        threadId = params.thread?.id ?? params.threadId ?? null
      }
      if (message.method === 'turn/started' && params.threadId === threadId) turnId = params.turn?.id ?? null
      if (message.method === 'item/completed' && params.threadId === threadId) {
        const text = textFromItem(params.item)
        if (text) outputItems.push(text)
      }
      if (message.method === 'turn/completed' && params.threadId === threadId) {
        completedTurn = params.turn
        resolveTurnCompletion?.(completedTurn)
        resolveTurnCompletion = null
      }
      const event = eventMessage(message.method, params)
      if (event) {
        try { onEvent(event) } catch { /* event consumers must not break the harness */ }
      }
    }

    const onAbort = () => {
      if (threadId && turnId) {
        try { send({ jsonrpc: '2.0', id: ++nextRequestId, method: 'turn/interrupt', params: { threadId, turnId } }) } catch { /* terminate below */ }
      }
      finish(abortError())
    }

    const timer = setTimeout(() => finish(Object.assign(new Error(`Codex app-server 超时（${Math.round(timeoutMs / 1000)} 秒）。`), { name: 'TimeoutError', code: 'EXECUTOR_TIMEOUT' })), timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.setEncoding('utf8')
    child.stderr.resume()
    child.stdout.on('data', (chunk) => {
      lineBuffer += chunk
      if (Buffer.byteLength(lineBuffer, 'utf8') > MAX_LINE_BYTES) {
        finish(new Error('Codex app-server 返回的协议消息超过大小限制。'))
        return
      }
      const lines = lineBuffer.split(/\r?\n/)
      lineBuffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line) continue
        let message
        try { message = JSON.parse(line) } catch {
          finish(new Error('Codex app-server 返回了无效 JSON-RPC 消息。'))
          return
        }
        handleMessage(message)
      }
    })
    child.once('error', (error) => finish(new Error(safeFailure(error, '无法启动本机 Codex app-server。'))))
    child.once('close', (code) => {
      if (!settled) finish(Object.assign(new Error(`Codex app-server 意外退出（${code ?? 'unknown'}）。`), { code: 'CODEX_APP_SERVER_EXIT' }))
    })

    void (async () => {
      const initialized = await rpc('initialize', {
        clientInfo: { name: 'zhidian', title: '织点', version: '0.0.0' },
        capabilities: { experimentalApi: false },
      })
      if (!initialized) throw new Error('Codex app-server 未完成初始化。')
      send({ jsonrpc: '2.0', method: 'initialized', params: {} })

      if (threadId) {
        const resumed = await rpc('thread/resume', { threadId, cwd, sandbox: readOnly ? 'read-only' : 'workspace-write', approvalPolicy: 'never', excludeTurns: true })
        const resumedId = resumed?.thread?.id ?? resumed?.threadId
        if (resumedId !== threadId) throw new Error('Codex app-server 恢复了不同的工作线程；已停止以避免串线。')
        try { onEvent({ type: 'codex.thread.resumed', message: '已恢复 Codex 工作线程。' }) } catch { /* ignore event callback failure */ }
      } else {
        const started = await rpc('thread/start', { cwd, sandbox: readOnly ? 'read-only' : 'workspace-write', approvalPolicy: 'never', ephemeral: false, ...(model ? { model } : {}) })
        threadId = started?.thread?.id ?? started?.threadId ?? null
        if (typeof threadId !== 'string' || !threadId) throw new Error('Codex app-server 未返回有效工作线程 ID。')
        await onHarnessThread(threadId)
        try { onEvent({ type: 'codex.thread.started', message: '已创建 Codex 工作线程。' }) } catch { /* ignore event callback failure */ }
      }

      const completion = new Promise((resolveTurn) => { resolveTurnCompletion = resolveTurn })
      await rpc('turn/start', { threadId, input: [{ type: 'text', text: `${prompt}\n\n[系统约束] 不得尝试提升权限、绕过沙箱或访问授权工作区之外的内容。` }], ...(model ? { model } : {}) })
      const turn = completedTurn ?? await completion
      if (signal?.aborted || !turn || turn.status === 'interrupted') throw abortError()
      if (turn.status === 'failed') throw new Error(safeFailure(new Error(turn.error?.message || 'Codex 未能完成本轮。')))
      if (turn.status !== 'completed') throw new Error(`Codex app-server 返回非完成状态：${turn.status ?? 'unknown'}。`)
      const output = finalText(turn, outputItems)
      if (!output) throw new Error('Codex app-server 未返回有效的最终文本结果。')
      finish(null, { output, executor: 'codex-app-server', harnessThreadId: threadId, harnessTurnId: turn.id })
    })().catch((error) => finish(error?.name === 'AbortError' || error?.code === 'ABORT_ERR' ? abortError() : error))
  })
}





