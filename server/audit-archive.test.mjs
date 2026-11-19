import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { findAuditRequest, ingestAuditSnapshot } from './audit-archive.mjs'
import { exportAuditRecords } from './audit-export.mjs'
import { auditMaxFileBytes, createAuditLog } from './audit-log.mjs'

const exportScript = fileURLToPath(new URL('../scripts/pilot-audit.mjs', import.meta.url))
const archiveScript = fileURLToPath(new URL('../scripts/pilot-audit-archive.mjs', import.meta.url))
const exec = promisify(execFile)
const node = (script, ...args) => exec(process.execPath, [script, ...args], { windowsHide: true })
const encode = (events) => events.map((event) => `${JSON.stringify(event)}\n`).join('')

async function fixture(t) {
  const parent = await realpath(tmpdir())
  const root = await mkdtemp(join(parent, 'zhidian-archive-test-'))
  t.after(async () => {
    const target = await realpath(root)
    assert.equal(dirname(target).toLowerCase(), parent.toLowerCase())
    assert.ok(basename(target).startsWith('zhidian-archive-test-'))
    await rm(target, { recursive: true, force: true, maxRetries: 2 })
  })
  const data = join(root, 'source')
  await mkdir(data)
  return { data, archive: join(root, 'audit.sqlite'), snapshot: join(root, 'snapshot.jsonl') }
}

test('archive CLI collects overlapping exports and retains events after the source rotates out', async (t) => {
  const { data, archive, snapshot } = await fixture(t)
  const log = createAuditLog(data, { maxBytes: 270, clock: () => 0 })
  const entry = log.start('workflow.submit', { role: 'owner' })
  const instance = 'pilot-one'
  const capture = async () => {
    const { stdout, stderr } = await node(exportScript, data)
    assert.equal(stderr, '')
    await writeFile(snapshot, stdout, { mode: 0o600 })
    return stdout
  }
  const run = async (mode, name, value) => {
    const { stdout } = await node(archiveScript, mode, archive, name, value)
    return JSON.parse(stdout)
  }
  assert.ok(log.record(entry, 'attempt'))
  await capture()
  assert.deepEqual(await run('ingest', instance, snapshot), { ok: true, instance, received: 1, inserted: 1, duplicates: 0 })
  assert.ok(log.record(entry, 'result', { status: 202, resourceId: 'task-123' }))
  const paired = await capture()
  assert.deepEqual(await run('ingest', instance, snapshot), { ok: true, instance, received: 2, inserted: 1, duplicates: 1 })

  const records = paired.trimEnd().split('\n').map(JSON.parse)
  await writeFile(snapshot, encode(records.map((event) => Object.fromEntries(Object.entries(event).reverse()))))
  assert.deepEqual(await run('ingest', instance, snapshot), { ok: true, instance, received: 2, inserted: 0, duplicates: 2 })
  const other = 'pilot-two'
  const otherRecords = [records[0], { ...records[1], resourceId: 'task-456' }]
  await writeFile(snapshot, encode(otherRecords))
  assert.deepEqual(await run('ingest', other, snapshot), { ok: true, instance: other, received: 2, inserted: 2, duplicates: 0 })

  for (let index = 0; index < 5; index += 1) assert.ok(log.record(log.start('auth.login', { role: 'owner' }), 'attempt'))
  assert.ok(!(await capture()).includes(entry.requestId), 'Original request should have rotated out of the source.')
  assert.equal((await run('ingest', instance, snapshot)).inserted, 2)
  assert.deepEqual(await run('find', instance, entry.requestId), { ok: true, instance, requestId: entry.requestId, events: records })
  assert.deepEqual(await run('find', other, entry.requestId), { ok: true, instance: other, requestId: entry.requestId, events: otherRecords })
})

test('a conflicting event rolls back earlier inserts in the same batch', async (t) => {
  const { data, archive, snapshot } = await fixture(t)
  const log = createAuditLog(data)
  const oldEntry = log.start('workflow.submit', { role: 'owner' })
  const newEntry = log.start('workflow.submit', { role: 'owner' })
  assert.ok(log.record(oldEntry, 'result', { status: 202, resourceId: 'task-123' }))
  const [original] = await exportAuditRecords(data)
  await writeFile(snapshot, encode([original]), { mode: 0o600 })
  await ingestAuditSnapshot(archive, 'pilot', snapshot)
  assert.ok(log.record(newEntry, 'attempt'))
  const [, fresh] = await exportAuditRecords(data)
  await writeFile(snapshot, encode([fresh, { ...original, status: 500 }]))
  await assert.rejects(ingestAuditSnapshot(archive, 'pilot', snapshot), /Conflicting audit event.*rolled back/)
  assert.deepEqual((await findAuditRequest(archive, 'pilot', newEntry.requestId)).events, [])
  assert.deepEqual((await findAuditRequest(archive, 'pilot', oldEntry.requestId)).events, [original])
  await writeFile(snapshot, encode([fresh]))
  assert.equal((await ingestAuditSnapshot(archive, 'pilot', snapshot)).inserted, 1)
})

test('invalid, truncated or oversized snapshots are rejected before opening an archive', async (t) => {
  const { data, archive, snapshot } = await fixture(t)
  const log = createAuditLog(data)
  assert.ok(log.record(log.start('auth.login', { role: 'owner' }), 'result', { status: 200 }))
  const [event] = await exportAuditRecords(data)
  await writeFile(snapshot, encode([event, { ...event, token: 'must-not-print' }]), { mode: 0o600 })
  await assert.rejects(node(archiveScript, 'ingest', archive, 'pilot', snapshot), (error) => {
    assert.equal(error.code, 1)
    assert.equal(error.stdout, '')
    assert.match(error.stderr, /Invalid audit record.*line 2/)
    assert.doesNotMatch(error.stderr, /must-not-print/)
    return true
  })
  await assert.rejects(lstat(archive), { code: 'ENOENT' })
  await writeFile(snapshot, `${encode([event])}{"at":`)
  await assert.rejects(ingestAuditSnapshot(archive, 'pilot', snapshot), /Incomplete audit record/)
  await assert.rejects(lstat(archive), { code: 'ENOENT' })
  await truncate(snapshot, 2 * auditMaxFileBytes + 1)
  await assert.rejects(ingestAuditSnapshot(archive, 'pilot', snapshot), /size limit/)
  await assert.rejects(lstat(archive), { code: 'ENOENT' })
})

test('a non-archive database is not modified or queried', async (t) => {
  const { archive, snapshot } = await fixture(t)
  await writeFile(archive, '', { mode: 0o600 })
  const db = new DatabaseSync(archive)
  try { db.exec('CREATE TABLE tasks (id TEXT); INSERT INTO tasks VALUES (\'existed\');') }
  finally { db.close() }
  await writeFile(snapshot, '', { mode: 0o600 })
  const before = await readFile(archive)
  await assert.rejects(ingestAuditSnapshot(archive, 'pilot', snapshot), /Not a supported Zhidian audit archive/)
  await assert.rejects(findAuditRequest(archive, 'pilot', '00112233-4455-6677-8899-aabbccddeeff'), /Not a supported Zhidian audit archive/)
  assert.deepEqual(await readFile(archive), before)
})
