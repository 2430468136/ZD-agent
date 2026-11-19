import { X509Certificate } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { isIP } from 'node:net'
import { isAbsolute, join } from 'node:path'
import { createSecureContext } from 'node:tls'

export function parseHttpsOrigin(value) {
  if (value === undefined) return null
  let url
  try { url = new URL(value) } catch { /* Invalid configuration. */ }
  if (url?.protocol !== 'https:' || url.origin !== value) throw new Error('ZHIDIAN_HTTPS_ORIGIN must be an exact HTTPS origin without a trailing slash.')
  return url
}

export function httpsHostAllowed(headers, origin) {
  return headers.host === origin.host && !Object.keys(headers).some((name) => name === 'forwarded' || name.startsWith('x-forwarded-'))
}

export function httpsRequestAllowed(request, origin, eventStream) {
  const { headers, method } = request
  const site = headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin') return false
  const sameOrigin = headers.origin === origin.origin
  const safe = method === 'GET' || method === 'HEAD'
  if (!sameOrigin && !(safe && headers.origin === undefined && site === 'same-origin')) return false
  return eventStream || headers['x-zhidian-client'] === 'web-ui'
}

export async function loadTlsOptions(keyPath, certPath, origin) {
  if (!keyPath || !certPath || !isAbsolute(keyPath) || !isAbsolute(certPath)) throw new Error('ZHIDIAN_TLS_KEY and ZHIDIAN_TLS_CERT must be absolute PEM file paths.')
  const info = await lstat(keyPath)
  if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) throw new Error('The TLS key must be a private regular file (mode 0600 on POSIX).')
  try {
    const options = { key: await readFile(keyPath), cert: await readFile(certPath), minVersion: 'TLSv1.2' }
    const leaf = new X509Certificate(options.cert)
    const host = origin.hostname.replace(/^\[|\]$/g, '')
    if (Date.now() < leaf.validFromDate.valueOf() || Date.now() >= leaf.validToDate.valueOf()) throw new Error('TLS leaf certificate is not currently valid.')
    if (!(isIP(host) ? leaf.checkIP(host) : leaf.checkHost(host, { subject: 'never' }))) throw new Error('TLS certificate SAN does not match ZHIDIAN_HTTPS_ORIGIN.')
    try { createSecureContext(options) } catch { throw new Error('TLS private key and server certificate could not be loaded as a pair.') }
    return options
  } catch (error) {
    throw new Error(error.code ? 'HTTPS certificate or key could not be opened or parsed.' : error.message)
  }
}

const knownAssets = new Map([['.js', 'text/javascript'], ['.css', 'text/css'], ['.svg', 'image/svg+xml']])

export async function loadWorkbenchAssets(distDir) {
  const assets = new Map()
  async function add(path, file, contentType) {
    const info = await lstat(file)
    if (!info.isFile() || info.nlink !== 1 || info.size > 8 * 1024 * 1024) throw new Error('Invalid built workbench asset. Rebuild before starting HTTPS.')
    assets.set(path, { contentType, body: await readFile(file) })
  }
  const assetDir = join(distDir, 'assets')
  if (!(await lstat(distDir)).isDirectory() || !(await lstat(assetDir)).isDirectory()) throw new Error('Run pnpm build before starting the HTTPS workbench.')
  await add('/', join(distDir, 'index.html'), 'text/html; charset=utf-8')
  for (const file of ['icons.svg', 'favicon.svg']) await add(`/${file}`, join(distDir, file), 'image/svg+xml')
  for (const file of await readdir(assetDir)) {
    const ext = /^[-A-Za-z0-9_]+(\.[a-z]+)$/.exec(file)?.[1]
    if (knownAssets.has(ext)) await add(`/assets/${file}`, join(assetDir, file), knownAssets.get(ext))
  }
  // Check the build entry before opening the port, including after a partial upgrade.
  const html = assets.get('/').body.toString('utf8')
  const references = [...html.matchAll(/\b(?:src|href)="(\/assets\/[-A-Za-z0-9_.]+)"/g)].map((match) => match[1])
  if (!references.some((path) => path.endsWith('.js')) || references.some((path) => !assets.get(path)?.body.length)) {
    throw new Error('Built workbench entry references a missing or empty asset. Run pnpm build before starting HTTPS.')
  }
  return (request, response, pathname) => {
    const asset = assets.get(pathname)
    if (!asset || (request.method !== 'GET' && request.method !== 'HEAD')) return false
    response.writeHead(200, {
      'content-type': asset.contentType,
      'content-length': asset.body.length,
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    })
    response.end(request.method === 'HEAD' ? undefined : asset.body)
    return true
  }
}
