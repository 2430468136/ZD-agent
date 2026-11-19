const capabilityValues = {
  projectRead: new Set(['bounded-snapshot', 'authorized-workspace', 'none']),
  workspaceAccess: new Set(['patch', 'direct', 'none']),
  fileWrite: new Set([
    'proposed-patch-after-project-check',
    'direct-when-project-authorized',
    'direct-file-tools-when-project-authorized',
    'none',
  ]),
  commandExecution: new Set(['exact-project-allowlist', 'codex-workspace-sandbox', 'disabled-shell-tools', 'none']),
  networkAccess: new Set(['configured-provider-api', 'deepseek-api-only', 'not-enforced-by-zhidian-prompt-only', 'none']),
}

const phases = new Set(['ceo-plan', 'specialist-execute', 'qa-review'])
const accessModes = new Set(['read-only', 'write', 'execute'])

function canUseSnapshotOnly(capabilities) {
  return capabilities.projectRead === 'bounded-snapshot' && capabilities.workspaceAccess === 'patch' &&
    capabilities.fileWrite === 'proposed-patch-after-project-check' && capabilities.commandExecution === 'exact-project-allowlist'
}

function executorError(message, code, status = 500) {
  return Object.assign(new Error(message), { code, status })
}

function abortError(message = '执行器运行已取消。') {
  return Object.assign(new Error(message), { name: 'AbortError', code: 'ABORT_ERR', status: 499 })
}

function timeoutError(adapter, timeoutMs) {
  return Object.assign(executorError(`执行器“${adapter.name}”运行超时（${timeoutMs} ms）。`, 'EXECUTOR_TIMEOUT', 504), { name: 'TimeoutError' })
}

function normalizeFailure(error) {
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
    return Object.assign(new Error(error.message || '执行器运行已取消。'), { name: 'AbortError', code: 'ABORT_ERR', status: 499 })
  }
  if (error?.name === 'TimeoutError' || error?.code === 'EXECUTOR_TIMEOUT' || /超时|timed?\s*out/i.test(error?.message ?? '')) {
    return Object.assign(new Error(error.message || '执行器运行超时。'), { name: 'TimeoutError', code: 'EXECUTOR_TIMEOUT', status: 504 })
  }
  return error instanceof Error ? error : new Error(String(error))
}

function freezeDefinition(definition) {
  if (!definition || typeof definition.id !== 'string' || !definition.id.trim()) throw new TypeError('Executor id must be a non-empty string.')
  if (typeof definition.name !== 'string' || !definition.name.trim()) throw new TypeError(`Executor ${definition.id} must declare a name.`)
  if (!definition.capabilities || Object.keys(capabilityValues).some((field) => !capabilityValues[field].has(definition.capabilities[field]))) {
    throw new TypeError(`Executor ${definition.id} must declare all capabilities with recognized values.`)
  }
  const { readOnlySpecialist } = definition.capabilities
  if (readOnlySpecialist !== undefined && (readOnlySpecialist !== 'snapshot-result-only' || !canUseSnapshotOnly(definition.capabilities))) {
    throw new TypeError(`Executor ${definition.id} may declare snapshot-result-only only for a guarded snapshot adapter.`)
  }
  if (typeof definition.isConfigured !== 'function' || typeof definition.run !== 'function') {
    throw new TypeError(`Executor ${definition.id} must declare isConfigured() and run().`)
  }
  const timeoutMs = definition.timeoutMs ?? 60_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError(`Executor ${definition.id} must declare a positive integer timeoutMs.`)
  return Object.freeze({
    id: definition.id,
    name: definition.name,
    description: typeof definition.description === 'string' ? definition.description : '',
    provider: typeof definition.provider === 'string' ? definition.provider : '',
    defaultModel: typeof definition.defaultModel === 'string' ? definition.defaultModel : '',
    modelPlaceholder: typeof definition.modelPlaceholder === 'string' ? definition.modelPlaceholder : '填写服务商要求的 Model ID',
    timeoutMs,
    capabilities: Object.freeze({ ...definition.capabilities }),
    isConfigured: definition.isConfigured,
    run: definition.run,
  })
}

export function createExecutorRegistry(definitions) {
  const adapters = new Map()
  for (const definition of definitions) {
    const adapter = freezeDefinition(definition)
    if (adapters.has(adapter.id)) throw new TypeError(`Duplicate executor id: ${adapter.id}`)
    adapters.set(adapter.id, adapter)
  }

  function get(id) {
    return adapters.get(id)
  }

  function requireAdapter(id) {
    const adapter = get(id)
    if (!adapter) throw executorError(`未注册执行器“${id ?? ''}”；为避免静默降级，已拒绝运行。`, 'UNKNOWN_EXECUTOR', 400)
    return adapter
  }

  function authorize(id, { phase, accessMode } = {}) {
    const adapter = requireAdapter(id)
    const { capabilities } = adapter
    if (!phases.has(phase) || !accessModes.has(accessMode)) {
      throw executorError('执行器缺少有效的工作流阶段或项目授权范围。', 'EXECUTOR_PERMISSION_DENIED', 403)
    }
    if (capabilities.projectRead === 'none') {
      throw executorError(`执行器“${adapter.name}”未声明项目读取能力，已拒绝运行。`, 'EXECUTOR_PERMISSION_DENIED', 403)
    }
    if (phase === 'specialist-execute') {
      if (accessMode === 'read-only' && capabilities.fileWrite !== 'none' && capabilities.readOnlySpecialist !== 'snapshot-result-only') {
        throw executorError(`项目授权为只读；执行器“${adapter.name}”声明了写入能力，已拒绝执行。`, 'EXECUTOR_PERMISSION_DENIED', 403)
      }
      if (capabilities.workspaceAccess === 'direct' && accessMode === 'read-only') {
        throw executorError(`项目授权为只读；执行器“${adapter.name}”不能直接操作工作区。`, 'EXECUTOR_PERMISSION_DENIED', 403)
      }
      if (capabilities.commandExecution === 'codex-workspace-sandbox' && accessMode !== 'execute') {
        throw executorError(`执行器“${adapter.name}”可在沙箱内执行命令；项目必须明确授权为 execute。`, 'EXECUTOR_PERMISSION_DENIED', 403)
      }
    }
    return adapter
  }

  return Object.freeze({
    get,
    has: (id) => adapters.has(id),
    list: () => [...adapters.values()].map(({ id, name, description, provider, defaultModel, modelPlaceholder, capabilities }) => ({ id, name, description, provider, defaultModel, modelPlaceholder, capabilities: { ...capabilities } })),
    isConfigured(id, agent, context) {
      const adapter = get(id)
      if (!adapter) return false
      try { return adapter.isConfigured(agent, context) === true } catch { return false }
    },
    authorize,
    async run(id, context = {}) {
      const adapter = authorize(id, context)
      if (context.signal?.aborted) throw abortError()
      const timeoutMs = context.timeoutMs ?? adapter.timeoutMs
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs must be a positive integer.')

      const controller = new AbortController()
      let timedOut = false
      const abortFromCaller = () => controller.abort()
      context.signal?.addEventListener('abort', abortFromCaller, { once: true })
      const timeout = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, timeoutMs)
      const aborted = new Promise((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(timedOut ? timeoutError(adapter, timeoutMs) : abortError()), { once: true })
      })
      if (context.signal?.aborted) controller.abort()

      try {
        const operation = Promise.resolve().then(() => adapter.run({
          ...context,
          timeoutMs,
          signal: controller.signal,
          onEvent: (event) => {
            if (!controller.signal.aborted && typeof context.onEvent === 'function') context.onEvent(event)
          },
        }))
        const result = await Promise.race([operation, aborted])
        if (timedOut) throw timeoutError(adapter, timeoutMs)
        if (context.signal?.aborted) throw abortError()
        const output = typeof result === 'string' ? result : result?.output
        if (typeof output !== 'string' || !output.trim()) {
          throw executorError(`执行器“${adapter.name}”未返回有效文本结果。`, 'INVALID_EXECUTOR_RESULT')
        }
        return typeof result === 'string' ? { output } : { ...result, output }
      } catch (error) {
        if (timedOut) throw timeoutError(adapter, timeoutMs)
        if (context.signal?.aborted) throw abortError()
        throw normalizeFailure(error)
      } finally {
        clearTimeout(timeout)
        context.signal?.removeEventListener('abort', abortFromCaller)
      }
    },
  })
}
