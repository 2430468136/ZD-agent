import test from 'node:test'
import assert from 'node:assert/strict'
import { retrieveContext } from './context-store.mjs'

const entries = [
  { id: 'personal-related', scope: 'personal', title: '回答偏好', content: '代码任务使用 TypeScript 并附上测试命令。', tags: ['TypeScript'], updatedAt: '2026-01-01T00:00:00.000Z' },
  { id: 'project-related', scope: 'project', projectId: 'p1', title: '前端约定', content: '项目使用 React 和 pnpm。', tags: [], updatedAt: '2026-01-02T00:00:00.000Z' },
  { id: 'other-project', scope: 'project', projectId: 'p2', title: '无关资料', content: '数据库使用 PostgreSQL。', tags: [], updatedAt: '2026-01-03T00:00:00.000Z' },
  { id: 'unrelated-personal', scope: 'personal', title: '饮食偏好', content: '喜欢意大利面。', tags: [], updatedAt: '2026-01-04T00:00:00.000Z' },
]

test('retrieval ranks matching personal and current-project context and excludes unrelated entries', () => {
  const result = retrieveContext(entries, 'p1', 'React TypeScript 页面')
  assert.deepEqual(result.map((entry) => entry.id).sort(), ['personal-related', 'project-related'])
  assert.equal(retrieveContext(entries, 'p1', 'React')[0]?.id, 'project-related')
})

test('retrieval never leaks another project and empty queries return no unrelated memories', () => {
  assert.deepEqual(retrieveContext(entries, 'p1', '完全无关词语'), [])
  const otherProjectMatch = retrieveContext(entries, 'p2', 'PostgreSQL')
  assert.deepEqual(otherProjectMatch.map((entry) => entry.id), ['other-project'])
  assert.equal(otherProjectMatch[0].projectId, 'p2')
})
