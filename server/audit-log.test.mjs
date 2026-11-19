import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { auditAction, createAuditLog } from './audit-log.mjs'
import { exportAuditRecords } from './audit-export.mjs'

const exportCommand = promisify(execFile)
const exportScript = fileURLToPath(new URL('../scripts/pilot-audit.mjs', import.meta.url))

async function fixture(t) {
  const path = await mkdtemp(join(tmpdir(), 'zhidian-audit-unit-'))
  t.after(async () => {
    const target = await realpath(path)
    assert.equal(dirname(target), await realpath(tmpdir()))
    assert.ok(basename(target).startsWith('zhidian-audit-unit-'))
    await rm(target, { recursive: true, force: true })
  })
  return path
}

test('audit maps only supported mutations to static action names', () => {
  assert.equal(auditAction('POST', '/api/workflow/start'), 'workflow.submit')
  assert.equal(auditAction('POST', '/api/workflow/task-3/execute'), 'task.execute')
  assert.equal(auditAction('PUT', '/api/providers/malicious-input'), 'provider.configure')
  assert.equal(auditAction('GET', '/api/schedules'), null)
  assert.equal(auditAction('POST', '/api/unknown'), null)
})

test('audit correlates attempts and results and only persists allowlisted fields', async (t) => {
  const path = await fixture(t)
  const log = createAuditLog(path)
  const entry = log.start('workflow.submit', { role: 'viewer', memberId: 'member-123', key: 'cookie-secret' })
  assert.ok(log.record(entry, 'attempt', { body: 'private-prompt' }))
  assert.ok(log.record({ ...entry, headers: 'private-header' }, 'result', { status: 403, resourceId: 'identifier/\nraw-url' }))
  const text = await readFile(join(path, 'audit.jsonl'), 'utf8')
  const [attempt, result] = text.trim().split('\n').map(JSON.parse)
  assert.equal(attempt.requestId, result.requestId)
  assert.equal(attempt.memberId, 'member-123')
  assert.equal(result.status, 403)
  assert.ok(!/cookie-secret|private-prompt|private-header|raw-url/.test(text))
})

test('audit samples repeated anonymous denials and rotates with bounded retention', async (t) => {
  const path = await fixture(t)
  let now = 0
  const maxBytes = 500
  const log = createAuditLog(path, { clock: () => now, maxBytes })
  for (let n = 0; n < 20; n += 1) log.record(log.start('auth.login'), 'result', { status: 429 })
  assert.equal((await readFile(join(path, 'audit.jsonl'), 'utf8')).trim().split('\n').length, 1)
  now += 60_000
  log.record(log.start('auth.login'), 'result', { status: 429 })
  assert.equal((await readFile(join(path, 'audit.jsonl'), 'utf8')).trim().split('\n').length, 2)
  for (let n = 0; n < 16; n += 1) log.record(log.start('project.authorize', { role: 'owner' }), 'attempt')
  assert.equal(log.available, true)
  for (const name of ['audit.jsonl', 'audit.previous.jsonl']) {
    const file = join(path, name)
    assert.ok((await stat(file)).size <= maxBytes)
    assert.ok((await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse).every(({ phase }) => phase === 'attempt'))
  }
})

test('audit blocks future writes after the log can no longer be appended', async (t) => {
  const path = await fixture(t)
  const log = createAuditLog(path)
  const active = join(path, 'audit.jsonl')
  await rename(active, join(path, 'retained-audit.jsonl'))
  await mkdir(active)
  assert.equal(log.record(log.start('project.authorize', { role: 'owner' }), 'attempt'), false)
  assert.equal(log.available, false)
  assert.throws(() => createAuditLog(path), /private regular file/)
})

test('audit export correlates a request across rotation and can be ingested idempotently', async (t) => {
  const path = await fixture(t)
  const log = createAuditLog(path, { maxBytes: 270, clock: () => 0 })
  const entry = log.start('workflow.submit', { role: 'owner' })
  const ingest = new Map()
  const collect = (records) => records.forEach((event) => ingest.set(`${event.requestId}:${event.phase}`, event))

  assert.equal(log.record(entry, 'attempt'), true)
  collect(await exportAuditRecords(path))
  assert.equal(log.record(entry, 'result', { status: 202, resourceId: 'task-test-id', body: 'secret-raw-request' }), true)
  const files = ['audit.previous.jsonl', 'audit.jsonl'].map((name) => join(path, name))
  const before = await Promise.all(files.map((file) => readFile(file, 'utf8')))
  assert.equal(JSON.parse(before[0]).phase, 'attempt')
  assert.equal(JSON.parse(before[1]).phase, 'result')
  const { stdout, stderr } = await exportCommand(process.execPath, [exportScript, path], { windowsHide: true })
  assert.equal(stderr, '')
  assert.equal(stdout, before.join(''))
  assert.ok(!stdout.includes('secret-raw-request'))
  collect(stdout.trim().split('\n').map(JSON.parse))
  assert.equal(ingest.size, 2)
  assert.equal(ingest.get(`${entry.requestId}:result`).status, 202)
  assert.deepEqual(await Promise.all(files.map((file) => readFile(file, 'utf8'))), before)
})

test('audit export rejects missing or invalid log input without leaking partial output', async (t) => {
  const path = await fixture(t)
  await assert.rejects(exportAuditRecords('relative-path'), /absolute data directory/)
  await assert.rejects(exportAuditRecords(path), /No audit log found/)
  const log = createAuditLog(path)
  const file = join(path, 'audit.jsonl')
  assert.deepEqual(await exportAuditRecords(path), [])
  log.record(log.start('project.authorize', { role: 'owner' }), 'attempt')
  const valid = await readFile(file, 'utf8')
  await writeFile(file, `${valid}${JSON.stringify({ ...JSON.parse(valid), cookie: 'private-test-value' })}\n`)
  await assert.rejects(exportCommand(process.execPath, [exportScript, path], { windowsHide: true }), (error) => {
    assert.equal(error.code, 1)
    assert.equal(error.stdout, '')
    assert.match(error.stderr, /Invalid audit record.*line 2/)
    assert.doesNotMatch(error.stderr, /private-test-value/)
    return true
  })
  await writeFile(file, valid.trimEnd())
  await assert.rejects(exportAuditRecords(path), /Incomplete audit record/)
  await rename(file, join(path, 'not-an-audit-log'))
  await mkdir(file)
  await assert.rejects(exportAuditRecords(path), /private regular file/)
})
