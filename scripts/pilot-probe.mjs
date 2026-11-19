import { readFile } from 'node:fs/promises'
import { request } from 'node:https'
import { stdin } from 'node:process'
import { setTimeout as wait } from 'node:timers/promises'
import { checkServerIdentity } from 'node:tls'
import { parseHttpsOrigin } from '../server/https-workbench.mjs'

const usage = 'Usage: node scripts/pilot-probe.mjs <exact-https-origin> [trusted-ca.pem] [--member <fixture.json> [--watch-revocation | --measure-history]]'
const fixtureIds = ['memberId', 'projectId', 'threadId', 'taskId', 'excludedProjectId', 'excludedRunId']

async function readFixture(path) {
  try {
    const raw = await readFile(path, 'utf8')
    if (raw.length > 4096) throw new Error()
    const fixture = JSON.parse(raw)
    if (!fixture || Object.keys(fixture).length !== fixtureIds.length + 1 || fixtureIds.some((id) => typeof fixture[id] !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(fixture[id])) ||
      fixture.projectId === fixture.excludedProjectId || typeof fixture.certificateFingerprint256 !== 'string' || !/^(?:[0-9a-f]{2}:){31}[0-9a-f]{2}$/i.test(fixture.certificateFingerprint256)) throw new Error()
    return { ...fixture, certificateFingerprint256: fixture.certificateFingerprint256.toUpperCase() }
  } catch { throw new Error('Invalid member fixture: supply only the expected IDs and trusted certificate fingerprint.') }
}

async function readKey() {
  if (stdin.isTTY) throw new Error('Pipe the temporary member key from a masked prompt into standard input.')
  let input = ''
  stdin.setEncoding('utf8')
  for await (const chunk of stdin) {
    input += chunk
    if (input.length > 64) throw new Error('Invalid member key on standard input.')
  }
  const key = input.trim()
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error('Invalid member key on standard input.')
  return key
}

function readJson(response, label) {
  try { return JSON.parse(response.body) } catch { throw new Error(`${label} did not return valid JSON.`) }
}

async function measureHistory(get, { projectId, taskId, excludedProjectId }) {
  const task = await get(`/api/member/tasks/${encodeURIComponent(taskId)}`)
  const visible = task.status === 200 ? readJson(task, 'Member task') : null
  if (visible?.id !== taskId || visible.projectId !== projectId) throw new Error('Expected task is not visible in the measured project.')
  const history = (id) => `/api/member/history?${new URLSearchParams({ kind: 'threads', projectId: id })}`
  const excluded = await get(history(excludedProjectId))
  if (excluded.status !== 404) throw new Error('Viewer could access an excluded history page (expected HTTP 404).')

  const milliseconds = (value) => Number(value.toFixed(2))
  const path = history(projectId)
  const started = performance.now()
  const initial = await get(path)
  const elapsed = milliseconds(performance.now() - started)
  const state = initial.status === 200 ? readJson(initial, 'Member history') : null
  if (state?.kind !== 'threads' || state.projectId !== projectId || !Array.isArray(state.projects) || state.projects.length !== 1 ||
    state.projects[0]?.id !== projectId || !Array.isArray(state.items) || state.items.length < 1 || state.items.length > 40 ||
    !/^W\/"member-[A-Za-z0-9_-]{43}"$/.test(initial.etag ?? '')) throw new Error('Unexpected member history page or validator.')

  const rounds = 3
  const parallel = 4
  const samples = []
  for (let round = 0; round < rounds; round += 1) {
    const timings = await Promise.all(Array.from({ length: parallel }, async () => {
      const start = performance.now()
      const response = await get(path, initial.etag)
      if (response.status === 200 && response.etag !== initial.etag) throw new Error('Member history changed during the sample; repeat in a quiet window.')
      if (response.status !== 304 || response.bodyBytes !== 0 || response.etag !== initial.etag) {
        throw new Error(`Unexpected conditional member history response (HTTP ${response.status}).`)
      }
      return performance.now() - start
    }))
    samples.push(...timings)
  }
  samples.sort((a, b) => a - b)
  const middle = samples.length / 2
  return {
    projectId, taskId, excludedHistoryStatus: excluded.status, transport: 'fresh-tls-per-request',
    initial: { items: state.items.length, bodyBytes: initial.bodyBytes, elapsedMs: elapsed },
    conditional: { rounds, parallel, notModified: samples.length, bodyBytes: 0, medianMs: milliseconds((samples[middle - 1] + samples[middle]) / 2), maxMs: milliseconds(samples.at(-1)) },
  }
}

async function checkMember(send, fixture, mode) {
  const { memberId, projectId, threadId, taskId, excludedProjectId, excludedRunId } = fixture
  const login = await send('/api/auth/login', { method: 'POST', body: { memberId, key: await readKey() } })
  if (login.status !== 200) throw new Error(`Member login failed (HTTP ${login.status}).`)
  const parts = login.sessionCookie?.split(';').map((part) => part.trim()) ?? []
  const cookie = parts[0]
  if (!/^__Host-zhidian_session=[A-Za-z0-9_-]{43}$/.test(cookie ?? '') || !['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/'].every((flag) => parts.includes(flag))) {
    throw new Error('Member login did not issue a valid secure session cookie.')
  }
  const get = (path, etag) => send(path, { cookie, etag })
  const logout = () => send('/api/auth/logout', { method: 'POST', cookie })
  let closed = false
  const finish = async (report) => {
    const { status } = await logout()
    if (status !== 200) throw new Error(`Member logout failed (HTTP ${status}).`)
    closed = true
    return report
  }
  try {
    const auth = await get('/api/auth/status')
    const session = readJson(auth, 'Auth status')
    if (auth.status !== 200 || session?.signedIn !== true || session?.role !== 'viewer') throw new Error('Probe must be signed in as a viewer.')
    if (mode === '--measure-history') return await finish(await measureHistory(get, fixture))
    const workspace = await get('/api/member/workspace')
    if (workspace.status !== 200) throw new Error(`Member workspace was not accessible (HTTP ${workspace.status}).`)
    const state = readJson(workspace, 'Member workspace')
    if (!state || !['projects', 'threads', 'runs', 'schedules', 'deliveries'].every((field) => Array.isArray(state[field]))) throw new Error('Member workspace response was incomplete.')
    if (state.projects.length !== 1 || state.projects[0]?.id !== projectId ||
      ['threads', 'runs', 'schedules', 'deliveries'].some((field) => state[field].some((record) => record?.projectId !== projectId)) ||
      state.runs.some((run) => run.id === excludedRunId || 'events' in run || 'output' in run)) throw new Error('Member workspace did not match the single-project access scope.')
    const thread = state.threads.find((record) => record.id === threadId)
    const run = state.runs.find((record) => record.taskId === taskId && record.threadId === threadId)
    if (!thread || !run || !/^[a-z-]{1,48}$/.test(thread.status ?? '') || !/^[a-z-]{1,48}$/.test(run.status ?? '')) throw new Error('Expected thread and task run not visible in the permitted project.')
    const ownerRoute = await get('/api/workbench')
    if (ownerRoute.status !== 403) throw new Error('Viewer could access the owner workbench (expected HTTP 403).')
    const externalRun = await get(`/api/runs/${encodeURIComponent(excludedRunId)}/events`)
    if (externalRun.status !== 404) throw new Error('Viewer could access an excluded project run (expected HTTP 404).')
    const report = { projectId, threadId, taskId, threadStatus: thread.status, runStatus: run.status, excludedProjectId, ownerWorkbenchStatus: ownerRoute.status, excludedRunStatus: externalRun.status }
    if (mode === '--watch-revocation') {
      console.error('Member checks passed. Disable this dedicated test member on device A within 90 seconds.')
      const deadline = performance.now() + 90_000
      while (performance.now() < deadline) {
        await wait(1000)
        const current = await get('/api/member/workspace')
        if (current.status === 401) {
          closed = true
          return { ...report, oldSessionStatus: 401, sessionDeniedAt: new Date().toISOString() }
        }
        if (current.status !== 200) throw new Error(`Unexpected workspace status while watching the old session (HTTP ${current.status}).`)
      }
      throw new Error('Old member session was not rejected within the revocation window.')
    }
    return await finish(report)
  } finally {
    if (!closed) await logout().catch(() => {})
  }
}

async function main() {
  const [url, ...args] = process.argv.slice(2)
  if (!url) throw new Error(usage)
  const caPath = args[0] && !args[0].startsWith('--') ? args.shift() : undefined
  let fixture
  let mode
  if (args.length) {
    if (args[0] !== '--member' || !args[1] || args[1].startsWith('--') || args.length > 3 || (args.length === 3 && !['--watch-revocation', '--measure-history'].includes(args[2]))) throw new Error(usage)
    fixture = await readFixture(args[1])
    mode = args[2]
  }
  const origin = parseHttpsOrigin(url).origin
  const ca = caPath ? await readFile(caPath) : undefined

  function send(path, { requestOrigin = origin, method = 'GET', body, cookie, etag } = {}) {
    const limit = path === '/api/member/workspace' ? 512 * 1024 : path.startsWith('/api/member/history?') ? 64 * 1024 : 4096
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
      const req = request(`${origin}${path}`, {
        ca, method, agent: false, rejectUnauthorized: true, signal: AbortSignal.timeout(5_000),
        checkServerIdentity(host, certificate) {
          return checkServerIdentity(host, certificate) ?? (fixture && certificate.fingerprint256 !== fixture.certificateFingerprint256 ? new Error('Peer certificate fingerprint does not match the trusted fixture.') : undefined)
        },
        headers: { origin: requestOrigin, 'x-zhidian-client': 'web-ui', ...(cookie && { cookie }), ...(etag && { 'if-none-match': etag }), ...(payload && { 'content-type': 'application/json', 'content-length': payload.length }) },
      }, async (response) => {
        try {
          const protocol = response.socket.getProtocol()
          const cert = response.socket.getPeerX509Certificate()
          const chunks = []
          let size = 0
          for await (const chunk of response) {
            size += chunk.length
            if (size > limit) throw new Error('Probe response was too large.')
            chunks.push(chunk)
          }
          resolve({ status: response.statusCode, protocol, cert, body: Buffer.concat(chunks, size).toString('utf8'), bodyBytes: size,
            etag: response.headers.etag, sessionCookie: response.headers['set-cookie']?.[0] })
        } catch (error) { reject(error) }
      })
      req.on('error', reject)
      req.end(payload)
    })
  }

  const healthy = await send('/api/health')
  if (healthy.status !== 200 || readJson(healthy, 'HTTPS health')?.ok !== true) throw new Error('HTTPS health check failed.')
  const privateRoute = await send('/api/workflow')
  if (privateRoute.status !== 401) throw new Error('Anonymous workflow access was not rejected (expected HTTP 401).')
  const workbenchRoute = await send('/api/workbench')
  if (workbenchRoute.status !== 401) throw new Error('Anonymous workbench access was not rejected (expected HTTP 401).')
  const foreignRoute = await send('/api/health', { requestOrigin: 'null' })
  if (foreignRoute.status !== 403) throw new Error('Invalid request Origin was not rejected (expected HTTP 403).')
  const member = fixture ? await checkMember(send, fixture, mode) : undefined
  const details = fixture ? { observedAt: new Date().toISOString(), ...(mode === '--measure-history'
    ? { scope: 'member-history-measurement', measurement: member }
    : { scope: 'member-view-and-policy', member }) } : {}
  console.log(JSON.stringify({ ok: true, origin, tls: healthy.protocol, certificateExpiresAt: healthy.cert.validToDate.toISOString(),
    certificateFingerprint256: healthy.cert.fingerprint256, anonymousWorkflowStatus: privateRoute.status,
    anonymousWorkbenchStatus: workbenchRoute.status, rejectedOriginStatus: foreignRoute.status, ...details }))
}

main().catch((error) => {
  console.error(`Pilot probe failed: ${error.code ?? error.message}`)
  process.exitCode = 1
})
