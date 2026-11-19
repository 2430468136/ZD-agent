import test from 'node:test'
import { EventEmitter } from 'node:events'
import assert from 'node:assert/strict'
import { runCodexAppServer, stopProcess } from './codex-app-server-executor.mjs'

const cwd = process.cwd()

function fixtureServer() {
  return `
const readline = require('node:readline')
const input = readline.createInterface({ input: process.stdin })
let threadId = 'fixture-codex-thread'
input.on('line', line => {
  const message = JSON.parse(line)
  const reply = result => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n')
  if (message.method === 'initialize') reply({ serverInfo: { name: 'fixture-codex', version: 'test' } })
  else if (message.method === 'thread/start') reply({ thread: { id: threadId } })
  else if (message.method === 'thread/resume') { threadId = message.params.threadId; reply({ thread: { id: threadId } }) }
  else if (message.method === 'turn/start') {
    reply({})
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'turn/started', params: { threadId, turn: { id: 'fixture-turn' } } }) + '\\n')
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId, turn: { id: 'fixture-turn', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', text: 'Codex fixture completed' }] } } }) + '\\n')
  } else if (message.method === 'turn/interrupt') reply({})
  else reply({})
})
`
}

test('Codex app-server adapter starts and persists a thread with constrained workspace settings', async () => {
  const events = []
  const persisted = []
  const result = await runCodexAppServer({
    prompt: 'fixture task', cwd, readOnly: false, model: 'fixture-model',
    executable: process.execPath, argsPrefix: ['-e', fixtureServer(), '--'],
    onEvent: (event) => events.push(event), onHarnessThread: async (id) => persisted.push(id),
  })
  assert.equal(result.executor, 'codex-app-server')
  assert.equal(result.output, 'Codex fixture completed')
  assert.equal(result.harnessThreadId, 'fixture-codex-thread')
  assert.deepEqual(persisted, ['fixture-codex-thread'])
  assert.ok(events.some((event) => event.type === 'codex.turn.started'))
})

test('Codex app-server adapter resumes an existing thread', async () => {
  const result = await runCodexAppServer({
    prompt: 'continue task', cwd, readOnly: true, harnessThreadId: 'persisted-thread',
    executable: process.execPath, argsPrefix: ['-e', fixtureServer(), '--'],
  })
  assert.equal(result.harnessThreadId, 'persisted-thread')
  assert.equal(result.output, 'Codex fixture completed')
})

test('Codex app-server adapter denies permission requests and never grants access', async () => {
  const events = []
  const script = `
const readline = require('node:readline')
const input = readline.createInterface({ input: process.stdin })
input.on('line', line => {
 const message = JSON.parse(line)
 const reply = result => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n')
 if (message.method === 'initialize') reply({ ok: true })
 else if (message.method === 'thread/start') reply({ thread: { id: 'permission-thread' } })
 else if (message.method === 'turn/start') {
  reply({})
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 900, method: 'item/permissions/requestApproval', params: { threadId: 'permission-thread' } }) + '\\n')
  input.once('line', responseLine => {
   const response = JSON.parse(responseLine)
   if (response.id !== 900 || response.error?.code !== -32000) process.exit(8)
   process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'permission-thread', turn: { id: 'denied-turn', status: 'failed', error: { message: 'permissions denied' }, items: [] } } }) + '\\n')
  })
 }
})
`
  await assert.rejects(runCodexAppServer({ prompt: 'test', cwd, executable: process.execPath, argsPrefix: ['-e', script, '--'], onEvent: (event) => events.push(event) }), /permissions denied/)
  assert.ok(events.some((event) => event.type === 'codex.approval.denied'))
})

test('Codex app-server adapter stops the child and rejects when cancelled', async () => {
  const controller = new AbortController()
  const script = `
const readline = require('node:readline')
const input = readline.createInterface({ input: process.stdin })
input.on('line', line => {
 const message = JSON.parse(line)
 const reply = result => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n')
 if (message.method === 'initialize') reply({ ok: true })
 else if (message.method === 'thread/start') reply({ thread: { id: 'cancel-thread' } })
 else if (message.method === 'turn/start') { reply({}); process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'cancel-thread', turn: { id: 'cancel-turn' } } }) + '\\n') }
})
`
  const running = runCodexAppServer({ prompt: 'long task', cwd, executable: process.execPath, argsPrefix: ['-e', script, '--'], signal: controller.signal })
  setTimeout(() => controller.abort(), 100)
  await assert.rejects(running, { name: 'AbortError', code: 'ABORT_ERR' })
})


test('Windows process cleanup bounds a stuck taskkill helper and falls back to terminating the target', async () => {
  const target = new EventEmitter()
  target.exitCode = null
  target.signalCode = null
  target.pid = 12345
  target.stdin = { end() {} }
  let targetKilled = false
  target.kill = () => { targetKilled = true; target.signalCode = 'SIGTERM'; target.emit('close', null, 'SIGTERM') }

  const killer = new EventEmitter()
  killer.exitCode = null
  killer.signalCode = null
  let killerKilled = false
  killer.kill = () => { killerKilled = true; killer.emit('close', null, 'SIGTERM') }

  const started = Date.now()
  await stopProcess(target, 5, { platform: 'win32', spawnImpl: () => killer, killerTimeoutMs: 20, exitTimeoutMs: 50 })
  assert.equal(killerKilled, true)
  assert.equal(targetKilled, true)
  assert.ok(Date.now() - started < 1_000)
})
