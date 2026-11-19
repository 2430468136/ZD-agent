import { randomUUID } from 'node:crypto'
import { appendFileSync, lstatSync, renameSync } from 'node:fs'
import { join } from 'node:path'

const exactActions = new Map([
  ['POST /api/auth/login', 'auth.login'], ['POST /api/auth/logout', 'auth.logout'],
  ['POST /api/members', 'membership.create'], ['POST /api/projects', 'project.authorize'],
  ['POST /api/workflow/start', 'workflow.submit'], ['POST /api/runs/plan', 'workflow.plan-only'],
  ['POST /api/context', 'context.create'], ['POST /api/schedules', 'schedule.create'],
])
const resourceActions = [
  [/^\/api\/inbound\/requests\/[^/]+$/,{ POST: 'inbound.decide' }],
  [/^\/api\/members\/[^/]+$/, { PUT: 'membership.update' }],
  [/^\/api\/runs\/[^/]+\/cancel$/, { POST: 'run.cancel' }],
  [/^\/api\/threads\/[^/]+\/followups$/, { POST: 'workflow.followup' }],
  [/^\/api\/workflow\/[^/]+\/plan$/, { POST: 'task.plan' }],
  [/^\/api\/workflow\/[^/]+\/execute$/, { POST: 'task.execute' }],
  [/^\/api\/workflow\/[^/]+\/review$/, { POST: 'task.review' }],
  [/^\/api\/workflow\/[^/]+\/decision$/, { POST: 'task.delivery-decision' }],
  [/^\/api\/context\/[^/]+$/, { PUT: 'context.update', DELETE: 'context.delete' }],
  [/^\/api\/schedules\/[^/]+$/, { PUT: 'schedule.update', DELETE: 'schedule.delete' }],
  [/^\/api\/schedules\/[^/]+\/run-now$/, { POST: 'schedule.run' }],
  [/^\/api\/occurrences\/[^/]+\/cancel$/, { POST: 'occurrence.cancel' }],
  [/^\/api\/delivery\/[^/]+$/, { PUT: 'delivery.configure', DELETE: 'delivery.revoke' }],
  [/^\/api\/delivery\/[^/]+\/test$/, { POST: 'delivery.test' }],
  [/^\/api\/inbound\/[^/]+$/, { POST: 'inbound.receive', PUT: 'inbound.configure', DELETE: 'inbound.revoke' }],
  [/^\/api\/providers\/[^/]+$/, { PUT: 'provider.configure', DELETE: 'provider.clear' }],
  [/^\/api\/providers\/[^/]+\/test$/, { POST: 'provider.test' }],
]
const allowedActions = new Set([...exactActions.values(), ...resourceActions.flatMap(([, methods]) => Object.values(methods))])
const roles = new Set(['owner', 'viewer', 'local', 'anonymous', 'integration'])
const phases = new Set(['attempt', 'result', 'disconnected'])
const fields = new Set(['at', 'requestId', 'action', 'role', 'memberId', 'phase', 'status', 'resourceId'])
const safeId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{3,100}$/.test(value) ? value : undefined
const validStatus = (value) => Number.isInteger(value) && value >= 100 && value < 600
export const auditMaxFileBytes = 8 * 1024 * 1024
export const auditFileNames = ['audit.previous.jsonl', 'audit.jsonl']

export function validAuditEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event) || Object.keys(event).some((key) => !fields.has(key))) return false
  const { at, requestId, action, role, memberId, phase, status, resourceId } = event
  return typeof at === 'string' && Number.isFinite(Date.parse(at)) && new Date(at).toISOString() === at &&
    typeof requestId === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(requestId) &&
    allowedActions.has(action) && roles.has(role) && phases.has(phase) &&
    (memberId === undefined || (role === 'viewer' && Boolean(safeId(memberId)))) &&
    (resourceId === undefined || Boolean(safeId(resourceId))) &&
    (status === undefined || validStatus(status))
}

export function auditAction(method, path) {
  if (!['POST', 'PUT', 'DELETE'].includes(method)) return null
  return exactActions.get(`${method} ${path}`) ?? resourceActions.find(([pattern]) => pattern.test(path))?.[1][method] ?? null
}

export function assertPrivateAuditFile(info) {
  if (!info.isFile() || Number(info.nlink) !== 1 || (process.platform !== 'win32' && (Number(info.mode) & 0o077) !== 0)) throw new Error('Audit path must be a private regular file.')
}

function fileSize(path) {
  try {
    const info = lstatSync(path)
    assertPrivateAuditFile(info)
    return info.size
  } catch (error) { if (error.code === 'ENOENT') return 0; throw error }
}

export function auditFileSizes(directory) {
  const [previousBytes, activeBytes] = auditFileNames.map((name) => fileSize(join(directory, name)))
  return { activeBytes, previousBytes }
}

export function createAuditLog(directory, { maxBytes = auditMaxFileBytes, clock = Date.now, onFailure = () => {} } = {}) {
  const [previous, active] = auditFileNames.map((name) => join(directory, name))
  const options = { mode: 0o600, flush: true }
  auditFileSizes(directory)
  appendFileSync(active, '', options)
  let failed = false
  const sampled = new Map()

  function start(action, identity) {
    return { requestId: randomUUID(), action, role: identity?.role ?? 'anonymous', memberId: identity?.memberId }
  }

  function record(entry, phase, { status, resourceId } = {}) {
    if (failed) return false
    if (!allowedActions.has(entry.action) || !phases.has(phase)) throw new Error('Invalid audit event.')
    const time = clock()
    // Keep the first anonymous rejection of each kind in a short window; it is not an access log.
    if (entry.role === 'anonymous' && !(status >= 200 && status < 300)) {
      const key = `${entry.action}:${status ?? 0}`
      if ((sampled.get(key) ?? -Infinity) > time - 60_000) return true
      sampled.set(key, time)
    }
    const event = { at: new Date(time).toISOString(), requestId: safeId(entry.requestId), action: entry.action, role: roles.has(entry.role) ? entry.role : 'anonymous', memberId: entry.role === 'viewer' ? safeId(entry.memberId) : undefined, phase, status: validStatus(status) ? status : undefined, resourceId: safeId(resourceId) }
    const line = `${JSON.stringify(event)}\n`
    try {
      const size = fileSize(active)
      if (size && size + Buffer.byteLength(line) > maxBytes) {
        fileSize(previous)
        renameSync(active, previous)
      }
      appendFileSync(active, line, options)
      return true
    } catch (error) {
      failed = true
      onFailure(error.code ?? 'invalid-audit-file')
      return false
    }
  }

  return { start, record, get available() { return !failed } }
}
