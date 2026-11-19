import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { buildCodexExecArgs, runCodexCli } from './codex-executor.mjs'

const cwd = process.cwd()

test('Codex CLI receives approval policy before exec and the correct sandbox after exec', () => {
  for (const [readOnly, mode] of [[true, 'read-only'], [false, 'workspace-write']]) {
    const args = buildCodexExecArgs({ cwd, readOnly, model: 'fixture-model' })
    assert.deepEqual(args.slice(0, 6), ['--ask-for-approval', 'never', 'exec', '--json', '--sandbox', mode])
    assert.deepEqual(args.slice(-3), ['--model', 'fixture-model', '-'])
  }
})

test('installed Codex CLI parses Zhidian exec options without calling a model', { skip: !process.env.ZHIDIAN_TEST_CODEX_PATH }, () => {
  for (const readOnly of [true, false]) {
    const args = buildCodexExecArgs({ cwd, readOnly, model: 'fixture-model' })
    const result = spawnSync(process.env.ZHIDIAN_TEST_CODEX_PATH, [...args, '--help'], { cwd, windowsHide: true, encoding: 'utf8', timeout: 10_000 })
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Usage: codex exec\b/)
  }
})

test('Codex CLI adapter parses final JSONL message and forwards activity events', async () => {
  const events = []
  const script = `process.stdin.resume(); process.stdin.on('end', () => { console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution'}})); console.log(JSON.stringify({type:'turn.completed',last_agent_message:'mock Codex completed'})); })`
  const result = await runCodexCli({
    prompt: 'fixture prompt',
    cwd,
    readOnly: true,
    executable: process.execPath,
    argsPrefix: ['-e', script, '--'],
    onEvent: (event) => events.push(event),
  })
  assert.equal(result.executor, 'codex-cli')
  assert.equal(result.output, 'mock Codex completed')
  assert.ok(events.some((event) => event.type === 'item.completed'))
})

test('Codex CLI adapter reports nonzero process exit without claiming success', async () => {
  const script = `process.stderr.write('fixture failure'); process.exit(7)`
  await assert.rejects(
    runCodexCli({ prompt: 'fixture prompt', cwd, readOnly: true, executable: process.execPath, argsPrefix: ['-e', script, '--'] }),
    /退出码 7.*fixture failure/,
  )
})

test('Codex CLI adapter terminates the active child process when its signal is aborted', async () => {
  const controller = new AbortController()
  const script = 'setTimeout(() => process.stdout.write("unexpected completion"), 10_000)'
  const pending = runCodexCli({ prompt: 'fixture prompt', cwd, readOnly: true, executable: process.execPath, argsPrefix: ['-e', script, '--'], signal: controller.signal, timeoutMs: 5_000 })
  setTimeout(() => controller.abort(), 100)
  await assert.rejects(pending, { code: 'ABORT_ERR', name: 'AbortError' })
})
