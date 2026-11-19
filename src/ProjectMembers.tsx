import { useEffect, useState, type FormEvent } from 'react'
import { ChevronLeft, ChevronRight, KeyRound, LogOut, Plus, UserRound, X } from 'lucide-react'
import { loadMembers, loadMemberTaskStatus, loadMemberHistory, saveMember, type MemberHistory, type MemberHistoryKind, type MemberTaskStatus, type ProjectMember, type WorkflowProject } from './provider-client'

const formatTime = (value?: string) => value ? new Date(value).toLocaleString('zh-CN') : '无'
const labels: Record<string, string> = { queued: '排队', running: '运行中', completed: '完成', failed: '失败', approved: '通过', 'awaiting-approval': '待确认交付', cancelled: '取消', active: '活跃', sent: '已送达', pending: '待处理', enabled: '启用', disabled: '停用', unknown: '结果未知', 'retry-wait': '等待重试', 'needs-fix': '需修复', test: '测试通知', 'inbound-reply': '入站回复', 'ceo-plan': '规划', 'specialist-execute': '执行', 'qa-review': '验收' }
const label = (value: string) => labels[value] ?? value
const historyViews: { id: MemberHistoryKind; title: string }[] = [
  { id: 'threads', title: '工作线程' }, { id: 'runs', title: '执行记录' },
  { id: 'schedules', title: '定时任务' }, { id: 'deliveries', title: '结果交付' },
]

export function ProjectMembers({ projects }: { projects: WorkflowProject[] }) {
  const [members, setMembers] = useState<ProjectMember[] | null>(null)
  const [selected, setSelected] = useState<ProjectMember | 'new' | null>(null)
  const [issued, setIssued] = useState<{ id: string; key: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let current = true
    void loadMembers().then((result) => { if (current) setMembers(result.members) }, (cause: Error) => { if (current) setError(cause.message) })
    return () => { current = false }
  }, [])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const values = new FormData(event.currentTarget)
    setBusy(true)
    setIssued(null)
    setError('')
    try {
      const result = await saveMember({ name: String(values.get('name')), projectIds: values.getAll('projectIds').map(String), enabled: values.has('enabled'), rotateKey: values.has('rotateKey') }, selected && selected !== 'new' ? selected.id : undefined)
      setMembers((current) => current?.some((member) => member.id === result.member.id) ? current.map((member) => member.id === result.member.id ? result.member : member) : [...(current ?? []), result.member])
      if (result.accessKey) setIssued({ id: result.member.id, key: result.accessKey })
      setSelected(null)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败。') }
    finally { setBusy(false) }
  }

  const active = selected && selected !== 'new' ? selected : null
  return <section className="schedule-page">
    <header className="schedule-page-heading"><h1><UserRound size={21} />项目成员</h1><button className="button-primary" disabled={!projects.length || busy || !members} onClick={() => { setSelected('new'); setIssued(null); setError('') }}><Plus size={16} />添加成员</button></header>
    {error && <p className="schedule-error" role="alert">{error}</p>}
    {selected && <form className="schedule-editor" key={active?.id ?? 'new'} onSubmit={(event) => { void submit(event) }}>
      <label>成员名称<input name="name" required maxLength={80} defaultValue={active?.name} /></label>
      <fieldset className="schedule-days"><legend>只读项目</legend>{projects.map((project) => <label key={project.id}><input type="checkbox" name="projectIds" value={project.id} defaultChecked={active?.projectIds.includes(project.id)} />{project.name}</label>)}</fieldset>
      <div className="schedule-form-footer">
        <label><input type="checkbox" name="enabled" defaultChecked={active?.enabled ?? true} />启用成员</label>
        {active && <label><input type="checkbox" name="rotateKey" />轮换密钥</label>}
        <button className="button-secondary" type="button" disabled={busy} onClick={() => setSelected(null)}>取消</button>
        <button className="button-primary" disabled={busy} type="submit">保存成员</button>
      </div>
    </form>}
    {issued && <section className="schedule-editor" aria-label="一次性显示的成员凭据">
      <div className="schedule-page-heading"><h2><KeyRound size={16} />新访问密钥</h2><button className="button-secondary" onClick={() => setIssued(null)}>关闭</button></div>
      <label>成员 ID<input readOnly value={issued.id} /></label><label>访问密钥（仅此次显示）<input readOnly value={issued.key} /></label>
    </section>}
    <div className="schedule-table-wrap"><table className="schedule-table"><thead><tr><th>成员</th><th>共享项目</th><th>状态</th><th>管理</th></tr></thead><tbody>
      {members?.map((member) => <tr key={member.id}><td>{member.name}<small>{member.id}</small></td><td>{member.projectIds.map((id) => projects.find((project) => project.id === id)?.name ?? id).join('、')}</td><td>{member.enabled ? '已启用' : '已停用'}</td><td><button className="button-secondary" disabled={busy} onClick={() => { setSelected(member); setIssued(null); setError('') }}>编辑</button></td></tr>)}
      {!members?.length && <tr><td colSpan={4}>{members ? '暂无项目成员' : error ? '加载失败' : '正在加载…'}</td></tr>}
    </tbody></table></div>
  </section>
}

function LinkedMemberTask({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const [task, setTask] = useState<MemberTaskStatus | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    let timer: number | undefined
    async function refresh() {
      try {
        const result = await loadMemberTaskStatus(taskId, controller.signal)
        if (!controller.signal.aborted) { setTask(result); setError('') }
      } catch (cause) {
        if (!controller.signal.aborted) { setTask(null); setError(cause instanceof Error ? cause.message : '无法读取任务状态。') }
      } finally {
        if (!controller.signal.aborted) timer = window.setTimeout(() => { void refresh() }, 3000)
      }
    }
    void refresh()
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [taskId])
  return <section className="member-task-status" aria-label="链接任务状态">
    <div className="schedule-page-heading"><h2>链接任务状态</h2><button className="icon-button" type="button" aria-label="关闭链接任务" onClick={onClose}><X size={16} /></button></div>
    {error ? <p className="schedule-error" role="alert">{error}</p> : task ? <dl>
      <div><dt>编号</dt><dd>{task.id}</dd></div><div><dt>项目</dt><dd>{task.projectName}</dd></div><div><dt>线程</dt><dd>{task.threadTitle}</dd></div><div><dt>状态</dt><dd>{label(task.status)}</dd></div><div><dt>更新</dt><dd>{formatTime(task.updatedAt)}</dd></div>
    </dl> : <p role="status">正在读取任务状态…</p>}
  </section>
}

export function MemberWorkspace({ linkedTaskId, onCloseTaskLink, onLogout }: { linkedTaskId: string | null; onCloseTaskLink: () => void; onLogout: () => void }) {
  const [result, setResult] = useState<{ key: string; snapshot?: MemberHistory; error?: string } | null>(null)
  const [projects, setProjects] = useState<MemberHistory['projects'] | null>(null)
  const [selected, setSelected] = useState('')
  const [kind, setKind] = useState<MemberHistoryKind>('threads')
  const [cursors, setCursors] = useState<string[]>([])
  const after = cursors.at(-1)
  const query = new URLSearchParams({ kind, ...(selected ? { projectId: selected } : {}), ...(after ? { after } : {}) }).toString()
  useEffect(() => {
    const controller = new AbortController()
    let timer: number | undefined
    let etag: string | undefined
    async function refresh() {
      try {
        const { snapshot, etag: tag } = await loadMemberHistory(query, controller.signal, etag)
        if (!controller.signal.aborted && snapshot) {
          etag = tag
          setProjects(snapshot.projects)
          setResult({ key: query, snapshot })
        }
      } catch (cause) {
        etag = undefined
        if (!controller.signal.aborted) setResult({ key: query, error: cause instanceof Error ? cause.message : '无法读取项目记录。' })
      } finally {
        if (!controller.signal.aborted) timer = window.setTimeout(() => { void refresh() }, 3000)
      }
    }
    void refresh()
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [query])
  const current = result?.key === query ? result : null
  const snapshot = current?.snapshot
  const project = projects?.find((item) => item.id === selected) ?? projects?.[0]
  const heading = historyViews.find(({ id }) => id === kind)?.title
  return <main className="page-content schedule-page">
    <header className="schedule-page-heading"><h1>织点 · 项目工作台</h1><button className="button-secondary" onClick={onLogout}><LogOut size={16} />退出登录</button></header>
    {linkedTaskId && <LinkedMemberTask key={linkedTaskId} taskId={linkedTaskId} onClose={onCloseTaskLink} />}
    {current?.error && <p className="schedule-error" role="alert">{current.error}</p>}
    {!project && !current?.error && <p>{projects ? '暂无获授权项目' : '正在加载…'}</p>}
    {project && <>
      <div className="member-history-toolbar">
        <label>项目 <select aria-label="项目" value={project.id} onChange={(event) => { setSelected(event.target.value); setCursors([]) }}>{projects?.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <nav aria-label="项目记录" className="member-history-views">
          {historyViews.map(({ id, title }) => <button type="button" key={id} aria-pressed={kind === id} onClick={() => { setKind(id); setCursors([]) }}>{title}</button>)}
        </nav>
      </div>
      <section aria-label={heading} className="member-history-section">
        <div className="schedule-table-wrap"><table className="schedule-table"><thead><tr><th>名称</th><th>状态</th><th>{kind === 'schedules' ? '下次运行' : '时间'}</th></tr></thead><tbody>
        {snapshot?.items.map(({ id, title, status, at, taskId }) => <tr key={id}><td>{taskId && /^[A-Za-z0-9-]{1,100}$/.test(taskId) ? <a href={`#task=${taskId}`}>{label(title)}</a> : kind === 'runs' || kind === 'deliveries' ? label(title) : title}</td><td>{label(status)}</td><td>{formatTime(at)}</td></tr>)}
        {!snapshot?.items.length && <tr><td colSpan={3}>{current?.error ? '记录暂不可用' : snapshot ? '暂无记录' : '正在加载…'}</td></tr>}
      </tbody></table></div>
        <div className="member-history-pagination" aria-label="分页">
          <button type="button" className="icon-button" aria-label="上一页" title="上一页" disabled={!after} onClick={() => setCursors((current) => current.slice(0, -1))}><ChevronLeft size={17} /></button>
          <span>第 {cursors.length + 1} 页</span>
          <button type="button" className="icon-button" aria-label="下一页" title="下一页" disabled={!snapshot?.next} onClick={() => { const next = snapshot?.next; if (next) setCursors((current) => [...current, next]) }}><ChevronRight size={17} /></button>
        </div>
      </section>
    </>}
  </main>
}
