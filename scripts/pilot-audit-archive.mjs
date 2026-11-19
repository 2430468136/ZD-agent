import { findAuditRequest, ingestAuditSnapshot } from '../server/audit-archive.mjs'

try {
  const [mode, archive, instance, value, ...extra] = process.argv.slice(2)
  if (!archive || !instance || !value || extra.length || !['ingest', 'find'].includes(mode)) {
    throw new Error('Usage: node scripts/pilot-audit-archive.mjs ingest <archive.sqlite> <instance-id> <snapshot.jsonl> | find <archive.sqlite> <instance-id> <request-id>')
  }
  const result = mode === 'ingest' ? await ingestAuditSnapshot(archive, instance, value) : await findAuditRequest(archive, instance, value)
  console.log(JSON.stringify({ ok: true, ...result }, null, 2))
} catch (error) {
  console.error(`Audit archive failed: ${error.code ?? error.message}`)
  process.exitCode = 1
}
