import { createHash } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'

export const incompleteRestoreMarker = '.zhidian-restore-incomplete'

export async function lockDataDirectory(directory) {
  const canonical = await realpath(directory)
  const key = createHash('sha256').update(process.platform === 'win32' ? canonical.toLowerCase() : canonical).digest('hex')
  const address = process.platform === 'win32' ? String.raw`\\.\pipe\zhidian-store-${key}` : process.platform === 'linux' ? `\0zhidian-store-${key}` : join(canonical, '.zhidian-store.sock')
  const lock = createServer((socket) => socket.destroy())
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(new Error(`Could not lock the Zhidian data directory: ${error.code}. Stop the other instance first.`, { cause: error }))
    lock.once('error', onError)
    lock.listen(address, () => { lock.off('error', onError); resolve() })
  })
  try {
    const marker = await lstat(join(canonical, incompleteRestoreMarker)).catch((error) => { if (error.code !== 'ENOENT') throw error; return null })
    if (marker) throw new Error('Restore is incomplete. Restore the backup into a new directory before starting the instance.')
    return lock
  } catch (error) {
    await releaseDataLock(lock)
    throw error
  }
}

export const releaseDataLock = (lock) => new Promise((resolve, reject) => lock.close((error) => error ? reject(error) : resolve()))
