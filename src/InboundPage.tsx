import { useEffect, useState, type FormEvent } from 'react'
import { ArrowDownToLine, ChevronLeft, ChevronRight, ExternalLink, ShieldCheck, Trash2 } from 'lucide-react'
import { decideInbound, loadInbound, loadTaskHistory, revokeInbound, saveInbound, type InboundTarget, type InboundEvent, type WorkflowProject } from './provider-client'
import { useWorkbenchHistory } from './workbench-history'
import './SchedulesPage.css'

const intents: Record<string, string> = { status: '查询状态', approve: '请求审批', reply: '回复线程', create: '创建任务' }
const statuses: Record<string, string> = { accepted: '已处理', 'awaiting-owner': '待主人处理', acknowledged: '已阅', dismissed: '已驳回' }
type Settings = Parameters<typeof saveInbound>[1]

function InboundForm({ target, projectId, busy, onSave }: { target?: InboundTarget; projectId: string; busy: boolean; onSave: (value: Settings) => Promise<boolean> }) {
  const [channel, setChannel] = useState<InboundTarget['channel']>(target?.channel ?? 'feishu')
  const needsCredentials = target?.channel !== channel
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    const value = (key: string) => String(data.get(key) ?? '').trim()
    const ids = (key: string) => value(key).split(/[,，\s]+/).filter(Boolean)
    const verificationToken = value('verificationToken')
    const encryptKey = value('encryptKey')
    const appSecret = value('appSecret')
    const saved = await onSave({
      channel, enabled: data.has('enabled'), appId: value('appId'), tenantKey: value('tenantKey'),
      allowedUsers: ids('allowedUsers'), allowedChats: ids('allowedChats'), intents: data.getAll('intent').map(String),
      ...(verificationToken || encryptKey ? { verificationToken, encryptKey } : {}),
      ...(appSecret ? { appSecret } : {}),
      ...(data.has('clearAppSecret') ? { clearAppSecret: true } : {}),
    })
    if (saved) for (const key of ['verificationToken', 'encryptKey', 'appSecret']) (form.elements.namedItem(key) as HTMLInputElement).value = ''
  }
  return <form className="schedule-editor" onSubmit={(event) => { void submit(event) }} autoComplete="off">
    <div className="schedule-form-grid">
      <label>渠道<select value={channel} onChange={(event) => setChannel(event.target.value as InboundTarget['channel'])}><option value="feishu">飞书</option><option value="lark">Lark</option></select></label>
      <label>应用 ID<input name="appId" defaultValue={target?.appId} required /></label>
      <label>租户 Key<input name="tenantKey" defaultValue={target?.tenantKey} required /></label>
      <label>验证令牌<input name="verificationToken" type="password" autoComplete="new-password" placeholder={needsCredentials ? '' : '已保存 · 留空保留'} required={needsCredentials} maxLength={512} /></label>
      <label>加密密钥<input name="encryptKey" type="password" autoComplete="new-password" placeholder={needsCredentials ? '' : '已保存 · 留空保留'} required={needsCredentials} maxLength={512} /></label>
      <label>应用密钥 App Secret<input name="appSecret" type="password" autoComplete="new-password" placeholder={target?.hasAppSecret ? '已保存 · 留空保留' : '可选，用于原消息回复'} maxLength={512} /></label>
      {target?.hasAppSecret && <label><span><input name="clearAppSecret" type="checkbox" />关闭原消息回复并移除应用密钥</span></label>}
      <label>允许的用户 Open ID<input name="allowedUsers" defaultValue={target?.allowedUsers.join(', ')} placeholder="ou_xxx，逗号分隔" /></label>
      <label>允许的群聊 ID<input name="allowedChats" defaultValue={target?.allowedChats.join(', ')} placeholder="oc_xxx，逗号分隔" /></label>
    </div>
    <fieldset className="schedule-days"><legend>允许的请求</legend>{Object.entries(intents).map(([intent, label]) => <label key={intent}><input type="checkbox" name="intent" value={intent} defaultChecked={target?.intents.includes(intent) ?? intent === 'status'} />{label}</label>)}</fieldset>
    <div className="schedule-form-footer"><label><input type="checkbox" name="enabled" defaultChecked={target?.enabled ?? false} />启用入站</label><button className="button-primary" type="submit" disabled={busy}><ShieldCheck size={15} />保存入口</button></div>
    <p>回调路径 <code>/api/inbound/{projectId}</code></p>
  </form>
}

function InboxSource({ projectId, busy, onAccept, onClose }: { projectId: string; busy: boolean; onAccept: (id: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<{ id: string; title: string } | null>(null)
  const sources = useWorkbenchHistory(loadTaskHistory, { sources: '1', projectId, q: query.trim() }, undefined)
  return <form className="schedule-editor inbound-source" onSubmit={(event) => { event.preventDefault(); if (selected && !busy) onAccept(selected.id) }}>
    <label>搜索源任务<input value={query} maxLength={400} disabled={busy} onChange={(event) => setQuery(event.target.value)} /></label>
    <label>复用工作流<select value={selected?.id ?? ''} required disabled={busy} onChange={(event) => setSelected(sources.items.find(({ id }) => id === event.target.value) ?? null)}>
      <option value="" disabled>{sources.loading ? '正在加载任务…' : sources.error ? '无法加载源任务' : sources.items.length ? '选择同项目源任务' : '无匹配的源任务'}</option>
      {selected && !sources.items.some(({ id }) => id === selected.id) && <option value={selected.id}>{selected.title}</option>}
      {sources.items.map(({ id, title }) => <option key={id} value={id}>{title}</option>)}
    </select></label>
    {sources.error && <p className="schedule-error" role="alert">{sources.error} <button className="button-secondary" type="button" onClick={sources.hasPrevious ? sources.reset : sources.retry}>{sources.hasPrevious ? '返回首页' : '重试加载'}</button></p>}
    {(sources.hasPrevious || sources.hasNext) && <div className="schedule-actions">
      <button className="icon-button" type="button" title="上一页" aria-label="上一页" disabled={busy || !sources.hasPrevious} onClick={sources.previous}><ChevronLeft size={16} /></button><span>第 {sources.page} 页</span><button className="icon-button" type="button" title="下一页" aria-label="下一页" disabled={busy || !sources.hasNext} onClick={sources.next}><ChevronRight size={16} /></button>
    </div>}
    <div className="schedule-actions"><button className="button-primary" disabled={busy || !selected} type="submit">确认并运行</button><button className="button-secondary" disabled={busy} type="button" onClick={onClose}>取消选择</button></div>
  </form>
}

function InboxDecision({ event, busy, onDecision }: { event: InboundEvent; busy: boolean; onDecision: (decision: 'accept' | 'dismiss', sourceTaskId?: string) => void }) {
  const [choosing, setChoosing] = useState(false)
  if (event.intent === 'create' && choosing) return <InboxSource projectId={event.projectId} busy={busy} onAccept={(id) => onDecision('accept', id)} onClose={() => setChoosing(false)} />
  return <div className="schedule-actions">
    {event.intent === 'create' ? <button className="button-secondary" disabled={busy} onClick={() => setChoosing(true)}>选择源任务</button> : <button className="button-secondary" disabled={busy} onClick={() => onDecision('accept')}>{event.intent === 'approve' ? '标为已阅' : '确认并运行'}</button>}
    <button className="button-secondary" disabled={busy} onClick={() => onDecision('dismiss')}>驳回</button>
  </div>
}

export default function InboundPage({ projects, onToast, onOpenTask }: { projects: WorkflowProject[]; onToast: (text: string) => void; onOpenTask: (id: string) => void }) {
  const [state, setState] = useState<{ projectId: string; data: Awaited<ReturnType<typeof loadInbound>> } | null>(null)
  const [selected, setSelected] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const projectId = projects.some(({ id }) => id === selected) ? selected : projects[0]?.id ?? ''
  const data = state?.projectId === projectId ? state.data : null
  const target = data?.targets.find((item) => item.projectId === projectId)
  useEffect(() => {
    if (!projectId) return
    let active = true
    const update = () => loadInbound(projectId).then((value) => { if (active) { setState({ projectId, data: value }); setError('') } }, () => { if (active) setError('无法读取入站记录。') })
    void update()
    const timer = window.setInterval(update, 3_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [projectId])
  async function change(action: () => Promise<unknown>, message: string) {
    setBusy(true)
    try {
      await action()
      onToast(message)
      void loadInbound(projectId).then((value) => setState({ projectId, data: value }), () => setError('无法刷新入站记录。'))
      return true
    } catch (cause) {
      onToast(cause instanceof Error ? cause.message : '入站操作失败。')
      return false
    } finally { setBusy(false) }
  }
  return <section className="schedule-page">
    <header className="schedule-page-heading"><h1><ArrowDownToLine size={21} />飞书 / Lark 入站</h1><div className="schedule-actions">
      <select aria-label="入站项目" value={projectId} onChange={(event) => setSelected(event.target.value)} disabled={busy || !projects.length}>{!projects.length && <option value="">暂无授权项目</option>}{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
      <button className="icon-button" aria-label="撤销入站配置" disabled={!target || busy} onClick={() => { if (window.confirm('撤销此项目的入站入口？')) void change(() => revokeInbound(projectId), '入站入口已撤销') }}><Trash2 size={16} /></button>
    </div></header>
    {error && <p role="alert" className="schedule-error">{error}</p>}
    {data && !data.enabled && <p>入站服务当前关闭。请使用 HTTPS 并设置 <code>ZHIDIAN_ENABLE_INBOUND=1</code>。</p>}
    {data?.enabled && projectId && <InboundForm key={`${projectId}-${Boolean(target)}`} target={target} projectId={projectId} busy={busy} onSave={(value) => change(() => saveInbound(projectId, value), '入站入口已保存')} />}
    <h2>入站收件箱</h2>
    <div className="schedule-table-wrap"><table className="schedule-table"><thead><tr><th>时间</th><th>请求</th><th>状态</th><th>处理</th></tr></thead><tbody>
      {data?.events.map((event) => <tr key={event.id}>
        <td>{new Date(event.updatedAt).toLocaleString()}<small>{event.userId ?? event.chatId}</small></td>
        <td>{intents[event.intent ?? ''] ?? '请求'}<small>{event.taskId ?? event.threadId}</small>{event.draft && <p style={{ whiteSpace: 'pre-wrap' }}>{[event.draft.title, event.draft.brief, event.draft.message].filter(Boolean).join('\n')}</p>}</td>
        <td>{statuses[event.status] ?? event.status}<small>{event.taskStatus}</small></td>
        <td>{event.status === 'awaiting-owner' && <InboxDecision event={event} busy={busy} onDecision={(decision, sourceTaskId) => { void change(() => decideInbound(event.id, decision, sourceTaskId), '已处理入站请求') }} />}
          {event.status === 'accepted' && event.taskId && event.intent !== 'status' && <button className="button-secondary inbound-task-link" onClick={() => event.taskId && onOpenTask(event.taskId)}><ExternalLink size={14} />查看任务</button>}
        </td>
      </tr>)}
      {!data?.events.length && <tr><td colSpan={4}>{data ? '暂无入站事件' : '尚无可查看的记录'}</td></tr>}
    </tbody></table></div>
  </section>
}
