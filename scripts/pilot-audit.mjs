import { exportAuditRecords } from '../server/audit-export.mjs'

async function main() {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/pilot-audit.mjs <absolute-data-directory>')
  const records = await exportAuditRecords(process.argv[2])
  for (const event of records) {
    if (process.stdout.write(`${JSON.stringify(event)}\n`)) continue
    await new Promise((resolve) => process.stdout.once('drain', resolve))
  }
}

process.stdout.on('error', () => {
  console.error('Audit export failed: could not write output.')
  process.exit(1)
})

main().catch((error) => {
  console.error(`Audit export failed: ${error.code ?? error.message}`)
  process.exitCode = 1
})
