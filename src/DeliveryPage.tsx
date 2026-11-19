import { useEffect, useState, type FormEvent } from 'react'
import { ChevronRight, Send, ShieldCheck, Trash2, TriangleAlert } from 'lucide-react'
import { loadDelivery, revokeDelivery, saveDelivery, testDelivery, type DeliveryAlert, type DeliveryTarget, type WorkflowProject } from './provider-client'
import './SchedulesPage.css'

const events: Record<string, string> = { approved: '验收通过', failed: '运行失败', 'needs-fix': '验收未通过', cancelled: '运行已取消', test: '测试通知', 'inbound-reply': '入站回复' }
const statuses: Record<string, string> = { pending: '待发送', sending: '发送中', sent: '已送达', failed: '失败', 'retry-wait': '等待重试', unknown: '结果未知', cancelled: '已撤销' }

function TargetForm({ target, projectId, busy, onSave }: { target?: DeliveryTarget; projectId: string; busy: boolean; onSave: (value: Parameters<typeof saveDelivery>[1]) => Promise<boolean> }) {
  const [channel, setChannel] = useState<DeliveryTarget['channel']>(target?.channel ?? 'feishu')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    const webhook = String(data.get('webhook') ?? '').trim()
    const signingSecret = String(data.get('signingSecret') ?? '').trim()
    const accepted = await onSave({ channel, ...(webhook ? { webhook, signingSecret } : signingSecret ? { signingSecret } : {}), events: data.getAll('event').map(String), enabled: data.has('enabled'), ...(location.protocol === 'https:' && { includeTaskLink: data.has('includeTaskLink') }) })
    if (accepted) {
      (form.elements.namedItem('webhook') as HTMLInputElement).value = ''
      ;(form.elements.namedItem('signingSecret') as HTMLInputElement).value = ''
    }
  }

  return <form className="schedule-editor" onSubmit={(event) => { void submit(event) }} aria-label={`项目 ${projectId} 通知设置`} autoComplete="off">
    <div className="schedule-form-grid">
      <label>渠道<select value={channel} onChange={(event) => setChannel(event.target.value as DeliveryTarget['channel'])}><option value="feishu">飞书</option><option value="lark">Lark</option></select></label>
      <label>机器人 Webhook<input name="webhook" type="password" inputMode="url" required={!target || channel !== target.channel} autoComplete="new-password" placeholder={target?.channel === channel ? '已保存 · 留空保留' : 'https://…'} /></label>
      <label>签名密钥<input name="signingSecret" type="password" autoComplete="new-password" placeholder={target?.hasSigningSecret ? '已保存' : '可选'} maxLength={512} /></label>
    </div>
    <fieldset className="schedule-days"><legend>发送事件</legend>{Object.keys(events).filter((event) => event !== 'test' && event !== 'inbound-reply').map((event) => <label key={event}><input type="checkbox" name="event" value={event} defaultChecked={target ? target.events.includes(event) : event !== 'cancelled'} />{events[event]}</label>)}</fieldset>
    <div className="schedule-form-footer"><label><input type="checkbox" name="enabled" defaultChecked={target?.enabled ?? true} />启用通知</label>{location.protocol === 'https:' && <label title={`启用后通知会包含工作台地址 ${location.origin}`}><input type="checkbox" name="includeTaskLink" defaultChecked={target?.includeTaskLink ?? false} />附工作台地址和任务链接</label>}<button className="button-primary" type="submit" disabled={busy}><ShieldCheck size={15} />保存配置</button></div>
  </form>
}

export default function DeliveryPage({ projects, alerts, onToast }: { projects: WorkflowProject[]; alerts: DeliveryAlert[]; onToast: (text: string) => void }) {
  const [selected, setSelected] = useState(() => alerts[0]?.projectId ?? '')
  const [attentionOnly, setAttentionOnly] = useState(() => alerts.length > 0)
  const projectId = selected || projects[0]?.id || ''
  const projectNames = new Map(projects.map(({ id, name }) => [id, name]))

  return <section className="schedule-page">
    <header className="schedule-page-heading"><h1><Send size={21} />结果交付</h1><div className="schedule-actions">
      <select aria-label="通知项目" value={projectId} onChange={(event) => { setSelected(event.target.value); setAttentionOnly(false) }} disabled={!projects.length}>
        {!projects.length && <option value="">暂无授权项目</option>}{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select>
    </div></header>
    {alerts.length > 0 && <section className="delivery-alerts" aria-labelledby="delivery-alert-heading">
      <h2 id="delivery-alert-heading"><TriangleAlert size={16} aria-hidden="true" />投递异常</h2>
      <ul>{alerts.map((item) => <li key={item.projectId}>
        <button type="button" aria-pressed={item.projectId === projectId && attentionOnly} onClick={() => { setSelected(item.projectId); setAttentionOnly(true) }}>
          <strong>{projectNames.get(item.projectId)}</strong>
          {item.failed > 0 && <span>失败 {item.failed}</span>}
          {item.unknown > 0 && <span>结果未知 {item.unknown}</span>}
          <ChevronRight size={15} aria-hidden="true" />
        </button>
      </li>)}</ul>
    </section>}
    {projectId && <DeliveryProject key={projectId} projectId={projectId} attentionOnly={attentionOnly} onAttentionChange={setAttentionOnly} onToast={onToast} />}
  </section>
}

function DeliveryProject({ projectId, attentionOnly, onAttentionChange, onToast }: { projectId: string; attentionOnly: boolean; onAttentionChange: (checked: boolean) => void; onToast: (text: string) => void }) {
  const [state, setState] = useState<Awaited<ReturnType<typeof loadDelivery>> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const target = state?.targets[0]
  const history = state?.deliveries.filter(({ status }) => !attentionOnly || status === 'failed' || status === 'unknown') ?? []
  useEffect(() => {
    const controller = new AbortController()
    let pending = false
    const update = async () => {
      if (pending) return
      pending = true
      try {
        const value = await loadDelivery(projectId, controller.signal)
        if (!controller.signal.aborted) { setState(value); setError('') }
      } catch {
        if (!controller.signal.aborted) setError('无法读取投递记录。')
      } finally { pending = false }
    }
    void update()
    const timer = window.setInterval(() => { void update() }, 2500)
    return () => { controller.abort(); window.clearInterval(timer) }
  }, [projectId, refresh])

  async function change(action: () => Promise<unknown>, message: string) {
    setBusy(true)
    try {
      await action()
      onToast(message)
      setRefresh((value) => value + 1)
      return true
    } catch (cause) {
      onToast(cause instanceof Error ? cause.message : '通知操作失败。')
      return false
    } finally { setBusy(false) }
  }

  return <>
    <div className="schedule-actions">
      <button className="button-secondary" disabled={!target?.enabled || busy} onClick={() => { void change(() => testDelivery(projectId), '测试通知已排队') }}><Send size={15} />测试通知</button>
      <button className="icon-button" aria-label="撤销通知配置" title="撤销通知配置" disabled={!target || busy} onClick={() => { if (window.confirm('撤销此项目的通知配置？已经发出的消息不会撤回。')) void change(() => revokeDelivery(projectId), '通知配置已撤销') }}><Trash2 size={16} /></button>
    </div>
    {error && <p role="alert" className="schedule-error">{error}</p>}
    {state && projectId && <TargetForm key={`${projectId}-${Boolean(target)}`} target={target} projectId={projectId} busy={busy} onSave={(value) => change(() => saveDelivery(projectId, value), '通知配置已保存')} />}
    <div className="delivery-history-heading"><h2>投递记录 <small>最近 100 条</small></h2><label><input type="checkbox" checked={attentionOnly} onChange={(event) => onAttentionChange(event.target.checked)} />只看异常</label></div>
    <div className="schedule-table-wrap"><table className="schedule-table"><thead><tr><th>更新</th><th>事件</th><th>任务</th><th>状态</th><th>尝试</th></tr></thead><tbody>
      {history.map((item) => <tr key={item.id}><td>{new Date(item.updatedAt).toLocaleString()}</td><td>{events[item.event] ?? item.event}</td><td>{item.taskId && /^[A-Za-z0-9-]{1,100}$/.test(item.taskId) ? <a href={`#task=${item.taskId}`}>{item.taskId}</a> : item.taskId ?? '无'}</td><td>{statuses[item.status] ?? item.status}{item.error && <small>{item.error}</small>}{item.retryAt && <small>下次尝试 {new Date(item.retryAt).toLocaleString()}</small>}</td><td>{item.attempts}</td></tr>)}
      {!history.length && <tr><td colSpan={5}>{state ? (attentionOnly ? '暂无投递异常' : '暂无投递记录') : error ? '投递记录不可用' : '正在加载…'}</td></tr>}
    </tbody></table></div>
  </>
}
