import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const prefix = 'zhidian-v1.'
const keyName = /^[A-Za-z0-9_-]{1,40}$/
export const isVaultCiphertext = (envelope) => typeof envelope === 'string' && envelope.startsWith(prefix)

export function createCredentialVault(config) {
  if (!config || !keyName.test(config.active ?? '') || !config.keys || typeof config.keys !== 'object' || Array.isArray(config.keys)) throw new Error('Invalid credential keyring.')
  const entries = Object.entries(config.keys)
  if (!entries.length || entries.length > 16) throw new Error('Invalid credential keyring size.')
  const keys = new Map(entries.map(([id, value]) => {
    if (!keyName.test(id) || typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error('Invalid credential keyring entry.')
    return [id, Buffer.from(value, 'hex')]
  }))
  const active = config.active
  if (!keys.has(active)) throw new Error('Active credential key not found.')
  const aad = (scope, id) => Buffer.from(JSON.stringify([prefix, id, scope]))
  return {
    seal(scope, value) {
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', keys.get(active), nonce, { authTagLength: 16 })
      cipher.setAAD(aad(scope, active))
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return prefix + [active, nonce.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.')
    },
    open(scope, envelope) {
      try {
        if (!isVaultCiphertext(envelope)) throw new Error()
        const parts = envelope.slice(prefix.length).split('.')
        if (parts.length !== 4) throw new Error()
        const [id, nonce, tag, encrypted] = parts
        if (!keys.has(id) || !/^[\w-]{16}$/.test(nonce) || !/^[\w-]{22}$/.test(tag) || !/^[\w-]*$/.test(encrypted)) throw new Error()
        const cipher = createDecipheriv('aes-256-gcm', keys.get(id), Buffer.from(nonce, 'base64url'), { authTagLength: 16 })
        cipher.setAAD(aad(scope, id))
        cipher.setAuthTag(Buffer.from(tag, 'base64url'))
        return Buffer.concat([cipher.update(Buffer.from(encrypted, 'base64url')), cipher.final()]).toString('utf8')
      } catch { throw new Error('Credential could not be opened with the supplied keyring and scope.') }
    },
  }
}
