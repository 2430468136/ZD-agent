import { createHash, randomBytes, randomUUID } from 'node:crypto'

export function publicMember({ id, name, projectIds, enabled, createdAt, updatedAt }) {
  return { id, name, projectIds, enabled, createdAt, updatedAt }
}

export function updateMember(input, previous, projects, clock = () => new Date().toISOString()) {
  const name = typeof input?.name === 'string' ? input.name.trim() : ''
  const projectIds = Array.isArray(input?.projectIds) ? [...new Set(input.projectIds)] : []
  if (!name || name.length > 80 || !projectIds.length || projectIds.some((projectId) => typeof projectId !== 'string' || !projects.has(projectId)) || typeof input.enabled !== 'boolean') {
    throw Object.assign(new Error('请输入成员名称并选择有效项目。'), { status: 400 })
  }
  const key = !previous || input.rotateKey === true ? randomBytes(32).toString('base64url') : null
  const record = {
    id: previous?.id ?? randomUUID(), name, projectIds, enabled: input.enabled,
    keyHash: key ? createHash('sha256').update(key).digest('hex') : previous.keyHash,
    createdAt: previous?.createdAt ?? clock(), updatedAt: clock(),
  }
  return { record, key }
}

export function viewerProjectIds(member) {
  return new Set(member?.enabled ? member.projectIds : [])
}

export function projectForRun(run, workflow) {
  return projectForTask(workflow.tasks.get(run?.taskId), workflow)
}

export function projectForTask(task, workflow) {
  const session = workflow.sessions.get(task?.sessionId)
  const thread = workflow.threads.get(task?.threadId)
  return session?.threadId === thread?.id && session?.projectId === thread?.projectId ? thread?.projectId : undefined
}

export function viewerRun({ id, taskId, threadId, phase, status, createdAt, completedAt }) {
  return { id, taskId, threadId, phase, status, createdAt, completedAt }
}
