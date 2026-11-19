import { closeSync, constants, openSync } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { assertPrivateAuditFile, auditMaxFileBytes } from './audit-log.mjs'
import { parseAuditSnapshot } from './audit-export.mjs'

const applicationId = 0x5a484441
const archiveVersion = 1
const maxSnapshotBytes = 2 * auditMaxFileBytes
const statOptions = { bigint: true }

function absolute(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Audit archive and snapshot paths must be absolute.')
  return path
}

function checkInstance(instance) {
  if (typeof instance !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(instance)) throw new Error('Invalid audit instance identifier.')
}

async function loadSnapshot(path) {
  const source = absolute(path)
  const before = await lstat(source, statOptions)
  if (!before.isFile() || before.size > BigInt(maxSnapshotBytes)) throw new Error('Expected a regular audit snapshot within the size limit.')
  const file = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  const same = (stat) => stat.isFile() && stat.dev === before.dev && stat.ino === before.ino && stat.size === before.size && stat.mtimeNs === before.mtimeNs && stat.ctimeNs === before.ctimeNs
  try {
    if (!same(await file.stat(statOptions))) throw new Error('Audit snapshot changed while opening.')
    const buffer = Buffer.alloc(Number(before.size))
    for (let offset = 0; offset < buffer.length;) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) throw new Error('Audit snapshot was truncated.')
      offset += bytesRead
    }
    if (!same(await file.stat(statOptions)) || !same(await lstat(source, statOptions))) throw new Error('Audit snapshot changed while reading.')
    return parseAuditSnapshot(buffer, 'archive input')
  } finally { await file.close() }
}

function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = work()
    db.exec('COMMIT')
    return result
  } catch (error) { db.exec('ROLLBACK'); throw error }
}

async function openArchive(path, readOnly) {
  absolute(path)
  if (!readOnly) {
    try { closeSync(openSync(path, 'wx', 0o600)) } catch (error) { if (error.code !== 'EEXIST') throw error }
  }
  assertPrivateAuditFile(await lstat(path))
  const db = new DatabaseSync(path, { readOnly })
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF;')
    const initialized = () => db.prepare('PRAGMA application_id').get().application_id === applicationId && db.prepare('PRAGMA user_version').get().user_version === archiveVersion
    if (!readOnly) {
      db.exec('PRAGMA synchronous=FULL')
      transaction(db, () => {
        if (initialized()) return
        const empty = db.prepare('PRAGMA application_id').get().application_id === 0 && db.prepare('PRAGMA user_version').get().user_version === 0 && !db.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get()
        if (!empty) throw new Error('Not a supported Zhidian audit archive.')
        db.exec(`
          CREATE TABLE events (
            instance TEXT NOT NULL, request_id TEXT NOT NULL, phase TEXT NOT NULL,
            payload TEXT NOT NULL, PRIMARY KEY (instance, request_id, phase)
          ) STRICT;
          PRAGMA application_id=${applicationId}; PRAGMA user_version=${archiveVersion};
        `)
      })
    } else if (!initialized()) throw new Error('Not a supported Zhidian audit archive.')
    return db
  } catch (error) { db.close(); throw error }
}

export async function ingestAuditSnapshot(archive, instance, snapshot) {
  checkInstance(instance)
  const records = await loadSnapshot(snapshot)
  const db = await openArchive(archive, false)
  try {
    return transaction(db, () => {
      const insert = db.prepare('INSERT INTO events(instance, request_id, phase, payload) VALUES (?, ?, ?, ?) ON CONFLICT(instance, request_id, phase) DO NOTHING')
      const existing = db.prepare('SELECT payload FROM events WHERE instance=? AND request_id=? AND phase=?')
      let inserted = 0
      for (const { at, requestId, action, role, memberId, phase, status, resourceId } of records) {
        const payload = JSON.stringify({ at, requestId, action, role, memberId, phase, status, resourceId })
        if (insert.run(instance, requestId, phase, payload).changes === 1) inserted += 1
        else if (existing.get(instance, requestId, phase)?.payload !== payload) throw new Error('Conflicting audit event in snapshot; batch rolled back.')
      }
      return { instance, received: records.length, inserted, duplicates: records.length - inserted }
    })
  } finally { db.close() }
}

export async function findAuditRequest(archive, instance, requestId) {
  checkInstance(instance)
  if (typeof requestId !== 'string' || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(requestId)) throw new Error('Invalid audit request identifier.')
  const db = await openArchive(archive, true)
  try {
    const rows = db.prepare("SELECT payload FROM events WHERE instance=? AND request_id=? ORDER BY CASE phase WHEN 'attempt' THEN 0 ELSE 1 END, phase").all(instance, requestId)
    return { instance, requestId, events: rows.map(({ payload }) => JSON.parse(payload)) }
  } finally { db.close() }
}
