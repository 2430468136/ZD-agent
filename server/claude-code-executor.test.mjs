import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { buildClaudeCodeArgs, parseClaudeVersion, runClaudeCode } from './claude-code-executor.mjs'

const cwd = process.cwd()
const launcher = `const args=process.argv.slice(1); if(args.includes('--version')) { console.log('2.1.314 (Claude Code)'); process.exit(0) } process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write(JSON.stringify({result:'mock Claude completed'})) })`

test('Claude Code args expose only file tools and enforce working-directory boundaries', () => {
  const readOnly = buildClaudeCodeArgs({ readOnly: true })
  const writable = buildClaudeCodeArgs({ readOnly: false, model: 'fixture-model' })
  assert.ok(readOnly.includes('--restricted'))
  assert.ok(readOnly.includes('Read,Grep,Glob'))
  assert.ok(!readOnly.includes('Edit,Write,Grep,Glob'))
  assert.ok(writable.includes('Read,Edit,Write,Grep,Glob'))
  assert.ok(writable.includes('fixture-model'))
  const settings = JSON.parse(writable[writable.indexOf('--settings') + 1])
  assert.equal(settings.permissions.blockReadsOutsideWorkingDirectories, true)
  assert.equal(settings.permissions.blockWritesOutsideWorkingDirectories, true)
  assert.equal(writable.includes('Bash'), false)
  assert.equal(writable.includes('--no-session-persistence'), true)
})

test('Claude version parser accepts the supported minimum', () => {
  assert.deepEqual(parseClaudeVersion('2.1.314 (Claude Code)'), [2, 1, 314])
  assert.equal(parseClaudeVersion('unknown'), null)
})

test('Claude adapter checks version, sends prompt, parses final JSON and emits completion', async () => {
  const events = []
  const calls = []
  const result = await runClaudeCode({
    prompt: 'fixture prompt',
    cwd,
    readOnly: true,
    executable: process.execPath,
    argsPrefix: ['-e', launcher, '--'],
    spawnImpl: (executable, args, options) => {
      calls.push({ executable, args, options })
      return spawn(executable, args, options)
    },
    onEvent: (event) => events.push(event),
  })
  assert.equal(result.executor, 'claude-code')
  assert.equal(result.output, 'mock Claude completed')
  assert.equal(calls.length, 2)
  assert.equal(calls[1].options.shell, false)
  assert.ok(calls[1].args.includes('--restricted'))
  assert.ok(events.some((event) => event.type === 'harness.completed'))
})

test('Claude adapter refuses an older CLI before starting the agent run', async () => {
  let calls = 0
  const oldLauncher = `if(process.argv.slice(1).includes('--version')) { console.log('2.1.313'); process.exit(0) } process.exit(0)`
  await assert.rejects(runClaudeCode({
    prompt: 'fixture prompt', cwd, readOnly: true, executable: process.execPath,
    argsPrefix: ['-e', oldLauncher, '--'],
    spawnImpl: (executable, args, options) => { calls += 1; return spawn(executable, args, options) },
  }), /要求 2\.1\.314 或更高版本/)
  assert.equal(calls, 1)
})

test('Claude adapter reports nonzero CLI exit without claiming success', async () => {
  const failingLauncher = `const args=process.argv.slice(1); if(args.includes('--version')) { console.log('2.1.314'); process.exit(0) } process.stderr.write('fixture failure'); process.exit(7)`
  await assert.rejects(runClaudeCode({
    prompt: 'fixture prompt', cwd, readOnly: true, executable: process.execPath,
    argsPrefix: ['-e', failingLauncher, '--'],
  }), /退出码 7.*fixture failure/)
})

test('Claude adapter terminates version-check or agent child processes when cancelled', async () => {
  const controller = new AbortController()
  const slowLauncher = `const args=process.argv.slice(1); if(args.includes('--version')) { console.log('2.1.314'); process.exit(0) } setTimeout(() => process.stdout.write('unexpected completion'), 10_000)`
  let markAgentStarted
  const agentStarted = new Promise((resolve) => { markAgentStarted = resolve })
  const pending = runClaudeCode({
    prompt: 'fixture prompt', cwd, readOnly: true, executable: process.execPath,
    argsPrefix: ['-e', slowLauncher, '--'], signal: controller.signal, timeoutMs: 5_000,
    spawnImpl: (executable, args, options) => {
      const child = spawn(executable, args, options)
      if (args.includes('--restricted')) markAgentStarted()
      return child
    },
  })
  await agentStarted
  controller.abort()
  await assert.rejects(pending, { code: 'ABORT_ERR', name: 'AbortError' })
})

