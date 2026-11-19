import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { BookOpen, Check, Pencil, Plus, Save, Trash2, X } from 'lucide-react'
import { deleteContextEntry, loadContextEntries, saveContextEntry, type WorkflowContextEntry, type WorkflowProject } from './provider-client'

type Draft = { scope: 'personal' | 'project'; projectId: string; title: string; content: string; tags: string }
const emptyDraft: Draft = { scope: 'personal', projectId: '', title: '', content: '', tags: '' }

type ContextEntryListProps = {
  values: WorkflowContextEntry[]
  empty: string
  loading: boolean
  projects: WorkflowProject[]
  onEdit: (entry: WorkflowContextEntry) => void
  onRemove: (entry: WorkflowContextEntry) => void
}

function ContextEntryList({ values, empty, loading, projects, onEdit, onRemove }: ContextEntryListProps) {
  if (loading) return <div className="context-empty">正在读取本地资料…</div>
  if (!values.length) return <div className="context-empty">{empty}</div>
  return <div className="context-entry-list">{values.map((entry) => {
    const project = projects.find((item) => item.id === entry.projectId)
    return <article className="context-entry" key={entry.id}>
      <div className="context-entry-top"><span className={`context-scope-tag ${entry.scope}`}>{entry.scope === 'personal' ? '个人偏好' : project?.name ?? '已移除项目'}</span><span className="context-entry-actions"><button type="button" className="context-icon-action" aria-label={`编辑 ${entry.title}`} onClick={() => onEdit(entry)}><Pencil size={14} /></button><button type="button" className="context-icon-action danger" aria-label={`删除 ${entry.title}`} onClick={() => onRemove(entry)}><Trash2 size={14} /></button></span></div>
      <h3>{entry.title}</h3><p>{entry.content}</p>{entry.tags.length > 0 && <div className="context-tag-list">{entry.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>}
      <small>更新于 {new Date(entry.updatedAt).toLocaleString()}</small>
    </article>
  })}</div>
}

export default function ContextLibrary({ projects, onToast }: { projects: WorkflowProject[]; onToast: (message: string) => void }) {
  const [entries, setEntries] = useState<WorkflowContextEntry[]>([])
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setEntries(await loadContextEntries())
    } catch (error) {
      onToast(error instanceof Error ? error.message : '读取长期上下文失败')
    } finally {
      setLoading(false)
    }
  }, [onToast])

  useEffect(() => {
    let active = true
    loadContextEntries().then((loaded) => { if (active) setEntries(loaded) }).catch((error) => {
      if (active) onToast(error instanceof Error ? error.message : '读取长期上下文失败')
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [onToast])

  const personalEntries = useMemo(() => entries.filter((entry) => entry.scope === 'personal'), [entries])
  const projectEntries = useMemo(() => entries.filter((entry) => entry.scope === 'project'), [entries])

  function edit(entry: WorkflowContextEntry) {
    setEditingId(entry.id)
    setDraft({ scope: entry.scope, projectId: entry.projectId ?? '', title: entry.title, content: entry.content, tags: entry.tags.join(', ') })
  }

  function reset() {
    setDraft({ ...emptyDraft, projectId: projects[0]?.id ?? '' })
    setEditingId(null)
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!draft.title.trim() || !draft.content.trim() || (draft.scope === 'project' && !draft.projectId)) return
    setSaving(true)
    try {
      await saveContextEntry({
        scope: draft.scope,
        ...(draft.scope === 'project' ? { projectId: draft.projectId } : {}),
        title: draft.title,
        content: draft.content,
        tags: draft.tags.split(/[，,\n]/).map((tag) => tag.trim()).filter(Boolean),
      }, editingId ?? undefined)
      await refresh()
      onToast(editingId ? '上下文资料已更新' : '上下文资料已保存')
      reset()
    } catch (error) {
      onToast(error instanceof Error ? error.message : '保存长期上下文失败')
    } finally {
      setSaving(false)
    }
  }

  async function remove(entry: WorkflowContextEntry) {
    if (!window.confirm(`确定删除「${entry.title}」吗？`)) return
    try {
      await deleteContextEntry(entry.id)
      await refresh()
      if (editingId === entry.id) reset()
      onToast('上下文资料已删除')
    } catch (error) {
      onToast(error instanceof Error ? error.message : '删除长期上下文失败')
    }
  }

  return <>
    <div className="page-heading inner-heading"><div><div className="eyebrow"><span className="eyebrow-dot" />PROJECT MEMORY & PERSONAL PREFERENCES</div><h1>长期上下文</h1><p>项目资料、个人偏好与单次会话分开保存；新任务只检索相关条目，并把命中结果快照进任务记录。</p></div><div className="team-status-pill"><BookOpen size={15} />{entries.length} 条资料</div></div>
    <div className="routing-notice"><BookOpen size={15} /><span><strong>按关键词检索 · 不是向量数据库</strong> 当前版本根据任务标题和背景做轻量关键词匹配。会话仍保留“这次做过什么”，Skills 仍按 Agent 岗位单独绑定。</span></div>
    <div className="context-library-layout">
      <form className="context-editor" onSubmit={(event) => void submit(event)}>
        <div className="skills-section-head"><div><span className="section-kicker">MEMORY ENTRY <span className="kicker-line" /></span><h2>{editingId ? '编辑资料' : '添加长期资料'}</h2></div>{editingId && <button type="button" className="text-button" onClick={reset}><X size={14} />取消编辑</button>}</div>
        <label className="form-label">存储范围<select value={draft.scope} onChange={(event) => setDraft((current) => ({ ...current, scope: event.target.value as Draft['scope'], projectId: current.projectId || projects[0]?.id || '' }))}><option value="personal">个人偏好</option><option value="project">项目资料</option></select></label>
        {draft.scope === 'project' && <label className="form-label">所属项目<select value={draft.projectId} onChange={(event) => setDraft((current) => ({ ...current, projectId: event.target.value }))}><option value="">选择一个已授权项目</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.name} — {project.path}</option>)}</select>{projects.length === 0 && <small>先在任务中授权一个项目目录，才能添加项目资料。</small>}</label>}
        <label className="form-label">标题<input maxLength={120} value={draft.title} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} placeholder="例如：本项目使用 pnpm，不要改用 npm" /></label>
        <label className="form-label">内容<textarea rows={7} maxLength={8000} value={draft.content} onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))} placeholder="写入已确认的决定、代码约定或个人协作偏好。不要存 API Key、密码等秘密。" /></label>
        <label className="form-label">检索标签 <span>逗号分隔</span><input value={draft.tags} onChange={(event) => setDraft((current) => ({ ...current, tags: event.target.value }))} placeholder="pnpm, TypeScript, 测试" /></label>
        <div className="context-editor-note">个人资料会参与所有项目任务检索；项目资料只会用于所属项目。命中的内容会记录在任务快照中，之后修改资料不会改写历史任务。</div>
        <button className="button-primary context-save" type="submit" disabled={saving || !draft.title.trim() || !draft.content.trim() || (draft.scope === 'project' && !draft.projectId)}>{editingId ? <Save size={15} /> : <Plus size={15} />}{saving ? '保存中…' : editingId ? '保存修改' : '添加资料'}<Check size={15} /></button>
      </form>
      <div className="context-library-lists">
        <section className="context-list-panel"><div className="skills-section-head"><div><span className="section-kicker">PERSONAL <span className="kicker-line" /></span><h2>个人偏好</h2></div><span className="skills-count">{personalEntries.length} 条</span></div><ContextEntryList values={personalEntries} empty="还没有个人偏好。可记录回答风格、默认技术选择或协作习惯。" loading={loading} projects={projects} onEdit={edit} onRemove={(entry) => void remove(entry)} /></section>
        <section className="context-list-panel"><div className="skills-section-head"><div><span className="section-kicker">PROJECT KNOWLEDGE <span className="kicker-line" /></span><h2>项目资料</h2></div><span className="skills-count">{projectEntries.length} 条</span></div><ContextEntryList values={projectEntries} empty="还没有项目资料。先授权项目，再保存架构决定、命令和关键约束。" loading={loading} projects={projects} onEdit={edit} onRemove={(entry) => void remove(entry)} /></section>
      </div>
    </div>
  </>
}
