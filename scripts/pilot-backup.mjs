import { createOfflineBackup, restoreOfflineBackup, verifyOfflineBackup } from '../server/pilot-backup.mjs'

try {
  const [mode, source, destination, ...extra] = process.argv.slice(2)
  let manifest
  if (!extra.length && mode === 'create' && destination) manifest = await createOfflineBackup(source, destination)
  else if (!extra.length && mode === 'verify' && !destination) manifest = await verifyOfflineBackup(source)
  else if (!extra.length && mode === 'restore' && destination) manifest = await restoreOfflineBackup(source, destination)
  else throw new Error('Usage: node scripts/pilot-backup.mjs create <data-dir> <new-bundle-dir> | verify <bundle-dir> | restore <bundle-dir> <new-data-dir>')
  console.log(JSON.stringify({ ok: true, mode, ...manifest }, null, 2))
} catch (error) {
  console.error(`Backup ${process.argv[2] === 'restore' ? 'restore' : 'operation'} failed: ${error.code ?? error.message}`)
  process.exitCode = 1
}
