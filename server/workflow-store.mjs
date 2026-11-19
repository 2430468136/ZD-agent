export const CURRENT_WORKFLOW_SCHEMA_VERSION = 4

function defaultId(prefix, sourceId) {
  return `${prefix}-${sourceId}`
}

function ensureUniqueIds(records, label) {
  const ids = new Set()
  for (const record of records) {
    if (!record || typeof record.id !== 'string' || !record.id.trim()) throw new Error(`${label} record is missing an id.`)
    if (ids.has(record.id)) throw new Error(`${label} contains duplicate id ${record.id}.`)
    ids.add(record.id)
  }
  return ids
}

export function assertWorkflowDataIntegrity(data) {
  if (!data || typeof data !== 'object' || data.schemaVersion !== CURRENT_WORKFLOW_SCHEMA_VERSION) throw new Error('Unsupported workflow data schema version.')
  const projects = data.projects ?? []
  const sessions = data.sessions ?? []
  const tasks = data.tasks ?? []
  const reviews = data.reviews ?? []
  const threads = data.threads ?? []
  const messages = data.messages ?? []
  const projectIds = ensureUniqueIds(projects, 'projects')
  ensureUniqueIds(sessions, 'sessions')
  const taskIds = ensureUniqueIds(tasks, 'tasks')
  ensureUniqueIds(reviews, 'reviews')
  const threadIds = ensureUniqueIds(threads, 'threads')
  ensureUniqueIds(messages, 'messages')

  for (const thread of threads) {
    if (!projectIds.has(thread.projectId)) throw new Error(`Thread ${thread.id} points to an unknown project.`)
  }

  const sessionById = new Map(sessions.map((session) => [session.id, session]))
  const taskById = new Map(tasks.map((task) => [task.id, task]))
  const threadById = new Map(threads.map((thread) => [thread.id, thread]))
  const runsById = new Map((data.runs ?? []).map((run) => [run.id, run]))
  const submissionIds = new Set()
  for (const session of sessions) {
    const thread = threadById.get(session.threadId)
    if (!thread || !projectIds.has(session.projectId) || thread.projectId !== session.projectId) throw new Error(`Session ${session.id} has an invalid project/thread relationship.`)
  }
  for (const task of tasks) {
    const session = sessionById.get(task.sessionId)
    if (!session || !threadIds.has(task.threadId) || session.threadId !== task.threadId) throw new Error(`Task ${task.id} has an invalid session/thread relationship.`)
    if (task.submission === undefined) continue
    const { key, digest, runId } = task.submission ?? {}
    const run = runsById.get(runId)
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(key) || typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest) || run?.taskId !== task.id || run.phase !== 'ceo-plan' || submissionIds.has(key)) throw new Error(`Task ${task.id} has an invalid submission receipt.`)
    submissionIds.add(key)
  }
  for (const review of reviews) {
    if (!taskIds.has(review.taskId)) throw new Error(`Review ${review.id} points to an unknown task.`)
  }
  for (const message of messages) {
    if (!threadIds.has(message.threadId)) throw new Error(`Message ${message.id} points to an unknown thread.`)
    if (message.taskId && (!taskById.has(message.taskId) || taskById.get(message.taskId).threadId !== message.threadId)) {
      throw new Error(`Message ${message.id} points to a task outside its thread.`)
    }
  }
  return true
}


export function pruneWorkflowData(data, limits = {}) {
  const maxProjects = limits.projects ?? 50
  const maxThreads = limits.threads ?? 200
  const maxTasks = limits.tasks ?? 200
  const maxMessages = limits.messages ?? 1_000
  const byRecent = (records) => [...records].sort((a, b) => String(b.updatedAt ?? b.createdAt ?? '').localeCompare(String(a.updatedAt ?? a.createdAt ?? '')))
  const projects = byRecent(data.projects ?? []).slice(0, maxProjects)
  const projectIds = new Set(projects.map((project) => project.id))
  const threads = byRecent((data.threads ?? []).filter((thread) => projectIds.has(thread.projectId))).slice(0, maxThreads)
  const threadIds = new Set(threads.map((thread) => thread.id))
  const sessionsById = new Map((data.sessions ?? []).map((session) => [session.id, session]))
  const tasks = byRecent((data.tasks ?? []).filter((task) => {
    const session = sessionsById.get(task.sessionId)
    return threadIds.has(task.threadId) && session?.threadId === task.threadId
  })).slice(0, maxTasks)
  const taskIds = new Set(tasks.map((task) => task.id))
  const sessionIds = new Set(tasks.map((task) => task.sessionId))
  const sessions = (data.sessions ?? []).filter((session) => sessionIds.has(session.id))
  const retainedThreadIds = new Set([...threads.map((thread) => thread.id), ...sessions.map((session) => session.threadId)])
  const retainedThreads = threads.filter((thread) => retainedThreadIds.has(thread.id))
  const retainedMessages = byRecent((data.messages ?? []).filter((message) => retainedThreadIds.has(message.threadId) && (!message.taskId || taskIds.has(message.taskId))))
    .slice(0, maxMessages)
  const reviews = (data.reviews ?? []).filter((review) => taskIds.has(review.taskId))
  const contextEntries = byRecent(data.contextEntries ?? []).slice(0, limits.contextEntries ?? 500)
  const inboundTargets = (data.inboundTargets ?? []).filter((target) => projectIds.has(target.projectId))
  const inboundEvents = byRecent(data.inboundEvents ?? []).filter((event) => projectIds.has(event.projectId)).slice(0, limits.inboundEvents ?? 2_000)
  return {
    schemaVersion: CURRENT_WORKFLOW_SCHEMA_VERSION,
    projects,
    sessions,
    tasks,
    reviews,
    contextEntries,
    inboundTargets,
    inboundEvents,
    threads: retainedThreads,
    messages: retainedMessages,
    runs: (data.runs ?? []).filter((run) => taskIds.has(run.taskId)),
  }
}

export function migrateWorkflowData(input, { idFactory = defaultId } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Workflow data must be a JSON object.')
  const version = Number.isInteger(input.schemaVersion) ? input.schemaVersion : 1
  if (input.schemaVersion !== undefined && !Number.isInteger(input.schemaVersion)) throw new Error('Invalid workflow schema version.')
  if (version < 1 || version > CURRENT_WORKFLOW_SCHEMA_VERSION) throw new Error(`Unsupported workflow schema version ${version}.`)
  for (const key of ['projects', 'sessions', 'tasks', 'reviews', 'contextEntries', 'threads', 'messages']) {
    if ((input[key] !== undefined || version === CURRENT_WORKFLOW_SCHEMA_VERSION) && !Array.isArray(input[key])) throw new Error(`Workflow state is missing or has invalid ${key}.`)
  }

  const projects = Array.isArray(input.projects) ? input.projects : []
  const sessions = (Array.isArray(input.sessions) ? input.sessions : []).map((session) => ({ ...session }))
  const tasks = (Array.isArray(input.tasks) ? input.tasks : []).map((task) => ({ ...task }))
  const reviews = Array.isArray(input.reviews) ? input.reviews : []
  const contextEntries = Array.isArray(input.contextEntries) ? input.contextEntries : []
  const threads = (Array.isArray(input.threads) ? input.threads : []).map((thread) => ({ ...thread }))
  const messages = (Array.isArray(input.messages) ? input.messages : []).map((message) => ({ ...message }))

  if (version < 2) {
    const threadBySession = new Map()
    for (const task of tasks) {
      const session = sessions.find((item) => item.id === task.sessionId)
      if (!session) continue
      let threadId = session.threadId ?? threadBySession.get(session.id)
      if (!threadId || !threads.some((thread) => thread.id === threadId)) {
        threadId = idFactory('thread', session.id)
        threadBySession.set(session.id, threadId)
        threads.push({
          id: threadId,
          projectId: session.projectId,
          title: session.title || task.title || '历史工作线程',
          status: session.status || 'active',
          agents: task.agents ?? {},
          createdAt: session.createdAt || task.createdAt,
          updatedAt: session.updatedAt || task.updatedAt || task.createdAt,
        })
      }
      session.threadId = threadId
      task.threadId = threadId
      const userMessageId = idFactory('message-user', task.id)
      if (!messages.some((message) => message.id === userMessageId)) {
        const content = [task.title, task.brief].filter((value) => typeof value === 'string' && value.trim()).join('\n\n')
        messages.push({ id: userMessageId, threadId, taskId: task.id, role: 'user', content, createdAt: task.createdAt || session.createdAt })
      }
      if (['approved', 'failed', 'needs-fix', 'cancelled', 'executed'].includes(task.status)) {
        const assistantMessageId = idFactory('message-assistant', task.id)
        if (!messages.some((message) => message.id === assistantMessageId)) {
          const summary = task.execution?.summary || task.plan?.summary || `历史任务状态：${task.status}`
          messages.push({ id: assistantMessageId, threadId, taskId: task.id, role: 'assistant', content: String(summary).slice(0, 2_000), createdAt: task.updatedAt || task.createdAt })
        }
      }
    }
  }

  const result = { schemaVersion: CURRENT_WORKFLOW_SCHEMA_VERSION, projects, sessions, tasks, reviews, contextEntries, threads, messages }
  for (const key of ['runs', 'schedules', 'occurrences', 'deliveryTargets', 'deliveries', 'members']) {
    if ((input[key] !== undefined || version === CURRENT_WORKFLOW_SCHEMA_VERSION) && !Array.isArray(input[key])) throw new Error(`Workflow state is missing or has invalid ${key}.`)
    result[key] = Array.isArray(input[key]) ? input[key] : []
    ensureUniqueIds(result[key], key)
  }
  for (const key of ['inboundTargets', 'inboundEvents']) {
    if (input[key] === undefined) continue
    if (!Array.isArray(input[key])) throw new Error(`Workflow state is missing or has invalid ${key}.`)
    result[key] = input[key]
    ensureUniqueIds(result[key], key)
  }
  for (const schedule of result.schedules) {
    if (!projects.some((project) => project.id === schedule.projectId)) throw new Error(`Schedule ${schedule.id} points to an unknown project.`)
  }
  for (const occurrence of result.occurrences) {
    if (!result.schedules.some((schedule) => schedule.id === occurrence.scheduleId)) throw new Error(`Occurrence ${occurrence.id} points to an unknown schedule.`)
    if (occurrence.taskIds?.some((taskId) => !tasks.some((task) => task.id === taskId && task.occurrenceId === occurrence.id))) throw new Error(`Occurrence ${occurrence.id} points to an unrelated task.`)
  }
  const projectIds = new Set(projects.map((project) => project.id))
  for (const target of result.inboundTargets ?? []) {
    if (!projectIds.has(target.projectId)) throw new Error(`Inbound target ${target.id} points to an unknown project.`)
  }
  for (const event of result.inboundEvents ?? []) {
    if (!projectIds.has(event.projectId)) throw new Error(`Inbound event ${event.id} points to an unknown project.`)
  }
  for (const member of result.members) {
    if (typeof member.name !== 'string' || typeof member.enabled !== 'boolean' || !/^[0-9a-f]{64}$/.test(member.keyHash) || !Array.isArray(member.projectIds) || !member.projectIds.length || member.projectIds.some((id) => !projectIds.has(id))) {
      throw new Error(`Member ${member.id} has invalid credentials or project grants.`)
    }
  }
  assertWorkflowDataIntegrity(result)
  return result
}

export function createSerializedWriter(write) {
  let pending = Promise.resolve()
  return (...args) => {
    const current = pending.catch(() => undefined).then(() => write(...args))
    pending = current
    return current
  }
}
