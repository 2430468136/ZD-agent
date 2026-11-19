import { isIP } from 'node:net'

const PRIVATE_BIND_CONFIRM = 'I_UNDERSTAND_PRIVATE_TLS'

function parseIpv4(value) {
  const parts = value.split('.').map(Number)
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null
}

export function normalizeIpv4(value, label = 'IPv4 地址') {
  const normalized = String(value ?? '').trim()
  if (isIP(normalized) !== 4 || !parseIpv4(normalized)) throw new Error(`${label}必须是 IPv4 地址。`)
  return normalized
}

export function isLoopbackAddress(value) {
  const normalized = String(value ?? '').replace(/^::ffff:/i, '')
  const parts = parseIpv4(normalized)
  return Boolean(parts && parts[0] === 127) || value === '::1'
}

export function isPrivateIpv4(value) {
  const parts = parseIpv4(String(value ?? '').replace(/^::ffff:/i, ''))
  if (!parts) return false
  const [first, second] = parts
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168) || (first === 100 && second >= 64 && second <= 127)
}

export function resolveDeploymentConfig(env = process.env) {
  const configuredHost = env.ZHIDIAN_BIND_HOST?.trim() || '127.0.0.1'
  const host = normalizeIpv4(configuredHost, 'ZHIDIAN_BIND_HOST')
  if (isLoopbackAddress(host)) return Object.freeze({ host, privateBind: false, trustedClients: new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']) })
  if (!isPrivateIpv4(host)) throw new Error('ZHIDIAN_BIND_HOST 只能是回环地址或受支持的私有 IPv4 地址。')
  if (env.ZHIDIAN_PRIVATE_BIND_CONFIRM !== PRIVATE_BIND_CONFIRM) throw new Error(`非回环监听需要设置 ZHIDIAN_PRIVATE_BIND_CONFIRM=${PRIVATE_BIND_CONFIRM}。`)
  const rawClients = String(env.ZHIDIAN_PRIVATE_CLIENTS ?? '').split(',').map((item) => item.trim()).filter(Boolean)
  if (!rawClients.length) throw new Error('非回环监听需要通过 ZHIDIAN_PRIVATE_CLIENTS 显式允许客户端 IPv4 地址。')
  const trustedClients = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
  for (const client of rawClients) {
    const normalized = normalizeIpv4(client, 'ZHIDIAN_PRIVATE_CLIENTS 中的地址')
    if (!isPrivateIpv4(normalized) && !isLoopbackAddress(normalized)) throw new Error('ZHIDIAN_PRIVATE_CLIENTS 只能包含私有或回环 IPv4 地址。')
    trustedClients.add(normalized)
    trustedClients.add(`::ffff:${normalized}`)
  }
  return Object.freeze({ host, privateBind: true, trustedClients })
}

export function assertPrivateOrigin(config, origin, port) {
  if (!config.privateBind) return
  if (!origin || origin.protocol !== 'https:' || origin.hostname !== config.host || origin.port !== String(port)) {
    throw new Error('非回环监听需要使用与 ZHIDIAN_BIND_HOST 和 ZHIDIAN_API_PORT 完全匹配的 HTTPS Origin。')
  }
}

export function assertPrivateCredentials(config, { authEnabled, credentialVaultConfigured }) {
  if (!config.privateBind) return
  if (!authEnabled || !credentialVaultConfigured) throw new Error('非回环监听需要主人认证和实例密钥环。')
}

export function clientAddressAllowed(address, config) {
  const normalized = String(address ?? '').replace(/^::ffff:/i, '')
  if (!config.privateBind) return isLoopbackAddress(address)
  return config.trustedClients.has(address) || config.trustedClients.has(normalized)
}

export { PRIVATE_BIND_CONFIRM }
