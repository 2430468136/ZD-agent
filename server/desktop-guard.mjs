import { timingSafeEqual } from 'node:crypto'
import { isLoopbackAddress } from './deployment-config.mjs'

export function createDesktopRequestGuard(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Invalid desktop request token.')
  const expected = Buffer.from(token, 'base64url')
  if (expected.length !== 32) throw new Error('Invalid desktop request token.')
  return (remoteAddress, authorization) => {
    if (!isLoopbackAddress(remoteAddress) || typeof authorization !== 'string') return false
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization)
    if (!match) return false
    const supplied = Buffer.from(match[1], 'base64url')
    return supplied.length === expected.length && timingSafeEqual(supplied, expected)
  }
}
