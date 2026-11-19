import test from 'node:test'
import assert from 'node:assert/strict'
import { createExecutorRegistry } from './executor-registry.mjs'

const capabilities = {
  projectRead: 'bounded-snapshot',
  workspaceAccess: 'patch',
  fileWrite: 'proposed-patch-after-project-check',
  commandExecution: 'exact-project-allowlist',
  networkAccess: 'configured-provider-api',
}

function adapter(overrides = {}) {
  return {
    id: 'fixture-api',
    name: 'Fixture API',
    capabilities,
    isConfigured: (agent) => typeof agent?.model === 'string' && Boolean(agent.model.trim()),
    run: async () => ({ output: 'fixture result', provider: 'fixture' }),
    ...overrides,
  }
}

const context = (overrides = {}) => ({ phase: 'specialist-execute', accessMode: 'write', prompt: 'fixture', ...overrides })

test('registry exposes explicit capabilities, configuration, and adapter timeout defaults', () => {
  const registry = createExecutorRegistry([adapter()])
  assert.deepEqual(registry.list(), [{ id: 'fixture-api', name: 'Fixture API', description: '', provider: '', defaultModel: '', modelPlaceholder: '填写服务商要求的 Model ID', capabilities }])
  assert.equal(registry.get('fixture-api').timeoutMs, 60_000)
  assert.equal(registry.isConfigured('fixture-api', { model: 'model-x' }), true)
  assert.equal(registry.isConfigured('fixture-api', { model: ' ' }), false)
  assert.equal(registry.isConfigured('unregistered', { model: 'model-x' }), false)
  assert.equal(Object.isFrozen(registry.get('fixture-api').capabilities), true)
  assert.equal(Object.isFrozen(registry.get('fixture-api')), true)
})

test('registry invokes adapters through one contract, passes cancellation and events, and preserves metadata', async () => {
  const events = []
  const registry = createExecutorRegistry([adapter({ run: async ({ onEvent, signal, timeoutMs }) => {
    assert.equal(signal instanceof AbortSignal, true)
    assert.equal(timeoutMs, 60_000)
    onEvent({ type: 'fixture.started' })
    return { output: 'fixture result', provider: 'fixture' }
  } })])
  assert.deepEqual(await registry.run('fixture-api', { ...context(), onEvent: (event) => events.push(event) }), { output: 'fixture result', provider: 'fixture' })
  assert.deepEqual(events, [{ type: 'fixture.started' }])
  assert.deepEqual(await createExecutorRegistry([adapter({ run: async () => 'plain result' })]).run('fixture-api', context()), { output: 'plain result' })
})

test('registry fails closed on unknown executors, malformed results, and incomplete capabilities', async () => {
  const registry = createExecutorRegistry([adapter({ run: async () => ({ output: '' }) })])
  await assert.rejects(registry.run('typo-cli', context()), { code: 'UNKNOWN_EXECUTOR' })
  await assert.rejects(registry.run('fixture-api', context()), { code: 'INVALID_EXECUTOR_RESULT' })
  assert.throws(() => createExecutorRegistry([adapter(), adapter()]), /Duplicate executor id/)
  assert.throws(() => createExecutorRegistry([adapter({ capabilities: { projectRead: 'bounded-snapshot' } })]), /all capabilities/)
  assert.throws(() => createExecutorRegistry([adapter({ capabilities: { ...capabilities, commandExecution: 'maybe-shell' } })]), /recognized values/)
  assert.throws(() => createExecutorRegistry([adapter({ timeoutMs: 0 })]), /positive integer timeoutMs/)
})

test('registry authorization rejects write-capable executors in read-only specialist phases and sandboxed command execution without execute access', () => {
  const direct = createExecutorRegistry([adapter({
    capabilities: { ...capabilities, workspaceAccess: 'direct', fileWrite: 'direct-when-project-authorized', commandExecution: 'codex-workspace-sandbox' },
  })])
  assert.throws(() => direct.authorize('fixture-api', { phase: 'specialist-execute', accessMode: 'read-only' }), { code: 'EXECUTOR_PERMISSION_DENIED', status: 403 })
  assert.throws(() => direct.authorize('fixture-api', { phase: 'specialist-execute', accessMode: 'write' }), { code: 'EXECUTOR_PERMISSION_DENIED', status: 403 })
  assert.equal(direct.authorize('fixture-api', { phase: 'specialist-execute', accessMode: 'execute' }).id, 'fixture-api')
  assert.throws(() => direct.authorize('fixture-api', { phase: 'unknown', accessMode: 'execute' }), { code: 'EXECUTOR_PERMISSION_DENIED', status: 403 })
})

test('only an explicitly configured snapshot adapter may use result-only specialist mode', async () => {
  const readOnly = context({ accessMode: 'read-only' })
  await assert.rejects(createExecutorRegistry([adapter()]).run('fixture-api', readOnly), { code: 'EXECUTOR_PERMISSION_DENIED' })
  const snapshotOnly = { ...capabilities, readOnlySpecialist: 'snapshot-result-only' }
  const registry = createExecutorRegistry([adapter({ capabilities: snapshotOnly })])
  assert.equal(registry.list()[0].capabilities.readOnlySpecialist, 'snapshot-result-only')
  assert.equal((await registry.run('fixture-api', readOnly)).output, 'fixture result')
  assert.throws(() => createExecutorRegistry([adapter({ capabilities: { ...snapshotOnly, workspaceAccess: 'direct' } })]), /guarded snapshot adapter/)
  assert.throws(() => createExecutorRegistry([adapter({ capabilities: { ...snapshotOnly, commandExecution: 'codex-workspace-sandbox' } })]), /guarded snapshot adapter/)
})

test('registry aborts an active adapter and prevents late events from escaping', async () => {
  const controller = new AbortController()
  let started
  const hasStarted = new Promise((resolve) => { started = resolve })
  const emitted = []
  const registry = createExecutorRegistry([adapter({ run: ({ signal, onEvent }) => new Promise((resolve, reject) => {
    started()
    signal.addEventListener('abort', () => {
      onEvent({ type: 'fixture.too-late' })
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    }, { once: true })
  }) })])
  const pending = registry.run('fixture-api', { ...context(), signal: controller.signal, onEvent: (event) => emitted.push(event) })
  await hasStarted
  controller.abort()
  await assert.rejects(pending, { code: 'ABORT_ERR', name: 'AbortError' })
  assert.deepEqual(emitted, [])
})

test('registry classifies timeout, aborts the adapter, and does not hang when it ignores abort', async () => {
  let observedSignal
  const registry = createExecutorRegistry([adapter({ run: ({ signal }) => {
    observedSignal = signal
    return new Promise(() => undefined)
  } })])
  await assert.rejects(registry.run('fixture-api', { ...context(), timeoutMs: 15 }), { code: 'EXECUTOR_TIMEOUT', name: 'TimeoutError', status: 504 })
  assert.equal(observedSignal.aborted, true)
})

test('registry preserves adapter failures and classifies timeout errors', async () => {
  const failure = Object.assign(new Error('provider denied'), { code: 'PROVIDER_DENIED' })
  await assert.rejects(createExecutorRegistry([adapter({ run: async () => { throw failure } })]).run('fixture-api', context()), { code: 'PROVIDER_DENIED' })
  await assert.rejects(createExecutorRegistry([adapter({ run: async () => { throw new Error('provider request timeout') } })]).run('fixture-api', context()), { code: 'EXECUTOR_TIMEOUT', name: 'TimeoutError' })
})
