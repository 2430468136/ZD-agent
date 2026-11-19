import { readFile } from 'node:fs/promises'
import { connect as tcpConnect, isIP } from 'node:net'
import { checkServerIdentity, connect as tlsConnect } from 'node:tls'
import { performance } from 'node:perf_hooks'

const connectFailures = new Set(['EACCES', 'EPERM', 'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT'])

function endpoint(value) {
  let url
  try { url = new URL(value) } catch { /* Report no input, which could contain a secret. */ }
  if (url?.protocol !== 'https:' || url.origin !== value) throw new Error('Provide exact HTTPS origins without paths, credentials, or queries.')
  return { origin: url.origin, host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 443) }
}

function probe({ origin, host, port }, checkTls, ca) {
  return new Promise((resolve) => {
    const started = performance.now()
    let tcpConnected = false
    let addressKnown = Boolean(isIP(host))
    let finished = false
    const socket = checkTls ? tlsConnect({
      host, port, ca, minVersion: 'TLSv1.2', rejectUnauthorized: true,
      servername: isIP(host) ? undefined : host,
      checkServerIdentity: (_, certificate) => checkServerIdentity(host, certificate),
    }) : tcpConnect({ host, port })
    const timer = setTimeout(() => finish('ETIMEDOUT'), 5000)

    function finish(errorCode) {
      if (finished) return
      finished = true
      clearTimeout(timer)
      const stage = tcpConnected ? (checkTls ? 'tls' : 'tcp') : (addressKnown ? 'tcp' : 'dns')
      resolve({ origin, tcpConnected, tlsVerified: checkTls && tcpConnected && !errorCode,
        stage, errorCode, elapsedMs: Math.round(performance.now() - started) })
      socket.destroy()
    }

    socket.on('lookup', (error, address) => { if (!error && address) addressKnown = true })
    socket.once('connect', () => {
      tcpConnected = true
      if (!checkTls) finish()
    })
    socket.once('secureConnect', () => finish())
    socket.once('error', (error) => finish(error.code ?? 'NETWORK_ERROR'))
    socket.once('close', () => finish('CLOSED'))
  })
}

async function main() {
  const [, , mode, allowedOrigin, deniedOrigin, caPath] = process.argv
  if (!['control', 'deployment'].includes(mode) || !allowedOrigin || !deniedOrigin || process.argv.length > 6) {
    throw new Error('Usage: node scripts/pilot-egress.mjs <control|deployment> <allowed-origin> <denied-origin> [trusted-ca.pem]')
  }
  const allowed = endpoint(allowedOrigin)
  const denied = endpoint(deniedOrigin)
  if (allowed.origin === denied.origin) throw new Error('Use two distinct, authorized endpoints.')
  const ca = caPath ? await readFile(caPath) : undefined
  const [allow, deny] = await Promise.all([probe(allowed, true, ca), probe(denied, mode === 'control', ca)])
  const expected = allow.tlsVerified && (mode === 'control' ? deny.tlsVerified :
    !deny.tcpConnected && deny.stage === 'tcp' && connectFailures.has(deny.errorCode))
  console.log(JSON.stringify({ mode, observedAt: new Date().toISOString(), transport: 'direct-node-tcp', allow, deny, expectedObservations: expected }))
  if (!expected) process.exitCode = 1
}

main().catch((error) => {
  console.error(`Egress probe failed: ${error.code ?? error.message}`)
  process.exitCode = 1
})
