import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { test } from 'node:test'
import { loadWorkbenchAssets } from './https-workbench.mjs'

test('HTTPS startup refuses an incomplete production build', async (t) => {
  const dist = await mkdtemp(join(tmpdir(), 'zhidian-build-unit-'))
  t.after(async () => {
    const target = await realpath(dist)
    assert.equal(dirname(target), await realpath(tmpdir()))
    assert.ok(basename(target).startsWith('zhidian-build-unit-'))
    await rm(target, { recursive: true, force: true })
  })
  const assets = join(dist, 'assets')
  await mkdir(assets)
  await Promise.all([
    writeFile(join(dist, 'index.html'), '<script type="module" src="/assets/app.js"></script><link rel="stylesheet" href="/assets/app.css">'),
    writeFile(join(dist, 'icons.svg'), '<svg/>'),
    writeFile(join(dist, 'favicon.svg'), '<svg/>'),
  ])
  await assert.rejects(loadWorkbenchAssets(dist), /missing or empty asset/)
  await writeFile(join(assets, 'app.js'), 'export {};')
  await writeFile(join(assets, 'app.css'), '')
  await assert.rejects(loadWorkbenchAssets(dist), /missing or empty asset/)
  await writeFile(join(assets, 'app.css'), 'body {}')
  const serve = await loadWorkbenchAssets(dist)
  assert.equal(typeof serve, 'function')
})
