const MAX_TITLE = 120
const MAX_CONTENT = 8_000
const MAX_TAGS = 12

export function normalizeContextEntry(body, projects, previous = null) {
  const scope = body.scope === 'project' ? 'project' : body.scope === 'personal' ? 'personal' : null
  if (!scope) throw Object.assign(new Error('上下文类型必须是 personal 或 project。'), { status: 400 })
  const title = typeof body.title === 'string' ? body.title.trim().slice(0, MAX_TITLE) : ''
  const content = typeof body.content === 'string' ? body.content.trim().slice(0, MAX_CONTENT) : ''
  if (!title || !content) throw Object.assign(new Error('标题和内容不能为空。'), { status: 400 })
  const projectId = scope === 'project' ? (typeof body.projectId === 'string' ? body.projectId : '') : ''
  if (scope === 'project' && !projects.has(projectId)) throw Object.assign(new Error('项目资料必须关联一个已授权项目。'), { status: 400 })
  const tags = Array.isArray(body.tags)
    ? [...new Set(body.tags.filter((tag) => typeof tag === 'string').map((tag) => tag.trim().slice(0, 40)).filter(Boolean))].slice(0, MAX_TAGS)
    : []
  const timestamp = new Date().toISOString()
  return {
    id: previous?.id ?? `ctx-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    scope,
    projectId,
    title,
    content,
    tags,
    createdAt: previous?.createdAt ?? timestamp,
    updatedAt: timestamp,
  }
}

function terms(value) {
  return (String(value ?? '').toLocaleLowerCase().match(/[\p{Script=Han}]{2,}|[a-z0-9][a-z0-9_-]{1,}/gu) ?? [])
    .flatMap((term) => term.length > 8 ? [term, ...term.match(/.{1,4}/gu).filter((part) => part.length > 1)] : [term])
}

export function retrieveContext(entries, projectId, query, { maxEntries = 8, maxChars = 8_000 } = {}) {
  const queryTerms = [...new Set(terms(query))]
  const eligible = entries.filter((entry) => entry.scope === 'personal' || (entry.scope === 'project' && entry.projectId === projectId))
  const ranked = eligible.map((entry) => {
    const searchable = terms(`${entry.title} ${(entry.tags ?? []).join(' ')} ${entry.content}`)
    const score = queryTerms.reduce((total, term) => total + (searchable.includes(term) ? (entry.title.toLocaleLowerCase().includes(term) ? 3 : 1) : 0), 0)
    const weight = entry.scope === 'project' ? 2 : 1
    return { entry, score: score * weight }
  }).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score || b.entry.updatedAt.localeCompare(a.entry.updatedAt))
  const selected = []
  let usedChars = 0
  for (const { entry } of ranked) {
    if (selected.length >= maxEntries) break
    const record = { id: entry.id, scope: entry.scope, projectId: entry.projectId || undefined, title: entry.title, content: entry.content, tags: entry.tags ?? [] }
    const size = record.title.length + record.content.length
    if (usedChars + size > maxChars) continue
    selected.push(record)
    usedChars += size
  }
  return selected
}
