'use strict'

const { randomUUID } = require('node:crypto')
const { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const filename = 'harness-layout.json'

function normalize(value) {
  if (!Array.isArray(value?.ids) || value.ids.length > 4 || !value.ids.every((id) => typeof id === 'string' && /^run-[\w-]{1,100}$/.test(id))) return null
  const ids = [...new Set(value.ids)]
  return { ids, focused: ids.includes(value.focused) ? value.focused : ids[0] ?? null, mode: value.mode === 'focus' ? 'focus' : 'split' }
}

function loadHarnessLayout(profile) {
  const file = join(profile, filename)
  try {
    const stat = statSync(file)
    if (!stat.isFile() || stat.size > 1024) return null
    return normalize(JSON.parse(readFileSync(file, 'utf8')))
  } catch { return null }
}

function saveHarnessLayout(profile, value) {
  const layout = normalize(value)
  if (!layout) return false
  const file = join(profile, filename)
  const temp = join(profile, `${filename}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temp, JSON.stringify(layout), { flag: 'wx', mode: 0o600 })
    renameSync(temp, file)
    return true
  } catch {
    try { unlinkSync(temp) } catch { /* The temporary file may not have been created. */ }
    return false
  }
}

module.exports = { loadHarnessLayout, saveHarnessLayout }
