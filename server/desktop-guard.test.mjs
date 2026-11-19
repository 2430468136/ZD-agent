import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createDesktopRequestGuard } from './desktop-guard.mjs'

test('desktop request guard requires the per-process token and loopback source', () => {
  const token = randomBytes(32).toString('base64url')
  const allowed = createDesktopRequestGuard(token)
  assert.equal(allowed('127.0.0.1', 'Bearer ' + token), true)
  assert.equal(allowed('::ffff:127.0.0.1', 'Bearer ' + token), true)
  assert.equal(allowed('192.168.1.4', 'Bearer ' + token), false)
  assert.equal(allowed('127.0.0.1', 'Bearer wrong'), false)
  assert.equal(allowed('127.0.0.1', undefined), false)
})

test('desktop request guard rejects malformed startup tokens', () => {
  assert.throws(() => createDesktopRequestGuard('short'), /Invalid desktop request token/)
})
