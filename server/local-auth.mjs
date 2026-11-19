import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const hash = (value) => createHash('sha256').update(value).digest('hex')
const sessionLifetime = 8 * 60 * 60 * 1000
const rateWindow = 60_000

export function createLocalAuth(keyHash, { clock = Date.now, findMember = () => null, secure = false } = {}) {
  const enabled = keyHash !== undefined
  if (enabled && !/^[0-9a-f]{64}$/.test(keyHash)) throw new Error('ZHIDIAN_OWNER_KEY_HASH must contain 64 lowercase hex digits.')
  const expected = enabled ? Buffer.from(keyHash, 'hex') : null
  const sessions = new Map()
  let rejected = []
  const cookieName = secure ? '__Host-zhidian_session' : 'zhidian_owner'
  const cookie = (token, maxAge) => `${cookieName}=${token}; Path=${secure ? '/' : '/api'}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`
  const clearCookie = cookie('', 0)

  function session(cookieHeader) {
    const matching = String(cookieHeader ?? '').split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${cookieName}=`))
    if (matching.length !== 1) return null
    const token = matching[0].slice(cookieName.length + 1)
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null
    const key = hash(token)
    const stored = sessions.get(key)
    if (!stored || stored.expiresAt <= clock()) {
      sessions.delete(key)
      return null
    }
    return { key, ...stored }
  }

  function login(value, cookieHeader, memberId) {
    if (!enabled) return { status: 409 }
    const time = clock()
    rejected = rejected.filter((attempt) => attempt > time - rateWindow)
    if (rejected.length >= 8) return { status: 429 }
    const member = memberId === undefined ? null : findMember(memberId)
    const target = memberId === undefined ? expected : member?.enabled ? Buffer.from(member.keyHash, 'hex') : null
    const digest = typeof value === 'string' && value.length >= 32 && value.length <= 256 ? Buffer.from(hash(value), 'hex') : null
    if (!target || !digest || !timingSafeEqual(digest, target)) {
      rejected.push(time)
      return { status: 401 }
    }
    const revoked = []
    for (const [key, stored] of sessions) if (stored.expiresAt <= time) { sessions.delete(key); revoked.push(key) }
    const previous = session(cookieHeader)
    if (previous) { sessions.delete(previous.key); revoked.push(previous.key) }
    const accountSessions = [...sessions].filter(([, stored]) => stored.memberId === member?.id)
    if (accountSessions.length >= 8) {
      const oldest = accountSessions[0][0]
      sessions.delete(oldest)
      revoked.push(oldest)
    }
    const token = randomBytes(32).toString('base64url')
    sessions.set(hash(token), { expiresAt: time + sessionLifetime, memberId: member?.id, role: member ? 'viewer' : 'owner' })
    return { status: 200, cookie: cookie(token, sessionLifetime / 1000), revoked }
  }

  function logout(cookieHeader) {
    const current = session(cookieHeader)
    if (current) sessions.delete(current.key)
    return current?.key
  }

  function revokeMember(memberId) {
    const revoked = []
    for (const [key, stored] of sessions) {
      if (stored.memberId === memberId) { sessions.delete(key); revoked.push(key) }
    }
    return revoked
  }

  return { enabled, login, session, logout, revokeMember, clearCookie }
}
