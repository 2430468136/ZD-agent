import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { buildPiArgs, runPi } from './pi-executor.mjs'

const cwd = process.cwd()
const help = '--mode --no-session --no-extensions --no-mcp --no-skills --no-prompt-templates --no-themes --no-context-files --tools'
const launcher = `const args=process.argv.slice(1); if(args.includes('--help')) { console.log(${JSON.stringify(help)}); process.exit(0) } console.log(JSON.stringify({type:'agent_start'})); console.log(JSON.stringify({type:'tool_execution_start',toolName:'read'})); console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'mock Pi completed'}]}})); console.log(JSON.stringify({type:'agent_settled',aborted:false}));`

test('Pi args disable persistence, extensions, MCP, project resources, and shell tools', () => {
  const readOnly = buildPiArgs({ readOnly: true, prompt: 'fixture prompt' })
  const writable = buildPiArgs({ readOnly: false, model: 'fixture-model', prompt: 'fixture prompt' })
  assert.ok(readOnly.includes('--mode') && readOnly.includes('json'))
  assert.ok(readOnly.includes('--no-session'))
  assert.ok(readOnly.includes('--no-extensions'))
  assert.ok(readOnly.includes('--no-mcp'))
  assert.ok(readOnly.includes('--no-context-files'))
  assert.equal(readOnly[readOnly.indexOf('--tools') + 1], 'read,grep,find,ls')
  assert.equal(writable[writable.indexOf('--tools') + 1], 'read,grep,find,ls,edit,write')
  assert.equal(writable.includes('bash'), false)
  assert.equal(writable.includes('powershell'), false)
  assert.ok(writable.includes('fixture-model'))
  assert.equal(writable.at(-1), 'fixture prompt')
})

test('Pi adapter checks the CLI contract, parses JSONL final output, and emits safe activity events', async () => {
  const events = []
  const calls = []
  const result = await runPi({
    prompt: 'fixture prompt', cwd, readOnly: true, executable: process.execPath,
    argsPrefix: ['-e', launcher, '--'],
    spawnImpl: (executable, args, options) => { calls.push({ executable, args, options }); return spawn(executable, args, options) },
    onEvent: (event) => events.push(event),
  })
  assert.equal(result.executor, 'pi-cli')
  assert.equal(result.output, 'mock Pi completed')
  assert.equal(calls.length, 2)
  assert.equal(calls[1].options.shell, false)
  assert.ok(calls[1].args.includes('--no-mcp'))
  assert.ok(events.some((event) => event.type === 'pi.tool_execution_start'))
})

test('Pi adapter rejects a CLI without the required isolation flags', async () => {
  const oldLauncher = `if(process.argv.slice(1).includes('--help')) { console.log('--mode --tools'); process.exit(0) } process.exit(0)`
  await assert.rejects(runPi({ prompt: 'fixture', cwd, readOnly: true, executable: process.execPath, argsPrefix: ['-e', oldLauncher, '--'] }), /缺少织点所需参数/)
})

test('Pi adapter reports nonzero CLI exit without claiming success', async () => {
  const failingLauncher = `const args=process.argv.slice(1); if(args.includes('--help')) { console.log(${JSON.stringify(help)}); process.exit(0) } process.stderr.write('fixture failure'); process.exit(7)`
  await assert.rejects(runPi({ prompt: 'fixture', cwd, readOnly: true, executable: process.execPath, argsPrefix: ['-e', failingLauncher, '--'] }), /退出码 7.*fixture failure/)
})

test('Pi adapter terminates an active child when cancelled', async () => {
  const controller = new AbortController()
  const slowLauncher = `const args=process.argv.slice(1); if(args.includes('--help')) { console.log(${JSON.stringify(help)}); process.exit(0) } setTimeout(() => process.stdout.write('unexpected completion'), 10_000)`
  let markStarted
  const started = new Promise((resolve) => { markStarted = resolve })
  const pending = runPi({
    prompt: 'fixture', cwd, readOnly: true, executable: process.execPath,
    argsPrefix: ['-e', slowLauncher, '--'], signal: controller.signal, timeoutMs: 5_000,
    spawnImpl: (executable, args, options) => { const child = spawn(executable, args, options); if (args.includes('--mode')) markStarted(); return child },
  })
  await started
  controller.abort()
  await assert.rejects(pending, { code: 'ABORT_ERR', name: 'AbortError' })
})
