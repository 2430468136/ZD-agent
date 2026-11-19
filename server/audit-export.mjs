import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { assertPrivateAuditFile, auditFileNames, auditMaxFileBytes, validAuditEvent } from './audit-log.mjs'

const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
const statOptions = { bigint: true }

async function inspect(path) {
  let info
  try { info = await lstat(path, statOptions) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
  assertPrivateAuditFile(info)
  if (info.size > auditMaxFileBytes) throw new Error('Audit file exceeds the snapshot size limit.')
  return info
}

const sameVersion = (a, b) => a && b
  ? a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
  : a === b

async function readSnapshot(path, info) {
  if (!info) return Buffer.alloc(0)
  let file
  try { file = await open(path, flags) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
  try {
    if (!sameVersion(info, await file.stat(statOptions))) return null
    const bytes = Buffer.alloc(Number(info.size))
    for (let offset = 0; offset < bytes.length;) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset)
      if (bytesRead === 0) return null
      offset += bytesRead
    }
    return sameVersion(info, await file.stat(statOptions)) ? bytes : null
  } finally { await file.close() }
}

export function parseAuditSnapshot(bytes, name) {
  if (bytes.length && bytes.at(-1) !== 0x0a) throw new Error(`Incomplete audit record in ${name}.`)
  const lines = bytes.toString('utf8').split('\n')
  lines.pop()
  return lines.map((line, index) => {
    let event
    try { event = JSON.parse(line) } catch { /* Do not expose input in diagnostics. */ }
    if (!validAuditEvent(event)) throw new Error(`Invalid audit record in ${name} at line ${index + 1}.`)
    return event
  })
}

export async function exportAuditRecords(directory) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) throw new Error('Audit export requires an absolute data directory.')
  const paths = auditFileNames.map((name) => join(directory, name))
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const before = await Promise.all(paths.map(inspect))
    const contents = await Promise.all(paths.map((path, index) => readSnapshot(path, before[index])))
    const after = await Promise.all(paths.map(inspect))
    // Do not silently omit or duplicate a file if a rotation crossed the two reads.
    if (contents.every((bytes, index) => bytes && sameVersion(before[index], after[index]))) {
      // During rotation the previous file can exist briefly before the active file is recreated.
      if (before[1]) return contents.flatMap((bytes, index) => parseAuditSnapshot(bytes, auditFileNames[index]))
      if (!before[0]) throw new Error('No audit log found in the requested directory.')
    }
    await wait(25)
  }
  throw new Error('Could not capture a stable audit snapshot. Retry or use a stopped copy with an active audit log.')
}
