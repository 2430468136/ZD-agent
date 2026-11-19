import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ChevronLeft, ChevronRight, Clock3, Pause, Pencil, Play, Plus, Square, Trash2, X } from 'lucide-react'
import { cancelScheduleOccurrence, deleteSchedule, loadSchedules, loadTaskHistory, runScheduleNow, saveSchedule, type ScheduleInput, type WorkSchedule } from './provider-client'
import { useWorkbenchHistory } from './workbench-history'
import './SchedulesPage.css'

const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
const states: Record<string, string> = { pending: '排队', running: '运行中', 'retry-wait': '等待重试', 'awaiting-approval': '待确认交付', completed: '已完成', failed: '失败', skipped: '已跳过', cancelled: '已取消' }
const formatDate = (value?: string | null) => value ? new Date(value).toLocaleString() : '无'
const activeStatuses = ['pending', 'running', 'retry-wait']
const formatRecurrence = (value: ScheduleInput['recurrence']) => value.kind === 'once' ? `一次 · ${formatDate(value.runAt)}` : `${value.kind === 'daily' ? '每天' : `每周 ${(value.days ?? []).map((day) => '日一二三四五六'[day]).join('、')}`} · ${value.time} ${value.timezone}`

function localInput(value: string) {
  const date = new Date(value)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

function ScheduleForm({ existing, busy, onClose, onSave }: { existing?: WorkSchedule; busy: boolean; onClose: () => void; onSave: (input: Partial<ScheduleInput>) => void }) {
  const recurrence = existing?.recurrence
  const [query, setQuery] = useState('')
  const sources = useWorkbenchHistory(loadTaskHistory, { sources: '1', q: query.trim(), ...(existing && { projectId: existing.projectId }) }, undefined)
  const [selected, setSelected] = useState(() => existing ? { id: existing.sourceTaskId, title: existing.sourceTaskTitle ?? existing.title } : null)
  const [kind, setKind] = useState<ScheduleInput['recurrence']['kind']>(recurrence?.kind ?? 'daily')
  const [initialOnce] = useState(() => recurrence?.kind === 'once' ? localInput(recurrence.runAt) : localInput(new Date(Date.now() + 3_600_000).toISOString()))
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const value = (name: string) => String(data.get(name) ?? '')
    if (!selected) return
    const enteredOnce = value('runAt')
    onSave({
      sourceTaskId: selected.id,
      title: value('title').trim() || undefined,
      brief: value('brief').trim() || undefined,
      enabled: data.has('enabled'),
      recurrence: kind === 'once' ? { kind, runAt: recurrence?.kind === 'once' && localInput(recurrence.runAt) === enteredOnce ? recurrence.runAt : new Date(enteredOnce).toISOString() } : { kind, time: value('time'), timezone: value('timezone'), ...(kind === 'weekly' ? { days: data.getAll('day').map(Number) } : {}) },
      misfire: value('misfire') === 'run-once' ? 'run-once' : 'skip',
      maxRetries: Number(value('maxRetries')),
      timeoutMs: Number(value('timeoutSeconds')) * 1000,
    })
  }
  return <form className="schedule-editor" onSubmit={submit}>
    <div className="schedule-page-heading"><h2>{existing ? '编辑计划' : '新建计划'}</h2><button className="icon-button" type="button" title="关闭编辑" aria-label="关闭编辑" onClick={onClose}><X size={17} /></button></div>
    <label>搜索源任务<input value={query} maxLength={400} onChange={(event) => setQuery(event.target.value)} /></label>
    <label>复用工作流<select name="sourceTaskId" required value={selected?.id ?? ''} onChange={(event) => setSelected(sources.items.find((task) => task.id === event.target.value) ?? null)}><option value="" disabled>{sources.loading ? '正在加载任务…' : '选择任务'}</option>{selected && !sources.items.some((task) => task.id === selected.id) && <option value={selected.id}>{selected.title}</option>}{sources.items.map((task) => <option value={task.id} key={task.id}>{task.title}</option>)}</select></label>
    {sources.error && <p className="schedule-error" role="alert">{sources.error} <button className="button-secondary" type="button" onClick={sources.hasPrevious ? sources.reset : sources.retry}>{sources.hasPrevious ? '返回首页' : '重试加载'}</button></p>}
    {(sources.hasPrevious || sources.hasNext) && <div className="schedule-actions"><button className="icon-button" type="button" title="上一页" aria-label="上一页" disabled={!sources.hasPrevious} onClick={sources.previous}><ChevronLeft size={16} /></button><span>第 {sources.page} 页</span><button className="icon-button" type="button" title="下一页" aria-label="下一页" disabled={!sources.hasNext} onClick={sources.next}><ChevronRight size={16} /></button></div>}
    <label>计划名称<input name="title" maxLength={200} defaultValue={existing?.title} placeholder="默认沿用任务标题" /></label>
    <label>任务要求<textarea name="brief" rows={3} maxLength={12000} defaultValue={existing?.brief} placeholder="默认沿用任务要求" /></label>
    <div className="schedule-form-grid">
      <label>频率<select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}><option value="once">一次</option><option value="daily">每天</option><option value="weekly">每周</option></select></label>
      {kind === 'once' ? <label>触发时间（{zone}）<input type="datetime-local" name="runAt" required defaultValue={initialOnce} /></label> : <>
        <label>触发时间<input type="time" name="time" defaultValue={recurrence && recurrence.kind !== 'once' ? recurrence.time : '09:00'} required /></label>
        <label>IANA 时区<input name="timezone" required defaultValue={recurrence && recurrence.kind !== 'once' ? recurrence.timezone : zone} /></label>
      </>}
      <label>漏跑策略<select name="misfire" defaultValue={existing?.misfire ?? 'skip'}><option value="skip">跳过漏跑</option><option value="run-once">补跑一次</option></select></label>
      <label>规划超时重试次数<input name="maxRetries" type="number" min={0} max={3} defaultValue={existing?.maxRetries ?? 0} required /></label>
      <label>每阶段超时（秒）<input name="timeoutSeconds" type="number" min={1} max={900} defaultValue={(existing?.timeoutMs ?? 120000) / 1000} required /></label>
    </div>
    {kind === 'weekly' && <fieldset className="schedule-days"><legend>星期</legend>{[1, 2, 3, 4, 5, 6, 0].map((day) => <label key={day}><input type="checkbox" name="day" value={day} defaultChecked={recurrence?.kind === 'weekly' ? recurrence.days?.includes(day) : day === 1} />周{'日一二三四五六'[day]}</label>)}</fieldset>}
    <div className="schedule-form-footer"><label><input type="checkbox" name="enabled" defaultChecked={existing?.enabled ?? true} />启用计划</label><button className="button-primary" type="submit" disabled={busy}>{busy ? '保存中…' : '保存计划'}</button></div>
  </form>
}

export default function SchedulesPage({ hasScheduleSources, onToast, onOpenTask }: { hasScheduleSources: boolean; onToast: (text: string) => void; onOpenTask: (id: string) => void }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof loadSchedules>> | null>(null)
  const [editing, setEditing] = useState<WorkSchedule | 'new' | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const requestIds = useRef(new Map<string, string>())
  useEffect(() => {
    let current = true
    const refresh = () => loadSchedules().then((result) => { if (current) { setData(result); setError('') } }).catch((cause: Error) => { if (current) setError(cause.message) })
    void refresh()
    const timer = window.setInterval(refresh, 2500)
    return () => { current = false; window.clearInterval(timer) }
  }, [])

  async function change(action: () => Promise<unknown>, success: string) {
    setBusy(true)
    try {
      await action()
      onToast(success)
      setData(await loadSchedules())
    } catch (cause) {
      onToast(cause instanceof Error ? cause.message : '定时计划操作失败。')
    } finally {
      setBusy(false)
    }
  }

  function runNow(id: string) {
    const requestId = requestIds.current.get(id) ?? crypto.randomUUID()
    requestIds.current.set(id, requestId)
    void change(async () => { await runScheduleNow(id, requestId); requestIds.current.delete(id) }, '已触发计划')
  }

  return <section className="schedule-page">
    <header className="schedule-page-heading"><h1><Clock3 size={22} />定时任务</h1><button className="button-primary" disabled={!hasScheduleSources || busy} onClick={() => setEditing('new')}><Plus size={16} />新建计划</button></header>
    {error && <p className="schedule-error" role="alert">{error}</p>}
    {editing && <ScheduleForm key={editing === 'new' ? 'new' : editing.id} existing={editing === 'new' ? undefined : editing} busy={busy} onClose={() => setEditing(null)} onSave={(input) => { void change(async () => { await saveSchedule(input, editing === 'new' ? undefined : editing.id); setEditing(null) }, '定时计划已保存') }} />}
    <div className="schedule-table-wrap"><table className="schedule-table"><thead><tr><th>计划 / 项目</th><th>频率</th><th>下次触发</th><th>状态</th><th>操作</th></tr></thead><tbody>
      {data?.schedules.map((schedule) => {
        const active = data.occurrences.some((item) => item.scheduleId === schedule.id && activeStatuses.includes(item.status))
        return <tr key={schedule.id}><td><strong>{schedule.title}</strong><small>{schedule.projectName} · {schedule.agentNames.join(' → ')}</small></td><td>{formatRecurrence(schedule.recurrence)}</td><td>{formatDate(schedule.nextRunAt)}</td><td>{schedule.requiresAuthorization ? '需要重新确认权限' : active ? '有活动触发' : schedule.enabled ? '已启用' : '已停用'}</td><td><div className="schedule-actions">
          <button className="icon-button" title="立即运行" aria-label={`立即运行 ${schedule.title}`} disabled={busy || active || schedule.requiresAuthorization} onClick={() => runNow(schedule.id)}><Play size={16} /></button>
          <button className="icon-button" title={schedule.enabled ? '停用' : '启用'} aria-label={`${schedule.enabled ? '停用' : '启用'} ${schedule.title}`} disabled={busy || active || schedule.requiresAuthorization} onClick={() => { void change(() => saveSchedule({ enabled: !schedule.enabled }, schedule.id), schedule.enabled ? '计划已停用' : '计划已启用') }}>{schedule.enabled ? <Pause size={16} /> : <Clock3 size={16} />}</button>
          <button className="icon-button" title="编辑" aria-label={`编辑 ${schedule.title}`} disabled={busy || active} onClick={() => setEditing(schedule)}><Pencil size={16} /></button>
          <button className="icon-button" title="删除" aria-label={`删除 ${schedule.title}`} disabled={busy || active} onClick={() => { if (window.confirm(`删除计划「${schedule.title}」？历史记录会保留。`)) void change(() => deleteSchedule(schedule.id), '计划已删除') }}><Trash2 size={16} /></button>
        </div></td></tr>
      })}
      {!data?.schedules.length && <tr><td colSpan={5}>{data ? hasScheduleSources ? '暂无定时计划' : '暂无可复用的工作流任务' : error ? '定时计划未加载' : '正在加载…'}</td></tr>}
    </tbody></table></div>
    <h2>最近触发</h2>
    <div className="schedule-table-wrap"><table className="schedule-table"><thead><tr><th>计划</th><th>触发时间</th><th>状态</th><th>运行</th></tr></thead><tbody>
      {data?.occurrences.map((item) => <tr key={item.id}><td>{data.schedules.find((candidate) => candidate.id === item.scheduleId)?.title ?? '已删除计划'}</td><td>{formatDate(item.scheduledFor)}</td><td>{states[item.status] ?? item.status}{item.error && <small>{item.error}</small>}{item.status === 'retry-wait' && <small>重试时间：{formatDate(item.retryAt)}</small>}</td><td><div className="schedule-actions">{item.taskIds.map((id, index) => <button key={id} className="button-secondary" onClick={() => onOpenTask(id)}>查看第 {index + 1} 次运行</button>)}{activeStatuses.includes(item.status) && <button className="icon-button" title="取消触发" aria-label="取消触发" disabled={busy} onClick={() => { void change(() => cancelScheduleOccurrence(item.id), '已请求取消') }}><Square size={15} /></button>}</div></td></tr>)}
      {!data?.occurrences.length && <tr><td colSpan={4}>暂无触发记录</td></tr>}
    </tbody></table></div>
  </section>
}
