import { useCallback, useEffect, useState } from 'react'
import { Activity, Columns2, ExternalLink, FileText, PanelTop, RefreshCw, Square, Terminal, X } from 'lucide-react'
import { cancelWorkflowRun, loadRunDetail, subscribeWorkflowRun, type ExecutorDefinition, type WorkbenchRun, type WorkbenchRunDetail, type WorkflowEvent, type WorkflowProject } from './provider-client'
import { maxHarnessPanes, type useHarnessLayout } from './harness-layout'
import './HarnessWorkspace.css'

const active = (status?: string) => status === 'queued' || status === 'running'
const statusLabels: Record<string, string> = { queued: '排队中', running: '运行中', completed: '已完成', failed: '失败', cancelled: '已取消' }
const phaseLabels: Record<string, string> = { 'ceo-plan': '计划', 'specialist-execute': '执行', 'qa-review': '独立 QA' }

function mergeEvents(stored: WorkflowEvent[], incoming: WorkflowEvent[]) {
  const seen = new Set(stored.map((event) => event.id))
  const missing = incoming.filter((event) => event.id && !seen.has(event.id))
  if (!missing.length) return stored
  return [...stored, ...missing].sort((a, b) => (a.at ?? '').localeCompare(b.at ?? '')).slice(-100)
}

function useRunPane(runId: string) {
  const [detail, setDetail] = useState<WorkbenchRunDetail | null>(null)
  const [events, setEvents] = useState<WorkflowEvent[]>([])
  const [status, setStatus] = useState<string>()
  const [error, setError] = useState('')
  const [offline, setOffline] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const refresh = useCallback(() => setAttempt((value) => value + 1), [])

  useEffect(() => {
    const controller = new AbortController()
    let unsubscribe: (() => void) | undefined
    let loading = false
    let reload = false
    let disconnected = true
    let done = false
    const stop = () => { unsubscribe?.(); unsubscribe = undefined }
    const sync = async () => {
      if (controller.signal.aborted) return
      if (loading) { reload = true; return }
      loading = true
      try {
        const result = await loadRunDetail(runId, controller.signal)
        if (controller.signal.aborted) return
        if (result.run.id !== runId) throw new Error('返回的运行编号不匹配。')
        setDetail(result)
        setEvents((current) => mergeEvents(result.run.events ?? [], current))
        setError('')
        done = !active(result.run.status)
        if (done) {
          setStatus(result.run.status)
          setOffline(false)
          stop()
        } else if (!unsubscribe) {
          setStatus(result.run.status)
          unsubscribe = subscribeWorkflowRun(runId, (event) => {
            if (event.type === 'run.snapshot' ? event.run?.id !== runId : event.runId !== runId || event.run?.id !== runId) return
            disconnected = false
            setOffline(false)
            setStatus(event.run?.status)
            if (event.id) setEvents((current) => mergeEvents(current, [event]))
            if (event.run && !active(event.run.status)) void sync()
          }, () => { disconnected = true; setOffline(true) })
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : '无法加载运行。')
          disconnected = true
        }
      } finally {
        loading = false
        if (reload && !done) { reload = false; void sync() }
      }
    }
    const timer = window.setInterval(() => {
      if (disconnected && !done && document.visibilityState === 'visible') void sync()
    }, 5500)
    void sync()
    return () => { controller.abort(); stop(); window.clearInterval(timer) }
  }, [runId, attempt])

  return { detail, events, status, error, offline, refresh }
}

function compactEvents(events: WorkflowEvent[]) {
  const rows: { event: WorkflowEvent; count: number }[] = []
  for (const event of events) {
    if (!event.message) continue
    const previous = rows.at(-1)
    if (previous?.event.type === event.type && previous.event.message === event.message) previous.count += 1
    else rows.push({ event, count: 1 })
  }
  return rows.reverse()
}

function RunPane({ id, visible, summary, catalog, onClose, onTask }: { id: string; visible: boolean; summary?: WorkbenchRun; catalog: ExecutorDefinition[]; onClose: () => void; onTask: (taskId: string) => void }) {
  const { detail, events, status, error, offline, refresh } = useRunPane(id)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const run = detail?.run
  const executorName = catalog.find((item) => item.id === run?.executor)?.name ?? run?.executor
  const agent = run?.agentName ?? summary?.agentName ?? '运行详情'
  const phase = run?.phase ?? summary?.phase
  const state = status ?? run?.status ?? summary?.status
  const label = state ? statusLabels[state] ?? state : '正在读取'
  const rows = compactEvents(events)
  const files = run?.execution?.writtenFiles ?? []
  const checks = run?.review?.checks ?? []
  const commands = run?.review?.verificationResults ?? run?.execution?.commandResults ?? []
  const taskId = run?.taskId ?? summary?.taskId
  const canOpenCodex = (run?.executor === 'codex-app-server' || run?.executor === 'codex-cli') && window.zhidianDesktop?.openCodexCli

  async function stopRun() {
    if (busy || !active(state) || !window.confirm(`停止「${agent}」的这次运行？已经写入的文件不会自动回滚。`)) return
    setBusy(true)
    setNotice('')
    try {
      const result = await cancelWorkflowRun(id)
      setNotice(result.cancelled ? '已取消排队。' : '已请求停止，等待执行器退出。')
      refresh()
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : '停止请求失败。')
    } finally { setBusy(false) }
  }

  return <article className={`harness-pane${visible ? ' is-focused' : ''}`} aria-label={`${agent}运行窗格`} data-run-id={id}>
    <header className="harness-pane-header">
      <span className="harness-pane-mark"><Terminal size={16} /></span>
      <div className="harness-pane-heading"><h2>{agent}</h2><small>{detail?.project?.name ?? '项目'} · {phase ? phaseLabels[phase] ?? phase : '运行详情'}</small></div>
      <span className={`harness-run-state state-${state ?? 'loading'}`}><i />{label}</span>
      <button className="harness-icon-button" title="关闭窗格" aria-label={`关闭${agent}窗格`} onClick={onClose}><X size={16} /></button>
    </header>
    <div className="harness-pane-body">
      <div className="harness-pane-task">{run?.taskTitle ?? summary?.taskTitle ?? id}</div>
      {run && <dl className="harness-run-meta">
        <div><dt>Harness</dt><dd>{executorName ?? '未知'}{run.model && ` / ${run.model}`}</dd></div>
        <div><dt>运行</dt><dd><code>{run.id}</code></dd></div>
        {run.harnessThreadId && <div><dt>线程</dt><dd><code>{run.harnessThreadId}</code></dd></div>}
        {run.harnessTurnId && <div><dt>回合</dt><dd><code>{run.harnessTurnId}</code></dd></div>}
      </dl>}
      {error && <p className="harness-pane-error" role="alert">{error}</p>}
      {run?.error && <p className="harness-pane-error">{run.error}</p>}
      {offline && active(state) && <p className="harness-pane-offline" role="status">正在重新连接事件流</p>}
      <section className="harness-pane-events" aria-label="运行事件"><h3><Activity size={14} />运行事件</h3>
        {rows.length ? <ol>{rows.map(({ event, count }) => <li key={event.id}><time>{event.at ? new Date(event.at).toLocaleTimeString() : '—'}</time><span>{event.message}</span>{count > 1 && <small>×{count}</small>}</li>)}</ol> : <p>{run ? '暂无事件' : error ? '未加载' : '正在读取运行记录…'}</p>}
      </section>
      {files.length > 0 && <section className="harness-pane-results"><h3><FileText size={14} />变更文件 · {files.length}</h3><ul>{files.map((file) => <li key={file}><code>{file}</code></li>)}</ul></section>}
      {run?.review && <section className="harness-pane-results"><h3>独立 QA · {run.review.status === 'passed' ? '通过' : '未通过'}</h3><p>{run.review.summary}</p><ul>{checks.map((check, index) => <li key={index}>{check.passed ? '通过' : '未通过'} · {check.name}{check.evidence && <small>{check.evidence}</small>}</li>)}</ul></section>}
      {commands.length > 0 && <div className="harness-pane-commands">{commands.map((command, index) => <details key={index}><summary>{command.command} · {command.timedOut ? '超时' : command.exitCode === null ? '未执行' : `退出 ${command.exitCode}`}</summary><pre>{[command.stdout, command.stderr].filter(Boolean).join('\n') || '无输出'}</pre></details>)}</div>}
      {run?.output && <details className="harness-pane-output"><summary>最终输出</summary><pre>{run.output}</pre></details>}
    </div>
    {notice && <p className="harness-action-notice" role="status">{notice}</p>}
    <footer className="harness-pane-actions">
      {active(state) && <button type="button" onClick={() => void stopRun()} disabled={busy}><Square size={13} />停止</button>}
      {taskId && <button type="button" onClick={() => onTask(taskId)}><FileText size={13} />{state === 'failed' ? '查看任务与重试' : '任务详情'}</button>}
      {canOpenCodex && <button type="button" title="打开新的 Codex 终端" onClick={() => { void canOpenCodex().catch(() => setNotice('无法打开本机 Codex 终端。')) }}><ExternalLink size={13} />打开 Codex</button>}
      <button type="button" className="harness-icon-button" onClick={refresh} aria-label={`刷新${agent}运行`} title="刷新运行记录"><RefreshCw size={14} /></button>
    </footer>
  </article>
}

export default function HarnessWorkspace({ view, runs, projects, catalog, onTask }: { view: ReturnType<typeof useHarnessLayout>; runs: WorkbenchRun[]; projects: WorkflowProject[]; catalog: ExecutorDefinition[]; onTask: (taskId: string) => void }) {
  const [projectId, setProjectId] = useState('')
  const { ids, focused, mode } = view.layout
  const available = projectId ? runs.filter((run) => run.projectId === projectId) : runs
  const byId = new Map(runs.map((run) => [run.id, run]))
  return <div className="harness-workspace">
    <header className="harness-workspace-header"><div><div className="eyebrow"><span className="eyebrow-dot" />LOCAL RUN MONITOR</div><h1>Harness 分屏</h1></div><div className="harness-layout-control" role="group" aria-label="窗格布局">
      <button title="单窗格" aria-label="单窗格" aria-pressed={mode === 'focus'} onClick={() => view.setMode('focus')}><PanelTop size={17} /></button>
      <button title="并排布局" aria-label="并排布局" aria-pressed={mode === 'split'} onClick={() => view.setMode('split')}><Columns2 size={17} /></button>
    </div></header>
    <div className="harness-workspace-toolbar">
      <label><span>项目</span><select aria-label="项目" value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">所有项目</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      <label><span>打开运行</span><select aria-label="打开运行" value="" onChange={(event) => { if (event.target.value) view.open(event.target.value) }}><option value="" disabled>{available.length ? '选择最近运行' : '暂无运行'}</option>{available.map((run) => <option key={run.id} value={run.id} disabled={ids.length >= maxHarnessPanes && !ids.includes(run.id)}>{run.agentName} · {run.taskTitle} · {statusLabels[run.status] ?? run.status}</option>)}</select></label>
      <span className="harness-workspace-count">{ids.length} / {maxHarnessPanes} 窗格</span>
    </div>
    {ids.length > 0 && <div className="harness-focus-row" role="group" aria-label="已打开窗格">{ids.map((id, index) => <button type="button" key={id} aria-pressed={focused === id} onClick={() => view.open(id)} title={byId.get(id)?.taskTitle ?? id}><Terminal size={13} /><span>{index + 1} · {byId.get(id)?.agentName ?? '运行'}</span></button>)}</div>}
    {!ids.length && <div className="harness-workspace-empty"><Terminal size={24} /><strong>未打开运行</strong></div>}
    <div className={`harness-pane-grid mode-${mode} ${ids.length === 1 ? 'is-single' : ''}`}>
      {ids.map((id) => <RunPane key={id} id={id} visible={focused === id} summary={byId.get(id)} catalog={catalog} onClose={() => view.close(id)} onTask={onTask} />)}
    </div>
  </div>
}
