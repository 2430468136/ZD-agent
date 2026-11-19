import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import desktopLayout from '../electron/harness-layout.cjs'

test('desktop profile stores only validated window preferences and replaces them atomically', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'zhidian-layout-test-'))
  const file = join(profile, 'harness-layout.json')
  try {
    assert.equal(desktopLayout.loadHarnessLayout(profile), null)
    const first = { ids: ['run-a', 'run-b'], focused: 'run-b', mode: 'split' }
    assert.ok(desktopLayout.saveHarnessLayout(profile, { ...first, output: 'not a preference' }))
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), first)
    assert.equal(desktopLayout.saveHarnessLayout(profile, { ids: ['../wrong'] }), false)
    assert.deepEqual(desktopLayout.loadHarnessLayout(profile), first)
    const second = { ids: ['run-b'], focused: 'run-b', mode: 'focus' }
    assert.ok(desktopLayout.saveHarnessLayout(profile, second))
    assert.deepEqual(desktopLayout.loadHarnessLayout(profile), second)
    await writeFile(file, 'not json')
    assert.equal(desktopLayout.loadHarnessLayout(profile), null)
  } finally {
    await rm(file, { force: true })
    await rmdir(profile)
  }
})
