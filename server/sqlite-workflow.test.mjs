import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { openSqliteWorkflow } from './sqlite-workflow.mjs'

const initial = () => ({ schemaVersion: 4, projects: ['a', 'b', 'c'].map((id) => ({ id, name: id })), sessions: [], tasks: [], reviews: [], contextEntries: [], threads: [], messages: [], runs: [], schedules: [], occurrences: [], deliveryTargets: [], deliveries: [], members: [] })

async function databaseFixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'zhidian-sqlite-delta-'))
  t.after(async () => {
    const target = await realpath(dir)
    assert.equal(dirname(target), await realpath(tmpdir()))
    assert.ok(basename(target).startsWith('zhidian-sqlite-delta-'))
    await rm(target, { recursive: true, force: true, maxRetries: 2 })
  })
  const file = join(dir, 'workflow.sqlite')
  const store = openSqliteWorkflow(file)
  try { store.write(initial()) } finally { store.close() }
  return file
}

test('SQLite snapshot updates only changed rows and retains requested record order after reopening', async (t) => {
  const file = await databaseFixture(t)
  const db = new DatabaseSync(file)
  const store = openSqliteWorkflow(file)
  try {
    db.exec(`
      CREATE TABLE changed (operation TEXT, record_id TEXT);
      CREATE TRIGGER delta_update AFTER UPDATE ON workflow_records BEGIN INSERT INTO changed VALUES ('updated', new.id); END;
      CREATE TRIGGER delta_insert AFTER INSERT ON workflow_records BEGIN INSERT INTO changed VALUES ('inserted', new.id); END;
      CREATE TRIGGER delta_delete AFTER DELETE ON workflow_records BEGIN INSERT INTO changed VALUES ('deleted', old.id); END;
    `)
    const changes = () => db.prepare('SELECT operation, record_id FROM changed ORDER BY rowid').all().map((row) => `${row.operation}:${row.record_id}`)
    store.write(initial())
    assert.deepEqual(changes(), [])
    const next = initial()
    next.projects[1].name = 'changed in place'
    store.write(next)
    assert.deepEqual(changes(), ['updated:b'])
    assert.deepEqual(store.read(), next)
    db.exec('DELETE FROM changed')
    next.projects = [next.projects[2], next.projects[1], { id: 'd', name: 'new' }]
    store.write(next)
    assert.deepEqual(changes(), ['deleted:a', 'updated:c', 'inserted:d'])
  } finally { store.close(); db.close() }
  const restored = openSqliteWorkflow(file, { readOnly: true })
  try {
    restored.verifyIntegrity()
    assert.deepEqual(restored.read().projects.map(({ id }) => id), ['c', 'b', 'd'])
    assert.throws(() => restored.write(initial()), /read-only/)
  } finally { restored.close() }
})

test('a failed delta commit rolls back removals and does not advance the in-memory index', async (t) => {
  const file = await databaseFixture(t)
  const db = new DatabaseSync(file)
  const store = openSqliteWorkflow(file)
  try {
    db.exec("CREATE TRIGGER abort_delta BEFORE INSERT ON workflow_records WHEN new.id = 'd' BEGIN SELECT RAISE(ABORT, 'fixture write error'); END")
    const next = initial()
    next.projects = [{ id: 'b', name: 'moved' }, { id: 'd', name: 'new' }]
    assert.throws(() => store.write(next), /fixture write error/)
    assert.deepEqual(db.prepare("SELECT id FROM workflow_records WHERE collection='projects' ORDER BY position").all().map(({ id }) => id), ['a', 'b', 'c'])
    db.exec('DROP TRIGGER abort_delta')
    store.write(next)
    assert.deepEqual(store.read(), next)
  } finally { store.close(); db.close() }
})
