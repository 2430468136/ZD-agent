import { hash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { closeSync, openSync } from 'node:fs'
import { migrateWorkflowData } from './workflow-store.mjs'

const coreCollections = ['projects', 'sessions', 'tasks', 'reviews', 'contextEntries', 'threads', 'messages', 'runs', 'schedules', 'occurrences', 'deliveryTargets', 'deliveries', 'members']
const optionalCollections = ['inboundTargets', 'inboundEvents']
const collections = [...coreCollections, ...optionalCollections]
const emptyIndex = () => new Map(collections.map((key) => [key, new Map()]))
const fingerprint = (payload) => hash('sha256', payload, 'base64url')

export function openSqliteWorkflow(path, { readOnly = false } = {}) {
  if (!readOnly) {
    try { closeSync(openSync(path, 'wx', 0o600)) } catch (error) { if (error.code !== 'EEXIST') throw error }
  }
  const db = new DatabaseSync(path, { readOnly })
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version
    if (version !== 1 && (readOnly || version !== 0)) throw new Error('Unsupported or uninitialized SQLite workflow format.')
    db.exec('PRAGMA busy_timeout=5000;')
    if (!readOnly) db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
    if (version === 0) db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE workflow_meta (id INTEGER PRIMARY KEY CHECK(id = 1), schema_version INTEGER NOT NULL) STRICT;
      CREATE TABLE workflow_records (collection TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)), PRIMARY KEY (collection, id)) STRICT;
      PRAGMA user_version=1;
      COMMIT;
    `)
    const meta = db.prepare('SELECT schema_version FROM workflow_meta WHERE id=1')
    const find = db.prepare('SELECT id, collection, position, payload FROM workflow_records ORDER BY collection, position')
    const put = readOnly ? null : db.prepare(`
      INSERT INTO workflow_records(collection,id,position,payload) VALUES(?,?,?,?)
      ON CONFLICT(collection,id) DO UPDATE SET position=excluded.position, payload=excluded.payload
    `)
    const remove = readOnly ? null : db.prepare('DELETE FROM workflow_records WHERE collection=? AND id=?')
    const setMeta = readOnly ? null : db.prepare('INSERT INTO workflow_meta(id,schema_version) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET schema_version=excluded.schema_version')
    let persistedRows
    let persistedSchema

    function read() {
      db.exec('BEGIN')
      try {
        const row = meta.get()
        const records = find.all()
        if (!row && records.length) throw new Error('SQLite workflow metadata is missing.')
        const data = row && { schemaVersion: row.schema_version, ...Object.fromEntries(coreCollections.map((key) => [key, []])) }
        const index = readOnly ? null : emptyIndex()
        for (const { id, collection, position, payload } of records) {
          const record = JSON.parse(payload)
          if (!collections.includes(collection) || record?.id !== id) throw new Error('Invalid SQLite workflow record.')
          if (optionalCollections.includes(collection) && !Object.hasOwn(data, collection)) data[collection] = []
          data[collection].push(record)
          index?.get(collection).set(id, { position, digest: fingerprint(payload) })
        }
        const verified = data && migrateWorkflowData(data)
        db.exec('COMMIT')
        persistedRows = index
        persistedSchema = row?.schema_version
        return verified
      } catch (error) { db.exec('ROLLBACK'); throw error }
    }

    function write(data) {
      if (readOnly) throw new Error('Cannot write a read-only workflow store.')
      const validated = migrateWorkflowData(data)
      // The instance lock makes this index valid until this writer commits another snapshot.
      if (!persistedRows) read()
      const next = emptyIndex()
      const changed = []
      const removed = []
      for (const key of collections) {
        const last = persistedRows.get(key)
        const current = next.get(key)
        ;(validated[key] ?? []).forEach((item, position) => {
          const payload = JSON.stringify(item)
          const digest = fingerprint(payload)
          current.set(item.id, { position, digest })
          const previous = last.get(item.id)
          if (previous?.position !== position || previous?.digest !== digest) changed.push([key, item.id, position, payload])
        })
        for (const id of last.keys()) if (!current.has(id)) removed.push([key, id])
      }
      const schemaChanged = validated.schemaVersion !== persistedSchema
      if (!changed.length && !removed.length && !schemaChanged) return
      db.exec('BEGIN IMMEDIATE')
      try {
        for (const params of removed) remove.run(...params)
        for (const params of changed) put.run(...params)
        if (schemaChanged) setMeta.run(validated.schemaVersion)
        db.exec('COMMIT')
        persistedRows = next
        persistedSchema = validated.schemaVersion
      } catch (error) { db.exec('ROLLBACK'); throw error }
    }

    function verifyIntegrity() {
      const result = db.prepare('PRAGMA integrity_check').all()
      if (result.length !== 1 || result[0].integrity_check !== 'ok') throw new Error('SQLite integrity check failed.')
    }

    return { read, write, verifyIntegrity, close: () => db.close() }
  } catch (error) { db.close(); throw error }
}
