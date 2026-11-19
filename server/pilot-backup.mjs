import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { incompleteRestoreMarker, lockDataDirectory, releaseDataLock } from './data-lock.mjs'

const namedFiles = new Set(['workflow.json', 'workflow.sqlite', 'workflow.sqlite-wal', 'workflow.sqlite-shm', 'workflow.sqlite-journal', 'runs.json', 'providers.json', 'audit.jsonl', 'audit.previous.jsonl'])
const isDataFile = (name) => namedFiles.has(name) || /^workflow\.json\.backup-v\d+-\d+\.json$/.test(name)
const manifestName = 'manifest.json'
const format = 'zhidian-offline-backup-v1'
const maxManifestBytes = 1024 * 1024
const statOptions = { bigint: true }
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && b.nlink === 1n

function absolutePath(path) {
  if (!path || !isAbsolute(path)) throw new Error('Use absolute paths for the data directory and backup bundle.')
  return resolve(path)
}

async function existingDirectory(path) {
  const canonical = await realpath(absolutePath(path))
  if (!(await lstat(canonical)).isDirectory()) throw new Error('Expected an existing directory.')
  return canonical
}

const within = (parent, child) => {
  const path = relative(parent, child)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

async function newDirectory(path, source) {
  const target = absolutePath(path)
  const parent = await existingDirectory(dirname(target))
  const destination = join(parent, basename(target))
  if (within(source, destination) || within(destination, source)) throw new Error('Source and destination directories must not overlap.')
  return destination
}

async function openRegular(path) {
  const initial = await lstat(path, statOptions)
  if (!initial.isFile() || initial.nlink !== 1n) throw new Error(`Not a regular private copy: ${basename(path)}.`)
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    if (!sameFile(initial, await handle.stat(statOptions))) throw new Error(`File changed while opening: ${basename(path)}.`)
    return { handle, initial }
  } catch (error) { await handle.close(); throw error }
}

async function snapshotFile(from, to) {
  const { handle, initial } = await openRegular(from)
  let output
  try {
    if (to) output = await open(to, 'wx', 0o600)
    const digest = createHash('sha256')
    let bytes = 0
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      digest.update(chunk)
      bytes += chunk.length
      if (output) await output.writeFile(chunk)
    }
    if (BigInt(bytes) !== initial.size || !sameFile(initial, await handle.stat(statOptions)) || !sameFile(initial, await lstat(from, statOptions))) {
      throw new Error(`File changed while reading: ${basename(from)}.`)
    }
    await output?.sync()
    return { name: basename(from), bytes, sha256: digest.digest('hex') }
  } finally {
    await Promise.all([handle.close(), output?.close()])
  }
}

function validateSet(names) {
  const sqlite = names.includes('workflow.sqlite')
  if (!sqlite && names.some((name) => name.startsWith('workflow.sqlite-'))) throw new Error('SQLite sidecar exists without its database.')
  if (!sqlite && !names.includes('workflow.json')) throw new Error('No workflow database or JSON store found.')
  return sqlite ? 'sqlite' : 'json'
}

function assertFileMatch(expected, observed) {
  if (observed.bytes !== expected.bytes || observed.sha256 !== expected.sha256) throw new Error(`Backup checksum or size does not match: ${expected.name}.`)
}

async function readManifest(bundle) {
  const path = join(bundle, manifestName)
  const { handle, initial } = await openRegular(path)
  let manifest
  try {
    if (initial.size < 2n || initial.size > BigInt(maxManifestBytes)) throw new Error('Invalid backup manifest size.')
    const data = Buffer.alloc(Number(initial.size))
    for (let offset = 0; offset < data.length;) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset)
      if (!bytesRead) throw new Error('Incomplete backup manifest.')
      offset += bytesRead
    }
    if (!sameFile(initial, await handle.stat(statOptions))) throw new Error('Backup manifest changed while reading.')
    try { manifest = JSON.parse(data.toString('utf8')) } catch { throw new Error('Invalid backup manifest JSON.') }
  } finally { await handle.close() }
  if (manifest?.format !== format || !Array.isArray(manifest.files) || typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt))) throw new Error('Unsupported backup manifest.')
  const names = []
  for (const file of manifest.files) {
    if (!file || typeof file.name !== 'string' || !isDataFile(file.name) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) throw new Error('Invalid entry in backup manifest.')
    names.push(file.name)
  }
  if (new Set(names).size !== names.length || manifest.storage !== validateSet(names)) throw new Error('Invalid backup file set.')
  const contents = join(bundle, 'files')
  if (!(await lstat(contents)).isDirectory() || resolve(await realpath(contents)) !== contents) throw new Error('Backup files directory must not be a link.')
  const actual = await readdir(contents)
  if (actual.length !== names.length || actual.some((name) => !names.includes(name))) throw new Error('Backup files do not match the manifest.')
  return { format, storage: manifest.storage, createdAt: manifest.createdAt, files: manifest.files.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })) }
}

export async function createOfflineBackup(dataPath, bundlePath) {
  const data = await existingDirectory(dataPath)
  const bundle = await newDirectory(bundlePath, data)
  const lock = await lockDataDirectory(data)
  try {
    const names = (await readdir(data)).filter(isDataFile).sort()
    const storage = validateSet(names)
    await mkdir(bundle, { mode: 0o700 })
    const contents = join(bundle, 'files')
    await mkdir(contents, { mode: 0o700 })
    const files = []
    for (const name of names) {
      const destination = join(contents, name)
      const copied = await snapshotFile(join(data, name), destination)
      assertFileMatch(copied, await snapshotFile(destination))
      files.push(copied)
    }
    const manifest = { format, storage, createdAt: new Date().toISOString(), files }
    const encoded = `${JSON.stringify(manifest, null, 2)}\n`
    if (Buffer.byteLength(encoded) > maxManifestBytes) throw new Error('Backup manifest exceeds its size limit.')
    await writeFile(join(bundle, manifestName), encoded, { flag: 'wx', mode: 0o600, flush: true })
    return manifest
  } finally { await releaseDataLock(lock) }
}

async function verifyBundle(bundle) {
  const manifest = await readManifest(bundle)
  for (const file of manifest.files) assertFileMatch(file, await snapshotFile(join(bundle, 'files', file.name)))
  return manifest
}

export async function verifyOfflineBackup(bundlePath) {
  return verifyBundle(await existingDirectory(bundlePath))
}

export async function restoreOfflineBackup(bundlePath, dataPath) {
  const bundle = await existingDirectory(bundlePath)
  const data = await newDirectory(dataPath, bundle)
  const manifest = await verifyBundle(bundle)
  await mkdir(data, { mode: 0o700 })
  const lock = await lockDataDirectory(data)
  try {
    const marker = join(data, incompleteRestoreMarker)
    await writeFile(marker, '', { flag: 'wx', mode: 0o600, flush: true })
    for (const file of manifest.files) {
      const destination = join(data, file.name)
      assertFileMatch(file, await snapshotFile(join(bundle, 'files', file.name), destination))
      assertFileMatch(file, await snapshotFile(destination))
    }
    await unlink(marker)
    return manifest
  } finally { await releaseDataLock(lock) }
}
