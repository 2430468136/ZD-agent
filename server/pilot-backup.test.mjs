import assert from 'node:assert/strict'
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { incompleteRestoreMarker, lockDataDirectory, releaseDataLock } from './data-lock.mjs'
import { createOfflineBackup, restoreOfflineBackup, verifyOfflineBackup } from './pilot-backup.mjs'

async function fixture(t) {
  const parent = await realpath(tmpdir())
  const root = await mkdtemp(join(parent, 'zhidian-backup-test-'))
  t.after(async () => {
    const target = await realpath(root)
    assert.equal(dirname(target).toLowerCase(), parent.toLowerCase())
    assert.ok(basename(target).startsWith('zhidian-backup-test-'))
    await rm(target, { recursive: true, force: true, maxRetries: 2 })
  })
  const data = join(root, 'data')
  await mkdir(data)
  return { root, data, bundle: join(root, 'bundle'), restored: join(root, 'restored') }
}

test('offline bundle copies known JSON state and audit files byte for byte without capturing separately managed secrets', async (t) => {
  const { data, bundle, restored } = await fixture(t)
  const original = new Map([['workflow.json', '{"tasks":[] }\n'], ['workflow.json.backup-v1-123.json', '{"tasks":[]}'], ['providers.json', '{"sealed":"encrypted"}'], ['runs.json', '[]'], ['audit.jsonl', '{"event":"current"}\n'], ['audit.previous.jsonl', '{"event":"old"}\n']])
  for (const [name, contents] of original) await writeFile(join(data, name), contents)
  await writeFile(join(data, 'keyring.json'), 'secret fixture')
  await writeFile(join(data, 'server-key.pem'), 'private fixture')
  const created = await createOfflineBackup(data, bundle)
  assert.equal(created.storage, 'json')
  assert.deepEqual(created.files.map(({ name }) => name).sort(), [...original.keys()].sort())
  assert.deepEqual(await verifyOfflineBackup(bundle), created)
  assert.deepEqual(await restoreOfflineBackup(bundle, restored), created)
  assert.deepEqual((await readdir(restored)).sort(), [...original.keys()].sort())
  for (const [name, contents] of original) {
    assert.equal(await readFile(join(restored, name), 'utf8'), contents)
    assert.equal(await readFile(join(data, name), 'utf8'), contents)
  }
  await assert.rejects(createOfflineBackup(data, bundle), { code: 'EEXIST' })
  await assert.rejects(restoreOfflineBackup(bundle, restored), { code: 'EEXIST' })
  await assert.rejects(createOfflineBackup(data, join(data, 'nested')), /overlap/)
  await assert.rejects(restoreOfflineBackup(bundle, join(bundle, 'nested')), /overlap/)
})

test('backup copies a stopped SQLite store with its WAL; restoring the WAL preserves committed rows', async (t) => {
  const { data, bundle, restored } = await fixture(t)
  const db = new DatabaseSync(join(data, 'workflow.sqlite'))
  try { db.exec('PRAGMA journal_mode=WAL; CREATE TABLE fixture (value TEXT); INSERT INTO fixture VALUES (\'committed\');') }
  catch (error) { db.close(); throw error }
  // Copy the files into the stopped fixture with WAL still present, as after a crash.
  const source = join(data, 'workflow.sqlite')
  const wal = `${source}-wal`
  const base = await readFile(source)
  const log = await readFile(wal)
  db.close()
  await writeFile(source, base)
  await writeFile(wal, log)
  const created = await createOfflineBackup(data, bundle)
  assert.equal(created.storage, 'sqlite')
  assert.ok(created.files.some(({ name }) => name === 'workflow.sqlite-wal'))
  await restoreOfflineBackup(bundle, restored)
  const checked = new DatabaseSync(join(restored, 'workflow.sqlite'), { readOnly: true })
  try { assert.equal(checked.prepare('SELECT value FROM fixture').get().value, 'committed') }
  finally { checked.close() }
  assert.deepEqual(await readFile(wal), log)
})

test('invalid manifests, missing files and altered bytes are rejected before writing a restore directory', async (t) => {
  const { root, data, bundle, restored } = await fixture(t)
  const contents = '{"phase":"before"}'
  await writeFile(join(data, 'workflow.json'), contents)
  const created = await createOfflineBackup(data, bundle)
  const manifest = join(bundle, 'manifest.json')
  const savedFile = join(bundle, 'files', 'workflow.json')
  await writeFile(savedFile, '{"phase":"after!"}')
  await assert.rejects(restoreOfflineBackup(bundle, restored), /checksum/)
  assert.ok(!(await readdir(root)).includes('restored'))
  await unlink(savedFile)
  await assert.rejects(verifyOfflineBackup(bundle), /do not match/)
  await writeFile(savedFile, contents)
  const injected = { ...created, files: [...created.files, { ...created.files[0], name: '../workflow.json' }] }
  await writeFile(manifest, JSON.stringify(injected))
  await assert.rejects(restoreOfflineBackup(bundle, restored), /Invalid entry/)
  assert.ok(!(await readdir(root)).includes('restored'))
})

test('shared lock refuses concurrent backup and prevents use of an incomplete restore directory', async (t) => {
  const { root, data, bundle, restored } = await fixture(t)
  await writeFile(join(data, 'workflow.json'), '{}')
  const lock = await lockDataDirectory(data)
  try {
    await assert.rejects(createOfflineBackup(data, bundle), /Could not lock/)
    assert.ok(!(await readdir(root)).includes('bundle'))
  } finally { await releaseDataLock(lock) }
  await mkdir(restored)
  await writeFile(join(restored, incompleteRestoreMarker), '')
  await writeFile(join(restored, 'workflow.json'), '{}')
  await assert.rejects(lockDataDirectory(restored), /Restore is incomplete/)
  await assert.rejects(createOfflineBackup(restored, bundle), /Restore is incomplete/)
  await unlink(join(restored, incompleteRestoreMarker))
  await releaseDataLock(await lockDataDirectory(restored))
})

test('known data filenames cannot be hard links to files outside the backup source', async (t) => {
  const { root, data, bundle } = await fixture(t)
  const file = join(root, 'outside.json')
  await writeFile(file, '{"outside":true}')
  await link(file, join(data, 'workflow.json'))
  await assert.rejects(createOfflineBackup(data, bundle), /Not a regular private copy/)
  assert.ok(!(await readdir(bundle)).includes('manifest.json'))
})
