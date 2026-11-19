import test from 'node:test'
import assert from 'node:assert/strict'
import { assertWorkflowDataIntegrity, createSerializedWriter, CURRENT_WORKFLOW_SCHEMA_VERSION, migrateWorkflowData, pruneWorkflowData } from './workflow-store.mjs'

function legacyFixture() {
  return {
    projects: [{ id: 'project-a', path: '/fixture/a', accessMode: 'write' }],
    sessions: [{ id: 'session-a', projectId: 'project-a', title: '旧会话', status: 'completed', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' }],
    tasks: [{ id: 'task-a', sessionId: 'session-a', title: '旧任务', brief: '保留任务背景', status: 'approved', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', execution: { summary: '已完成旧任务' } }],
    reviews: [{ id: 'review-a', taskId: 'task-a' }],
    contextEntries: [{ id: 'context-a', title: 'keep' }],
  }
}

test('workflow v1 migration preserves records and builds a thread/message timeline', () => {
  const migrated = migrateWorkflowData(legacyFixture())
  assert.equal(migrated.schemaVersion, CURRENT_WORKFLOW_SCHEMA_VERSION)
  assert.equal(migrated.projects.length, 1)
  assert.equal(migrated.sessions.length, 1)
  assert.equal(migrated.tasks.length, 1)
  assert.equal(migrated.reviews.length, 1)
  assert.equal(migrated.contextEntries.length, 1)
  assert.equal(migrated.threads.length, 1)
  assert.equal(migrated.sessions[0].threadId, migrated.threads[0].id)
  assert.equal(migrated.tasks[0].threadId, migrated.threads[0].id)
  assert.deepEqual(migrated.messages.map((message) => message.role), ['user', 'assistant'])
  assert.equal(migrated.messages[0].content, '旧任务\n\n保留任务背景')
  assert.equal(migrated.messages[1].content, '已完成旧任务')
  assert.equal(assertWorkflowDataIntegrity(migrated), true)
})

test('workflow v2 migration is idempotent and rejects cross-thread relationships', () => {
  const once = migrateWorkflowData(legacyFixture())
  const twice = migrateWorkflowData(once)
  assert.deepEqual(twice, once)
  const broken = structuredClone(once)
  broken.messages[0].threadId = 'another-thread'
  assert.throws(() => assertWorkflowDataIntegrity(broken), /unknown thread/)
})

test('workflow migration refuses unsupported future versions without dropping data', () => {
  const future = { schemaVersion: CURRENT_WORKFLOW_SCHEMA_VERSION + 1, arbitrary: 'preserve' }
  assert.throws(() => migrateWorkflowData(future), /Unsupported workflow schema version/)
  assert.equal(future.arbitrary, 'preserve')
})

test('serialized writer preserves order and continues after a rejected write', async () => {
  const events = []
  const writer = createSerializedWriter(async (value) => {
    events.push(`start:${value}`)
    await new Promise((resolve) => setTimeout(resolve, value === 'first' ? 10 : 0))
    events.push(`end:${value}`)
    if (value === 'broken') throw new Error('expected fixture failure')
  })
  const first = writer('first')
  const broken = writer('broken')
  const third = writer('third')
  await Promise.all([first, assert.rejects(broken, /expected fixture failure/), third])
  assert.deepEqual(events, ['start:first', 'end:first', 'start:broken', 'end:broken', 'start:third', 'end:third'])
})

test('workflow pruning keeps only complete thread/session/task relationships', () => {
  const migrated = migrateWorkflowData(legacyFixture())
  const threadId = migrated.threads[0].id
  migrated.tasks.push({ ...migrated.tasks[0], id: 'task-b', sessionId: 'session-b', createdAt: '2026-01-03T00:00:00.000Z', updatedAt: '2026-01-03T00:00:00.000Z' })
  migrated.sessions.push({ ...migrated.sessions[0], id: 'session-b' })
  migrated.messages.push({ id: 'message-b', threadId, taskId: 'task-b', role: 'user', content: 'follow up', createdAt: '2026-01-03T00:00:00.000Z' })
  migrated.reviews.push({ id: 'review-b', taskId: 'task-b' })
  const pruned = pruneWorkflowData(migrated, { tasks: 1, messages: 1 })
  assert.equal(pruned.tasks.length, 1)
  assert.equal(pruned.sessions.length, 1)
  assert.equal(pruned.reviews.length, 1)
  assert.equal(pruned.messages.length, 1)
  assert.equal(assertWorkflowDataIntegrity(pruned), true)
})
