import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { fork } from 'node:child_process'
import { request } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const serverEntry = join(repositoryRoot, 'server.mjs')

function requestHttp(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, { headers }, (incoming) => {
      let body = ''
      incoming.setEncoding('utf8')
      incoming.on('data', (chunk) => { body += chunk })
      incoming.on('end', () => resolve({ status: incoming.statusCode, headers: incoming.headers, body }))
    })
    outgoing.on('error', reject)
    outgoing.end()
  })
}

test('desktop service serves the built UI only to the authorized loopback client and shuts down cleanly', { timeout: 30_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'zhidian-desktop-test-'))
  const token = randomBytes(32).toString('base64url')
  const env = { ...process.env, ZHIDIAN_DESKTOP_MODE: '1', ZHIDIAN_DESKTOP_TOKEN: token, ZHIDIAN_API_PORT: '0', ZHIDIAN_DATA_DIR: dataDir }
  delete env.ZHIDIAN_HTTPS_ORIGIN
  delete env.ZHIDIAN_OWNER_KEY_HASH
  const child = fork(serverEntry, [], { cwd: repositoryRoot, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
  let port
  let gracefullyStopped = false
  try {
    port = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Desktop server startup timed out. stderr=' + stderr)), 20_000)
      const onData = () => {
        const match = /ZHIDIAN_DESKTOP_READY:(\d+)/.exec(stdout)
        if (!match) return
        clearTimeout(timeout)
        child.stdout.removeListener('data', onData)
        resolve(Number(match[1]))
      }
      child.stdout.on('data', onData)
      child.once('error', (error) => { clearTimeout(timeout); reject(error) })
      child.once('exit', (code) => { clearTimeout(timeout); reject(new Error('Desktop server exited early (' + code + '). stderr=' + stderr)) })
    })

    const base = 'http://127.0.0.1:' + port
    const denied = await requestHttp(base + '/api/health')
    assert.equal(denied.status, 403)
    const deniedPage = await requestHttp(base + '/')
    assert.equal(deniedPage.status, 403)
    const wrongHost = await requestHttp(base + '/api/health', { authorization: 'Bearer ' + token, host: 'localhost:' + port })
    assert.equal(wrongHost.status, 403)
    const accepted = await requestHttp(base + '/api/health', { authorization: 'Bearer ' + token })
    assert.equal(accepted.status, 200)
    assert.deepEqual(JSON.parse(accepted.body), { ok: true })
    const page = await requestHttp(base + '/', { authorization: 'Bearer ' + token })
    assert.equal(page.status, 200)
    assert.match(page.headers['content-security-policy'] ?? '', /default-src 'self'/)
    assert.match(page.body, /织点|Zhidian|assets\//i)
    assert.equal(stdout.includes(token), false)
    assert.equal(stderr.includes(token), false)
    gracefullyStopped = await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), 5000)
      child.once('exit', (code) => { clearTimeout(timeout); resolve(code === 0) })
      child.send({ type: 'zhidian:shutdown' })
    })
    assert.equal(gracefullyStopped, true, 'desktop IPC shutdown should flush and close cleanly')
  } finally {
    if (!gracefullyStopped && child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => {
        const timeout = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 5000)
        child.once('exit', () => { clearTimeout(timeout); resolve() })
        if (child.connected) child.send({ type: 'zhidian:shutdown' })
        else child.kill()
      })
    }
    await rm(dataDir, { recursive: true, force: true })
  }
})
