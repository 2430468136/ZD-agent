import { strict as assert } from 'node:assert'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { createCredentialVault } from './credential-vault.mjs'

const v1 = randomBytes(32).toString('hex')
const v2 = randomBytes(32).toString('hex')

test('credential envelopes authenticate their scope and contents', () => {
  const vault = createCredentialVault({ active: 'v1', keys: { v1 } })
  const scope = 'provider:DeepSeek'
  const envelope = vault.seal(scope, 'fixture-secret')
  assert.equal(vault.open(scope, envelope), 'fixture-secret')
  assert.notEqual(vault.seal(scope, 'fixture-secret'), envelope)
  assert.throws(() => vault.open('delivery:DeepSeek', envelope), /could not be opened/)
  assert.throws(() => vault.open('provider:OpenAI', envelope), /could not be opened/)
  const parts = envelope.split('.')
  parts[4] = `${parts[4][0] === 'A' ? 'B' : 'A'}${parts[4].slice(1)}`
  assert.throws(() => vault.open(scope, parts.join('.')), /could not be opened/)
})

test('an active rotation key can read old and new envelopes without accepting missing or wrong keys', () => {
  const old = createCredentialVault({ active: 'v1', keys: { v1 } })
  const mixed = createCredentialVault({ active: 'v2', keys: { v1, v2 } })
  const next = createCredentialVault({ active: 'v2', keys: { v2 } })
  const scope = 'delivery:project-1'
  const before = old.seal(scope, 'fixture-secret')
  const after = mixed.seal(scope, mixed.open(scope, before))
  assert.match(after, /^zhidian-v1\.v2\./)
  assert.equal(next.open(scope, after), 'fixture-secret')
  assert.throws(() => next.open(scope, before), /could not be opened/)
  assert.throws(() => createCredentialVault({ active: 'v1', keys: { v1: v2 } }).open(scope, before), /could not be opened/)
  assert.throws(() => createCredentialVault({ active: 'v3', keys: { v1, v2 } }), /not found/)
})
