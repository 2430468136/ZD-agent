import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { inspectCodexHarness, inspectDeepSeekHarness } from './harness-discovery.mjs'

async function withFixture({ version = 'codex-cli 0.151.0', account = { requiresOpenaiAuth: false, account: { email: 'must-not-leak@example.test' } } } = {}, run) {
  const directory = await mkdtemp(join(tmpdir(), 'zhidian-codex-discovery-'))
  const script = join(directory, 'fixture.cjs')
  await writeFile(script, `
const readline = require('node:readline')
if (process.argv.includes('--version')) { process.stdout.write(${JSON.stringify(version)}); process.exit(0) }
const input = readline.createInterface({ input: process.stdin })
input.on('line', line => {
  const message = JSON.parse(line)
  const result = message.method === 'account/read' ? ${JSON.stringify(account)} : { ok: true }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n')
})
`, 'utf8')
  try { await run(process.execPath, [script]) } finally { await rm(directory, { recursive: true, force: true }) }
}

test('Codex discovery reports installed, authenticated capability status without account details', async () => {
  await withFixture({}, async (executable, argsPrefix) => {
    const result = await inspectCodexHarness({ executable, argsPrefix })
    assert.deepEqual(result, {
      id: 'codex-app-server', name: 'Codex App Server', installed: true, compatible: true,
      status: 'connected', version: '0.151.0', capabilities: ['thread-resume', 'events', 'cancel', 'approval-deny'],
    })
    assert.equal(JSON.stringify(result).includes('must-not-leak'), false)
  })
})

test('Codex discovery distinguishes a missing login and blocks an old version before probing app-server', async () => {
  await withFixture({ account: { requiresOpenaiAuth: true } }, async (executable, argsPrefix) => {
    const result = await inspectCodexHarness({ executable, argsPrefix })
    assert.equal(result.status, 'login-required')
  })
  await withFixture({ version: 'codex-cli 0.150.9' }, async (executable, argsPrefix) => {
    const result = await inspectCodexHarness({ executable, argsPrefix })
    assert.equal(result.status, 'incompatible')
    assert.equal(result.compatible, false)
    assert.equal(result.minimumVersion, '0.151.0')
  })
})

test('Codex discovery reports missing executables without leaking low-level errors', async () => {
  const result = await inspectCodexHarness({ executable: 'zhidian-codex-does-not-exist-927361' })
  assert.equal(result.status, 'not-installed')
  assert.equal(result.version, null)
})

test('DeepSeek discovery reads only the CLI version and never probes profile or account state', async () => {
  await withFixture({ version: 'dsh 0.2.2-rc.5', account: { account: { email: 'must-not-leak@example.test' } } }, async (executable, argsPrefix) => {
    let observedOptions
    const result = await inspectDeepSeekHarness({
      executable,
      argsPrefix,
      spawnImpl: (file, args, options) => {
        observedOptions = options
        return spawn(file, args, options)
      },
    })
    assert.deepEqual(result, {
      id: 'deepseek-harness', name: 'DeepSeek Harness', installed: true, compatible: false,
      status: 'integration-pending', version: '0.2.2-rc.5', capabilities: [],
      message: '已发现 dsh CLI；目前只完成版本探测。SDK 运行时、独立 DSH_HOME、隐私补丁与真实任务验收尚未完成，因此不会分配任务，也不会读取或复用桌面端配置。',
    })
    assert.equal(observedOptions.shell, false)
    assert.equal(typeof observedOptions.env.DSH_HOME, 'string')
    assert.notEqual(observedOptions.env.DSH_HOME, process.env.DSH_HOME)
    assert.equal(existsSync(observedOptions.env.DSH_HOME), false)
    assert.equal('CODEX_HOME' in observedOptions.env, false)
    assert.equal('DEEPSEEK_API_KEY' in observedOptions.env, false)
    assert.equal(JSON.stringify(result).includes('must-not-leak'), false)
  })
})

test('DeepSeek discovery reports a missing CLI without reading local profile state', async () => {
  const result = await inspectDeepSeekHarness({ executable: 'zhidian-dsh-does-not-exist-927361' })
  assert.equal(result.installed, false)
  assert.equal(result.compatible, false)
  assert.equal(result.status, 'not-installed')
  assert.equal(result.version, null)
  assert.equal(JSON.stringify(result).includes('HOME'), false)
})