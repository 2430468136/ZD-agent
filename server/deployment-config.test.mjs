import test from 'node:test'
import assert from 'node:assert/strict'
import { assertPrivateCredentials, assertPrivateOrigin, clientAddressAllowed, isPrivateIpv4, resolveDeploymentConfig } from './deployment-config.mjs'

test('deployment defaults to loopback and accepts only local clients', () => {
  const config = resolveDeploymentConfig({})
  assert.equal(config.host, '127.0.0.1')
  assert.equal(config.privateBind, false)
  assert.equal(clientAddressAllowed('127.0.0.1', config), true)
  assert.equal(clientAddressAllowed('::ffff:127.0.0.1', config), true)
  assert.equal(clientAddressAllowed('192.168.1.20', config), false)
})

test('private binding requires explicit confirmation and an allowlist', () => {
  assert.throws(() => resolveDeploymentConfig({ ZHIDIAN_BIND_HOST: '192.168.1.10' }), /PRIVATE_BIND_CONFIRM/)
  assert.throws(() => resolveDeploymentConfig({ ZHIDIAN_BIND_HOST: '192.168.1.10', ZHIDIAN_PRIVATE_BIND_CONFIRM: 'I_UNDERSTAND_PRIVATE_TLS' }), /PRIVATE_CLIENTS/)
  const config = resolveDeploymentConfig({ ZHIDIAN_BIND_HOST: '192.168.1.10', ZHIDIAN_PRIVATE_BIND_CONFIRM: 'I_UNDERSTAND_PRIVATE_TLS', ZHIDIAN_PRIVATE_CLIENTS: '192.168.1.20,100.64.0.8' })
  assert.equal(config.privateBind, true)
  assert.equal(clientAddressAllowed('192.168.1.20', config), true)
  assert.equal(clientAddressAllowed('::ffff:192.168.1.20', config), true)
  assert.equal(clientAddressAllowed('192.168.1.21', config), false)
})

test('private binding rejects public, malformed, and unsafe origin or credential configuration', () => {
  assert.equal(isPrivateIpv4('10.0.0.1'), true)
  assert.equal(isPrivateIpv4('172.31.0.1'), true)
  assert.equal(isPrivateIpv4('100.127.0.1'), true)
  assert.equal(isPrivateIpv4('8.8.8.8'), false)
  assert.throws(() => resolveDeploymentConfig({ ZHIDIAN_BIND_HOST: '8.8.8.8', ZHIDIAN_PRIVATE_BIND_CONFIRM: 'I_UNDERSTAND_PRIVATE_TLS', ZHIDIAN_PRIVATE_CLIENTS: '192.168.1.20' }), /私有 IPv4/)
  const config = resolveDeploymentConfig({ ZHIDIAN_BIND_HOST: '10.0.0.1', ZHIDIAN_PRIVATE_BIND_CONFIRM: 'I_UNDERSTAND_PRIVATE_TLS', ZHIDIAN_PRIVATE_CLIENTS: '192.168.1.20' })
  assert.throws(() => assertPrivateOrigin(config, new URL('https://10.0.0.2:9443'), 9443), /完全匹配/)
  assert.throws(() => assertPrivateOrigin(config, new URL('http://10.0.0.1:9443'), 9443), /完全匹配/)
  assert.throws(() => assertPrivateCredentials(config, { authEnabled: true, credentialVaultConfigured: false }), /实例密钥环/)
  assert.doesNotThrow(() => assertPrivateCredentials(config, { authEnabled: true, credentialVaultConfigured: true }))
})
