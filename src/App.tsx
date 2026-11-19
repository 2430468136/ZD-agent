import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Bell,
  BookOpen,
  Bot,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Clock3,
  Command,
  Cpu,
  FileText,
  GitBranch,
  LayoutDashboard,
  ListChecks,
  Library,
  LogOut,
  Menu,
  MessagesSquare,
  MoreHorizontal,
  Pause,
  Plus,
  Play,
  Radio,
  ScanLine,
  Search,
  Send,
  ArrowDownToLine,
  Settings2,
  ShieldCheck,
  Sparkles,
  Terminal,
  UsersRound,
  Workflow,
  X,
} from 'lucide-react'
import {
  loadWorkbench,
  loadTaskHistory,
  loadThreadHistory,
  loadTaskDetail,
  loadThreadDetail,
  followupThread,
  loadExecutorCatalog,
  cancelWorkflowRun,
  decideWorkflowDelivery,
  registerProject,
  startWorkflow,
  retryWorkflowPhase,
  subscribeWorkflowRun,
  type ProjectAccessMode,
  type WorkflowAgentConfig,
  type ExecutorDefinition,
  type DeliveryDecision,
  type WorkbenchSnapshot,
  type WorkbenchTask,
  type WorkbenchTaskDetail,
  type WorkflowTask,
  type WorkflowThreadDetail,
} from './provider-client'
import type { ProviderId } from './provider-client'
import { useWorkbenchHistory } from './workbench-history'
import HarnessSettings from './HarnessSettings'
import HarnessWorkspace from './HarnessWorkspace'
import { maxHarnessPanes, useHarnessLayout } from './harness-layout'
import ContextLibrary from './ContextLibrary'
import SchedulesPage from './SchedulesPage'
import DeliveryPage from './DeliveryPage'
import InboundPage from './InboundPage'
import { ProjectMembers } from './ProjectMembers'
import AgentFigure from './AgentFigure'
import { defaultSkillIds, getSkills, skillCatalog, type SkillProfile } from './skill-data'
import './App.css'

type Stage = 'research' | 'writing' | 'review' | 'approved'
type Page = 'overview' | 'harness' | 'tasks' | 'threads' | 'schedules' | 'delivery' | 'inbound' | 'team' | 'skills' | 'context' | 'runs' | 'settings' | 'members'
type ModelProvider = ProviderId

type AgentProfile = {
  id: string
  name: string
  role: string
  initial: string
  tone: string
  provider: ModelProvider
  model: string
  skillIds: string[]
  executor?: string
  status: string
  online: boolean
}

type Task = {
  id: string
  title: string
  brief: string
  stage: Stage
  owner: string
  ownerInitial: string
  channel: string
  kind: string
  updated: string
  due: string
  progress: number
  sources: number
  workflowTaskId?: string
  workflowStatus?: string
  projectPath?: string
}

type RunLog = {
  id: string
  taskTitle: string
  agent: string
  action: string
  time: string
}

type OfficeHandoff = {
  id: string
  sourceAgentId: string
  sourceAgentName: string
  targetAgentId: string
  targetAgentName: string
}

const taskKey = 'zhidian-demo-tasks-v2'
const logKey = 'zhidian-demo-runs-v2'
const agentKey = 'zhidian-demo-agents-v1'

const seedTasks: Task[] = [
  {
    id: 'T-204',
    title: '搭建 Agent 作战大屏与团队配置页',
    brief: '把 CEO 调度、前端与后端执行、测试验收串成一条可观察的本地工作流。为每位 Agent 配置独立模型路由。',
    stage: 'review',
    owner: '测试 Agent',
    ownerInitial: '测',
    channel: '内部项目',
    kind: '界面交付',
    updated: '2 分钟前',
    due: '今天 16:00',
    progress: 92,
    sources: 4,
  },
  {
    id: 'T-203',
    title: '为任务中心增加模型路由配置 API',
    brief: '为 Agent 配置建立持久化接口，校验 provider 与 model 字段，并避免将密钥写入客户端。',
    stage: 'writing',
    owner: '后端 Agent',
    ownerInitial: '后',
    channel: 'API',
    kind: '后端开发',
    updated: '6 分钟前',
    due: '今天 17:30',
    progress: 64,
    sources: 2,
  },
  {
    id: 'T-202',
    title: '实现员工卡片与任务流向交互',
    brief: '在作战大屏中展示各角色当前状态，点击 Agent 节点可跳转到模型路由设置。',
    stage: 'research',
    owner: '前端 Agent',
    ownerInitial: '前',
    channel: 'Web UI',
    kind: '前端开发',
    updated: '11 分钟前',
    due: '今天 18:00',
    progress: 28,
    sources: 1,
  },
  {
    id: 'T-201',
    title: '规划团队职责与任务验收规则',
    brief: '由 CEO Agent 拆解目标，明确前端、后端、研究和测试角色的边界及交接条件。',
    stage: 'approved',
    owner: 'CEO Agent',
    ownerInitial: 'CEO',
    channel: '内部项目',
    kind: '任务规划',
    updated: '今天 09:42',
    due: '已完成',
    progress: 100,
    sources: 0,
  },
]

const seedRuns: RunLog[] = [
  { id: 'r-1', taskTitle: seedTasks[0].title, agent: '测试 Agent', action: '完成验收，等待负责人确认', time: '2 分钟前' },
  { id: 'r-2', taskTitle: seedTasks[1].title, agent: '后端 Agent', action: '提交 API 草案并关联前端任务', time: '6 分钟前' },
  { id: 'r-3', taskTitle: seedTasks[2].title, agent: '前端 Agent', action: '开始实现员工状态卡', time: '11 分钟前' },
  { id: 'r-4', taskTitle: seedTasks[3].title, agent: 'CEO Agent', action: '拆解目标并派发 3 个子任务', time: '今天 09:42' },
]

const stageMeta: Record<Stage, { label: string; short: string; color: string }> = {
  research: { label: '待拆解', short: '规划', color: 'mint' },
  writing: { label: '执行中', short: '执行', color: 'blue' },
  review: { label: '待验收', short: '验收', color: 'coral' },
  approved: { label: '已交付', short: '交付', color: 'green' },
}

const stageOrder: Stage[] = ['research', 'writing', 'review', 'approved']

const seedAgents: AgentProfile[] = [
  { id: 'ceo', name: 'CEO Agent', role: '目标拆解 · 任务调度', initial: 'CEO', tone: 'agent-yellow', provider: 'OpenAI', model: 'gpt', skillIds: defaultSkillIds.ceo, status: '统筹中', online: true },
  { id: 'frontend', name: '前端 Agent', role: 'React · UI · 浏览器交互', initial: '前', tone: 'agent-blue', provider: 'DeepSeek', model: 'deepseek-flash', skillIds: defaultSkillIds.frontend, status: '执行中', online: true },
  { id: 'backend', name: '后端 Agent', role: 'API · 数据库 · 服务逻辑', initial: '后', tone: 'agent-lilac', provider: 'OpenAI', model: 'gpt', skillIds: defaultSkillIds.backend, status: '执行中', online: true },
  { id: 'qa', name: '测试 Agent', role: '测试用例 · 验收 · 回归', initial: '测', tone: 'agent-coral', provider: 'Anthropic', model: 'claude', skillIds: defaultSkillIds.qa, status: '待验收', online: true },
  { id: 'research', name: '研究 Agent', role: '资料检索 · 方案比较', initial: '研', tone: 'agent-cyan', provider: 'DeepSeek', model: 'deepseek-flash', skillIds: defaultSkillIds.research, status: '空闲', online: true },
  { id: 'design', name: '设计 Agent', role: '交互结构 · 视觉规范', initial: '设', tone: 'agent-pink', provider: 'Anthropic', model: 'claude', skillIds: defaultSkillIds.design, status: '空闲', online: true },
  { id: 'ops', name: '运营 Agent', role: '发布 · 监控 · 复盘', initial: '运', tone: 'agent-green', provider: 'OpenAI Compatible', model: 'model-id', skillIds: defaultSkillIds.ops, status: '离线', online: false },
]

function readStorage<T,>(key: string, fallback: T): T {
  try {
    const saved = window.localStorage.getItem(key)
    return saved ? (JSON.parse(saved) as T) : fallback
  } catch {
    return fallback
  }
}

function readAgents() {
  const saved = readStorage<AgentProfile[]>(agentKey, seedAgents)
  return saved.map((agent) => ({ ...agent, skillIds: agent.skillIds ?? defaultSkillIds[agent.id] ?? [] }))
}

function timeLabel() {
  return new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date())
}

function toWorkbenchTask(remote: WorkbenchTask): Task {
  const status = remote.status
  const stage = status === 'approved' ? 'approved' : ['reviewing', 'executed', 'awaiting-approval'].includes(status) ? 'review' : ['executing', 'needs-fix', 'failed', 'planned'].includes(status) ? 'writing' : 'research'
  const owners = { approved: ['林同学', '林'], review: ['测试 Agent', '测'], writing: ['专业 Agent', '专'], research: ['CEO Agent', 'CEO'] }
  const [owner, ownerInitial] = owners[status === 'awaiting-approval' ? 'approved' : stage]
  const progress = stage === 'approved' ? 100 : stage === 'review' ? 88 : status === 'executing' ? 62 : status === 'planned' ? 36 : stage === 'writing' ? 48 : 16
  return { id: `restored-${remote.id}`, workflowTaskId: remote.id, workflowStatus: status, projectPath: remote.projectPath, title: remote.title, brief: remote.brief, stage, owner, ownerInitial, channel: '本地 Agent 工作流', kind: remote.executionMode, updated: new Date(remote.updatedAt).toLocaleString(), due: '—', progress, sources: remote.filesWritten }
}

const taskStatusLabel = (task: Task) => {
  if (task.workflowStatus === 'awaiting-approval') return '待确认交付'
  if (task.workflowStatus === 'reviewing') return '测试 Agent 验收中'
  if (task.workflowStatus === 'executed') return '待独立验收'
  if (task.workflowStatus === 'needs-fix') return '待修改'
  return stageMeta[task.stage].label
}

function App({ onLogout, linkedTaskId, onCloseTaskLink }: { onLogout?: () => void; linkedTaskId: string | null; onCloseTaskLink: () => void }) {
  const [demoTasks, setTasks] = useState<Task[]>(() => onLogout ? seedTasks : readStorage(taskKey, seedTasks).filter((task) => !task.workflowTaskId))
  const [runs, setRuns] = useState<RunLog[]>(() => onLogout ? seedRuns : readStorage(logKey, seedRuns))
  const [agents, setAgents] = useState<AgentProfile[]>(readAgents)
  const [workflow, setWorkflow] = useState<WorkbenchSnapshot | null>(null)
  const deliveryAlerts = workflow?.deliveryAlerts ?? []
  const deliveryAlertCount = deliveryAlerts.reduce((total, item) => total + item.failed + item.unknown, 0)
  const [workflowTag, setWorkflowTag] = useState<string>()
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null)
  const [threadDetail, setThreadDetail] = useState<WorkflowThreadDetail | null>(null)
  const [executorCatalog, setExecutorCatalog] = useState<ExecutorDefinition[]>([])
  const [officeHandoff, setOfficeHandoff] = useState<OfficeHandoff | null>(null)
  const harnessView = useHarnessLayout()
  const harnessRuns = useMemo(() => [...new Map([...(workflow?.recentRuns ?? []), ...(workflow?.activeRuns ?? [])].map((run) => [run.id, run])).values()], [workflow])
  const officeRuns = useMemo(() => {
    const latest = new Map<string, string>()
    // Open the handoff immediately if the workbench summary has not caught up.
    if (officeHandoff && !harnessRuns.some((run) => run.id === officeHandoff.id)) latest.set(officeHandoff.targetAgentId, officeHandoff.id)
    for (const run of [...(workflow?.activeRuns ?? [])].reverse().concat(harnessRuns)) {
      if (run.agentId && !latest.has(run.agentId)) latest.set(run.agentId, run.id)
    }
    return latest
  }, [workflow, harnessRuns, officeHandoff])
  const [page, setPage] = useState<Page>('overview')
  const pageRef = useRef(page)
  pageRef.current = page
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [taskDetail, setTaskDetail] = useState<WorkbenchTaskDetail | null>(null)
  const [taskDetailError, setTaskDetailError] = useState<{ id: string; message: string } | null>(null)
  const [detailAttempt, setDetailAttempt] = useState(0)
  const [createOpen, setCreateOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | Stage>('all')
  const [toast, setToast] = useState('')
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [dispatchPaused, setDispatchPaused] = useState(false)
  const [workflowBusy, setWorkflowBusy] = useState(false)
  const subscriptions = useRef(new Map<string, () => void>())
  const runEventIds = useRef(new Map<string, Set<string>>())
  const terminalRuns = useRef(new Set<string>())
  const refreshWorkflow = useRef<() => void>(() => undefined)
  const watchRunRef = useRef<(runId: string) => void>(() => undefined)
  const tasks = useMemo(() => [...(workflow?.tasks ?? []).map(toWorkbenchTask), ...demoTasks], [demoTasks, workflow])
  const selectedRemoteId = linkedTaskId ?? (selectedTaskId?.startsWith('restored-') ? selectedTaskId.slice('restored-'.length) : null)
  const selectedDetail = selectedRemoteId && taskDetail?.task.id === selectedRemoteId ? taskDetail : null
  const selectedTask = selectedRemoteId ? (selectedDetail ? toWorkbenchTask({ ...selectedDetail.summary, brief: selectedDetail.task.brief }) : null) : demoTasks.find((task) => task.id === selectedTaskId) ?? null
  const reviewTasks = (workflow?.approvalQueue?.preview ?? []).map(toWorkbenchTask)
  const approvalCount = workflow?.approvalQueue?.count ?? 0
  const filteredDemoTasks = useMemo(() => {
    const query = search.trim().toLowerCase()
    return demoTasks.filter((task) => {
      const matchesStage = filter === 'all' || task.stage === filter
      const matchesQuery = !query || `${task.title} ${task.brief} ${task.channel} ${task.owner}`.toLowerCase().includes(query)
      return matchesStage && matchesQuery
    })
  }, [filter, search, demoTasks])

  useEffect(() => { if (!onLogout) window.localStorage.setItem(taskKey, JSON.stringify(demoTasks)) }, [demoTasks, onLogout])
  useEffect(() => { if (!onLogout) window.localStorage.setItem(logKey, JSON.stringify(runs)) }, [runs, onLogout])
  useEffect(() => window.localStorage.setItem(agentKey, JSON.stringify(agents)), [agents])
  useEffect(() => {
    let disposed = false
    let refreshing = false
    let refreshAgain = false
    let tag: string | undefined
    let queuedRefresh: number | undefined
    loadExecutorCatalog().then((catalog) => { if (!disposed) setExecutorCatalog(catalog) }).catch(() => undefined)
    function syncWorkflow() {
      if (disposed) return
      if (refreshing) { refreshAgain = true; return }
      refreshing = true
      void loadWorkbench(tag).then(({ etag, snapshot }) => {
        if (disposed || !snapshot) return
        tag = etag
        setWorkflowTag(etag)
        setWorkflow(snapshot)
        setSelectedThreadId((current) => current ?? snapshot.latestThreadId)
        snapshot.activeRuns.forEach((run) => watchRunRef.current(run.id))
      }).catch(() => undefined).finally(() => {
        refreshing = false
        if (refreshAgain) { refreshAgain = false; refreshWorkflow.current() }
      })
    }
    refreshWorkflow.current = () => {
      if (disposed || queuedRefresh !== undefined) return
      queuedRefresh = window.setTimeout(() => { queuedRefresh = undefined; syncWorkflow() }, 300)
    }
    const refreshVisible = () => { if (document.visibilityState === 'visible') refreshWorkflow.current() }
    syncWorkflow()
    const timer = window.setInterval(refreshVisible, 5000)
    document.addEventListener('visibilitychange', refreshVisible)
    return () => {
      disposed = true
      window.clearTimeout(queuedRefresh)
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refreshVisible)
    }
  }, [])
  useEffect(() => {
    if (page !== 'threads' || !selectedThreadId) return
    let disposed = false
    loadThreadDetail(selectedThreadId).then((detail) => { if (!disposed) setThreadDetail(detail) }).catch((error) => {
      if (!disposed) setToast(error instanceof Error ? error.message : '无法加载工作线程')
    })
    return () => { disposed = true }
  }, [page, selectedThreadId, workflowTag])
  useEffect(() => {
    if (!selectedRemoteId) return
    const abort = new AbortController()
    void loadTaskDetail(selectedRemoteId, abort.signal).then((detail) => {
      if (!abort.signal.aborted) { setTaskDetail(detail); setTaskDetailError(null) }
    }).catch((cause: Error) => {
      if (!abort.signal.aborted) setTaskDetailError({ id: selectedRemoteId, message: cause.message })
    })
    return () => abort.abort()
  }, [selectedRemoteId, workflowTag, detailAttempt])
  useEffect(() => () => {
    subscriptions.current.forEach((unsubscribe) => unsubscribe())
    subscriptions.current.clear()
    runEventIds.current.clear()
  }, [])
  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 3000)
    return () => window.clearTimeout(timer)
  }, [toast])

  function addRun(task: Task, agent: string, action: string) {
    setRuns((current) => [{ id: `r-${Date.now()}`, taskTitle: task.title, agent, action, time: '刚刚' }, ...current])
  }

  function watchRun(runId: string) {
    if (subscriptions.current.has(runId) || terminalRuns.current.has(runId)) return
    const unsubscribe = subscribeWorkflowRun(runId, (event) => {
      const seenEventIds = runEventIds.current.get(runId) ?? new Set<string>()
      if (event.id && seenEventIds.has(event.id)) return
      if (event.id) seenEventIds.add(event.id)
      if (seenEventIds.size > 200) seenEventIds.delete(seenEventIds.values().next().value!)
      runEventIds.current.set(runId, seenEventIds)
      const run = event.run
      if (event.message && run) {
        const activity = { id: event.id ?? `run-${runId}-${Date.now()}`, taskTitle: run.taskTitle, agent: run.agentName, action: event.message, time: '刚刚' }
        setRuns((current) => [activity, ...current].slice(0, 200))
      }
      if (event.nextRunId) watchRun(event.nextRunId)
      if (pageRef.current === 'overview' && event.type === 'handoff.created' && run?.agentId === 'ceo' && event.nextRun) {
        const target = event.nextRun
        const agent = agents.find((candidate) => candidate.id === target.agentId || candidate.name === target.agentName)
        if (agent) setOfficeHandoff({ id: target.id, sourceAgentId: run.agentId, sourceAgentName: run.agentName, targetAgentId: agent.id, targetAgentName: agent.name })
      }
      const terminal = ['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted'].includes(event.type) || (event.type === 'run.snapshot' && run && ['completed', 'failed', 'cancelled'].includes(run.status))
      if (terminal || ['run.snapshot', 'run.started', 'handoff.created'].includes(event.type)) refreshWorkflow.current()
      if (terminal) {
        subscriptions.current.get(runId)?.()
        subscriptions.current.delete(runId)
        runEventIds.current.delete(runId)
        terminalRuns.current.add(runId)
        if (terminalRuns.current.size > 1000) terminalRuns.current.delete(terminalRuns.current.values().next().value!)
      }
    })
    subscriptions.current.set(runId, unsubscribe)
  }
  watchRunRef.current = watchRun

  function updateStage(task: Task, stage: Stage, message: string, agent = task.owner) {
    const isBackend = /后端|api|数据库|服务/i.test(`${task.title} ${task.kind} ${task.channel}`)
    const nextOwner = stage === 'research' ? 'CEO Agent' : stage === 'writing' ? isBackend ? '后端 Agent' : '前端 Agent' : stage === 'review' ? '测试 Agent' : '林同学'
    const ownerInitial = nextOwner === 'CEO Agent' ? 'CEO' : nextOwner === '后端 Agent' ? '后' : nextOwner === '前端 Agent' ? '前' : nextOwner === '测试 Agent' ? '测' : '林'
    const updated = { ...task, stage, owner: nextOwner, ownerInitial, progress: stage === 'approved' ? 100 : stage === 'review' ? 92 : stage === 'writing' ? 64 : 28, updated: '刚刚' }
    setTasks((current) => current.map((item) => item.id === task.id ? updated : item))
    addRun(updated, agent, message)
    setToast(message)
  }

  function updateAgent(id: string, patch: Partial<AgentProfile>) {
    setAgents((current) => current.map((agent) => agent.id === id ? { ...agent, ...patch } : agent))
  }

  async function retryWorkflowTask(task: WorkflowTask) {
    if (workflowBusy) return
    const recentRuns = selectedDetail?.runs.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt)) ?? []
    const returned = selectedDetail?.review?.decision?.value === 'return'
    const failedRun = !returned && recentRuns[0]?.status === 'failed' ? recentRuns[0] : undefined
    const phase = failedRun?.phase === 'ceo-plan' ? 'plan' : failedRun?.phase === 'qa-review' ? 'review' : 'execute'
    const agent = phase === 'plan'
      ? task.agents?.ceo
      : phase === 'review'
        ? task.agents?.qa
        : (task.agents?.specialists ?? []).find((candidate) => candidate.id === failedRun?.agentId) ?? task.agents?.specialist
    if (!agent) {
      setToast(phase === 'plan' ? '找不到 CEO Agent 配置，无法重新拆解。' : '找不到专业 Agent 配置，无法重新执行。')
      return
    }
    setWorkflowBusy(true)
    try {
      const result = await retryWorkflowPhase(task.id, phase, agent)
      watchRun(result.run.id)
      refreshWorkflow.current()
      setToast(phase === 'plan' ? 'CEO Agent 正在重新拆解任务' : phase === 'review' ? '测试 Agent 正在重新验收' : '专业 Agent 正在重新执行任务')
    } catch (error) {
      setToast(error instanceof Error ? error.message : '无法重试工作流阶段')
    } finally {
      setWorkflowBusy(false)
    }
  }

  async function decideTaskDelivery(taskId: string, reviewId: string, decision: DeliveryDecision, note?: string) {
    if (workflowBusy) return
    setWorkflowBusy(true)
    try {
      await decideWorkflowDelivery(taskId, reviewId, decision, note)
      setToast(decision === 'approve' ? '已确认交付' : '已退回修改，未自动重跑')
    } catch (error) {
      setToast(error instanceof Error ? error.message : '无法保存验收决定')
    } finally {
      refreshWorkflow.current()
      setWorkflowBusy(false)
    }
  }

  async function cancelWorkflowTask(task: WorkflowTask) {
    const activeRun = selectedDetail?.runs.findLast((run) => run.taskId === task.id && ['queued', 'running'].includes(run.status))
    if (!activeRun) {
      setToast('没有可取消的运行。')
      return
    }
    setWorkflowBusy(true)
    try {
      const result = await cancelWorkflowRun(activeRun.id)
      refreshWorkflow.current()
      setToast(result.cancelled ? '排队运行已取消，不会自动重放。' : '已请求停止运行；正在等待执行器退出。')
    } catch (error) {
      setToast(error instanceof Error ? error.message : '无法取消工作流运行')
    } finally {
      setWorkflowBusy(false)
    }
  }

  async function submitThreadFollowup(message: string) {
    if (!selectedThreadId || workflowBusy) return false
    setWorkflowBusy(true)
    let accepted = false
    try {
      const result = await followupThread(selectedThreadId, message)
      accepted = true
      watchRun(result.run.id)
      refreshWorkflow.current()
      setToast('跟进已加入原工作线程，使用该线程的 Agent 配置继续执行')
    } catch (error) {
      setToast(error instanceof Error ? error.message : '无法续接工作线程')
    } finally {
      setWorkflowBusy(false)
    }
    return accepted
  }

  async function createTask(title: string, brief: string, channel: string, projectPath: string, accessMode: ProjectAccessMode, allowedCommands: string[], verificationCommands: string[], specialistIds: string[]) {
    if (workflowBusy) return
    setWorkflowBusy(true)
    const task: Task = {
      id: `t-${Date.now()}`,
      title,
      brief: brief || '由 CEO Agent 拆解目标，并根据团队职责分派给合适的专业 Agent。',
      stage: 'research',
      owner: 'CEO Agent',
      ownerInitial: 'CEO',
      channel,
      kind: channel,
      updated: '刚刚',
      due: '待排期',
      progress: 12,
      sources: 0,
    }
    try {
      const project = await registerProject({ path: projectPath, accessMode, allowedCommands, verificationCommands })
      const toAgent = (agent: AgentProfile): WorkflowAgentConfig => ({ id: agent.id, name: agent.name, provider: agent.provider, model: agent.model, executor: agent.executor ?? 'model-api', skills: getSkills(agent.skillIds) })
      const ceo = agents.find((agent) => agent.id === 'ceo') ?? agents[0]
      const selectedSpecialists = agents.filter((agent) => specialistIds.includes(agent.id) && agent.id !== 'ceo' && agent.id !== 'qa')
      const fallbackSpecialist = /后端|api|数据库|服务/i.test(`${title} ${channel} ${brief}`) ? agents.find((agent) => agent.id === 'backend') : agents.find((agent) => agent.id === 'frontend')
      const specialists = selectedSpecialists.length ? selectedSpecialists : [fallbackSpecialist ?? agents[0]]
      const qa = agents.find((agent) => agent.id === 'qa') ?? agents[0]
      const specialistConfigs = specialists.map(toAgent)
      const result = await startWorkflow({ projectId: project.id, title, brief, agents: { ceo: toAgent(ceo), specialists: specialistConfigs, specialist: specialistConfigs[0], qa: toAgent(qa) } })
      const linkedTask = { ...task, workflowTaskId: result.task.id, projectPath, workflowStatus: result.task.status }
      addRun(linkedTask, 'CEO Agent', '已进入真实本地工作流队列')
      watchRun(result.run.id)
      setSelectedThreadId(result.thread.id)
      refreshWorkflow.current()
      setCreateOpen(false)
      if (page === 'tasks') {
        setFilter('all')
        setSearch('')
      }
      setToast('任务已交给 CEO Agent 拆解，正在实时执行')
    } catch (error) {
      setToast(error instanceof Error ? error.message : '无法启动真实工作流')
    } finally {
      setWorkflowBusy(false)
    }
  }

  function navigate(next: Page) {
    if (next !== 'overview') setOfficeHandoff(null)
    setPage(next)
    setMobileNavOpen(false)
    if (next !== 'tasks') setFilter('all')
  }

  function openAgentRun(agentId: string) {
    const runId = officeHandoff?.targetAgentId === agentId && !harnessRuns.some((run) => run.id === officeHandoff.id && !['queued', 'running'].includes(run.status)) ? officeHandoff.id : officeRuns.get(agentId)
    if (!runId) { navigate('team'); return }
    if (!harnessView.layout.ids.includes(runId) && harnessView.layout.ids.length >= maxHarnessPanes) {
      setToast('窗格已满，请先关闭一个运行窗格。')
    } else harnessView.open(runId)
    navigate('harness')
  }

  function closeTaskDetail() {
    setSelectedTaskId(null)
    if (linkedTaskId) onCloseTaskLink()
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNavOpen ? 'sidebar-open' : ''}`}>
        <div className="brand-row">
          <div className="brand-mark"><Sparkles size={18} strokeWidth={2.2} /></div>
          <span className="brand-name">织点<span className="brand-period">.</span></span>
          <button className="icon-button sidebar-close" aria-label="关闭导航" onClick={() => setMobileNavOpen(false)}><X size={18} /></button>
        </div>
        <button className="workspace-switch">
          <span className="workspace-avatar">栖</span>
          <span className="workspace-copy"><strong>栖光工作室</strong><small>个人工作空间</small></span>
          <ChevronDown size={15} />
        </button>

        <div className="nav-label">工作空间</div>
        <nav className="primary-nav" aria-label="主导航">
          <NavItem icon={<LayoutDashboard size={18} />} label="作战大屏" active={page === 'overview'} onClick={() => navigate('overview')} />
          <NavItem icon={<Terminal size={18} />} label="Harness 分屏" active={page === 'harness'} onClick={() => navigate('harness')} />
          <NavItem icon={<Workflow size={18} />} label="任务流水线" count={(workflow?.activeTaskCount ?? 0) + demoTasks.filter((task) => task.stage !== 'approved').length} active={page === 'tasks'} onClick={() => navigate('tasks')} />
          <NavItem icon={<MessagesSquare size={18} />} label="工作线程" count={workflow?.threadCount ?? 0} active={page === 'threads'} onClick={() => navigate('threads')} />
          <NavItem icon={<Clock3 size={18} />} label="定时任务" active={page === 'schedules'} onClick={() => navigate('schedules')} />
          <NavItem icon={<Send size={18} />} label="结果交付" active={page === 'delivery'} warningCount={deliveryAlertCount} onClick={() => navigate('delivery')} />
          <NavItem icon={<ArrowDownToLine size={18} />} label="飞书 / Lark 入站" active={page === 'inbound'} onClick={() => navigate('inbound')} />
          <NavItem icon={<UsersRound size={18} />} label="Agent 团队" active={page === 'team'} onClick={() => navigate('team')} />
          <NavItem icon={<Library size={18} />} label="Skills 库" active={page === 'skills'} onClick={() => navigate('skills')} />
          <NavItem icon={<BookOpen size={18} />} label="长期上下文" active={page === 'context'} onClick={() => navigate('context')} />
          <NavItem icon={<ListChecks size={18} />} label="执行记录" active={page === 'runs'} onClick={() => navigate('runs')} />
        </nav>
        <div className="nav-label nav-label-spaced">偏好设置</div>
        <nav className="primary-nav" aria-label="偏好设置">
          <NavItem icon={<Settings2 size={18} />} label="本机 Harness" active={page === 'settings'} onClick={() => navigate('settings')} />
          {onLogout && <NavItem icon={<UsersRound size={18} />} label="项目成员" active={page === 'members'} onClick={() => navigate('members')} />}
        </nav>
        <div className="sidebar-bottom">
          <div className="demo-note"><span className="demo-pulse" /><span><strong>本地 Agent 工作台</strong><small>真实工作流与演示任务并存</small></span></div>
          <button className="profile-row">
            <span className="profile-avatar">林</span>
            <span className="profile-copy"><strong>林同学</strong><small>管理员</small></span>
            <MoreHorizontal size={18} />
          </button>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="topbar-left">
            <button className="icon-button mobile-menu" aria-label={deliveryAlertCount ? `打开导航，${deliveryAlertCount} 条投递异常` : '打开导航'} onClick={() => setMobileNavOpen(true)}><Menu size={19} />{deliveryAlertCount > 0 && <span className="notification-dot" aria-hidden="true" />}</button>
            <div className="breadcrumbs"><span>栖光工作室</span><ChevronRight size={14} /><strong>{pageLabel(page)}</strong></div>
          </div>
          <div className="topbar-actions">
            <div className="demo-chip"><span className="demo-pulse" />本地运行</div>
            <button className="search-trigger" onClick={() => document.getElementById('global-search')?.focus()}><Search size={15} /><span>搜索任务</span><kbd><Command size={11} /> K</kbd></button>
            <button className="icon-button notification-button" aria-label="查看待审批" onClick={() => { navigate('tasks'); setFilter('review') }}>
              <Bell size={18} />{approvalCount > 0 && <span className="notification-dot" />}
            </button>
            <div className="topbar-avatar">林</div>
            {onLogout && <button type="button" className="icon-button" title="退出登录" aria-label="退出登录" onClick={onLogout}><LogOut size={17} /></button>}
          </div>
        </header>

        <div className="page-content">
          {page === 'overview' && <WarRoom tasks={tasks} runs={runs} reviewTasks={reviewTasks} approvalCount={approvalCount} agents={agents} handoff={officeHandoff} officeRuns={officeRuns} onOpenAgent={openAgentRun} paused={dispatchPaused} onTogglePaused={() => setDispatchPaused((value) => !value)} onCreate={() => setCreateOpen(true)} onSelect={setSelectedTaskId} onNavigate={navigate} />}
          {page === 'harness' && <HarnessWorkspace view={harnessView} runs={harnessRuns} projects={workflow?.projects ?? []} catalog={executorCatalog} onTask={(id) => setSelectedTaskId(`restored-${id}`)} />}
          {page === 'tasks' && <TasksPage demoTasks={filteredDemoTasks} revision={workflowTag} filter={filter} setFilter={setFilter} search={search} setSearch={setSearch} onCreate={() => setCreateOpen(true)} onSelect={setSelectedTaskId} />}
          {page === 'threads' && <ThreadsPage revision={workflowTag} count={workflow?.threadCount ?? 0} selectedThreadId={selectedThreadId} detail={threadDetail?.thread.id === selectedThreadId ? threadDetail : null} busy={workflowBusy} onSelect={setSelectedThreadId} onFollowup={submitThreadFollowup} />}
          {page === 'schedules' && <SchedulesPage hasScheduleSources={workflow?.hasScheduleSources ?? false} onToast={setToast} onOpenTask={(id) => setSelectedTaskId(`restored-${id}`)} />}
          {page === 'delivery' && <DeliveryPage projects={workflow?.projects ?? []} alerts={deliveryAlerts} onToast={setToast} />}
          {page === 'inbound' && <InboundPage projects={workflow?.projects ?? []} onToast={setToast} onOpenTask={(id) => setSelectedTaskId(`restored-${id}`)} />}
          {page === 'team' && <TeamPage tasks={tasks} agents={agents} executorCatalog={executorCatalog} onUpdateAgent={updateAgent} onToast={setToast} onOpenSkills={() => navigate('skills')} />}
          {page === 'skills' && <SkillsPage agents={agents} onUpdateAgent={updateAgent} onToast={setToast} />}
          {page === 'context' && <ContextLibrary projects={workflow?.projects ?? []} onToast={setToast} />}
          {page === 'runs' && <RunsPage runs={runs} />}
          {page === 'settings' && <HarnessSettings agents={agents} onNavigate={navigate} />}
          {page === 'members' && onLogout && <ProjectMembers projects={workflow?.projects ?? []} />}
          <footer className="page-footer"><span>织点 AI 工作团队</span><span><ShieldCheck size={13} /> 本机 Harness 认证由各自原生运行时管理</span></footer>
        </div>
      </main>

      {mobileNavOpen && <button className="mobile-scrim" aria-label="关闭导航" onClick={() => setMobileNavOpen(false)} />}
      {selectedTask && <TaskDrawer task={selectedTask} agents={agents} detail={selectedDetail} busy={workflowBusy} onRetry={retryWorkflowTask} onCancel={cancelWorkflowTask} onDecide={decideTaskDelivery} onClose={closeTaskDetail} onUpdate={updateStage} />}
      {selectedRemoteId && !selectedTask && <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeTaskDetail() }}><aside className="task-drawer" aria-label="任务详情"><div className="drawer-top"><span>任务详情</span><button className="icon-button" aria-label="关闭详情" onClick={closeTaskDetail}><X size={19} /></button></div><div className="drawer-body">{taskDetailError?.id === selectedRemoteId ? <><p role="alert">{taskDetailError.message}</p><button className="button-secondary" onClick={() => setDetailAttempt((last) => last + 1)}>重试加载</button></> : <p role="status">正在加载任务详情…</p>}</div></aside></div>}
      {createOpen && <CreateModal busy={workflowBusy} agents={agents} onClose={() => setCreateOpen(false)} onCreate={createTask} />}
      {toast && <div className="toast"><CircleCheck size={17} />{toast}</div>}
    </div>
  )
}

function HistoryControls({ history }: { history: { page: number; hasPrevious: boolean; hasNext: boolean; previous: () => void; next: () => void; reset: () => void; retry: () => void; error?: string } }) {
  return <div className="history-controls">
    {history.error && <div role="alert">{history.error} <button className="button-secondary" onClick={history.hasPrevious ? history.reset : history.retry}>{history.hasPrevious ? '返回首页' : '重试加载'}</button></div>}
    {(history.hasPrevious || history.hasNext) && <nav aria-label="历史分页"><button className="icon-button" title="上一页" aria-label="上一页" disabled={!history.hasPrevious} onClick={history.previous}><ChevronRight className="history-previous" size={16} /></button><span>第 {history.page} 页</span><button className="icon-button" title="下一页" aria-label="下一页" disabled={!history.hasNext} onClick={history.next}><ChevronRight size={16} /></button></nav>}
  </div>
}

function ThreadsPage({ revision, count, selectedThreadId, detail, busy, onSelect, onFollowup }: { revision?: string; count: number; selectedThreadId: string | null; detail: WorkflowThreadDetail | null; busy: boolean; onSelect: (id: string) => void; onFollowup: (message: string) => Promise<boolean> }) {
  const [query, setQuery] = useState('')
  const history = useWorkbenchHistory(loadThreadHistory, { q: query.trim() }, revision)
  const threads = history.items
  const [draft, setDraft] = useState<{ id: string | null; value: string } | null>(null)
  const message = draft?.id === selectedThreadId ? draft?.value ?? '' : ''
  const setMessage = (value: string) => setDraft({ id: selectedThreadId, value })
  const active = detail?.tasks.some((task) => ['queued', 'executing', 'reviewing'].includes(task.status)) ?? false
  return <div className="threads-page">
    <aside className="threads-list-panel">
      <div className="threads-panel-heading"><div><div className="section-eyebrow">PERSISTENT WORK</div><h2>工作线程</h2></div><span>{count}</span></div>
      <label className="task-search"><Search size={16} /><input aria-label="搜索线程" placeholder="搜索线程或项目" maxLength={400} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      {(history.loading || (!history.error && !threads.length)) && <div className="threads-empty" role="status">{history.loading ? '正在加载线程…' : '没有匹配的工作线程'}</div>}
      {threads.map((thread) => <button className={`thread-list-item ${selectedThreadId === thread.id ? 'selected' : ''}`} key={thread.id} onClick={() => onSelect(thread.id)}>
        <span className="thread-list-icon"><MessagesSquare size={16} /></span>
        <span className="thread-list-copy"><strong>{thread.title}</strong><small>{thread.projectName ?? '本地项目'} · {new Date(thread.updatedAt).toLocaleDateString()}</small></span>
        <span className={`thread-status-dot ${thread.status}`} title={thread.status} />
      </button>)}
      <HistoryControls history={history} />
    </aside>
    <section className="thread-conversation-panel">
      {!detail ? <div className="threads-empty thread-detail-empty">选择一个线程查看历史与运行记录。</div> : <>
        <header className="thread-detail-header"><div><div className="section-eyebrow">{detail.thread.projectName ?? threads.find((thread) => thread.id === detail.thread.id)?.projectName ?? 'PROJECT THREAD'}</div><h2>{detail.thread.title}</h2><p>{detail.tasks.length} 个任务 · {detail.messages.length} 条消息 · 最近更新 {new Date(detail.thread.updatedAt).toLocaleString()}</p></div><span className={`thread-state-pill ${detail.thread.status}`}>{detail.thread.status}</span></header>
        <div className="thread-timeline">
          {detail.messages.map((item) => {
            const task = detail.tasks.find((candidate) => candidate.id === item.taskId)
            const relatedRuns = detail.runs.filter((run) => run.taskId === item.taskId)
            return <article className={`thread-message ${item.role}`} key={item.id}>
              <div className="thread-message-meta"><strong>{item.role === 'user' ? '你' : 'Agent'}</strong><time>{new Date(item.createdAt).toLocaleString()}</time></div>
              <div className="thread-message-content">{item.content}</div>
              {task && <div className="thread-task-record"><div><strong>{task.title}</strong><span>状态：{task.status}</span></div><p>{task.reviewId ? detail.reviews.find((review) => review.id === task.reviewId)?.summary : task.execution?.summary || String(task.plan?.summary ?? '') || task.brief}</p>{relatedRuns.length > 0 && <small>{relatedRuns.map((run) => `${run.phase} · ${run.status}`).join('　/　')}</small>}</div>}
            </article>
          })}
          {!detail.messages.length && <div className="threads-empty">该线程暂无消息。</div>}
        </div>
        <form className="thread-followup-form" onSubmit={(event) => { event.preventDefault(); const value = message.trim(); if (value && !busy && !active) void onFollowup(value).then((accepted) => { if (accepted) setMessage('') }) }}>
          <textarea value={message} onChange={(event) => setMessage(event.target.value)} placeholder={active ? '当前线程仍有任务运行，完成后可以继续跟进。' : '在这个线程里继续补充目标、反馈或下一步要求…'} disabled={busy || active} rows={3} />
          <div><small>续接将复用该线程绑定的项目与 Agent 配置；历史消息和任务摘要会以限长上下文提供给执行器。</small><button className="button-primary" type="submit" disabled={!message.trim() || busy || active}><Send size={15} />{busy ? '提交中…' : '继续此线程'}</button></div>
        </form>
      </>}
    </section>
  </div>
}

function pageLabel(page: Page) {
  return ({ overview: '作战大屏', harness: 'Harness 分屏', tasks: '任务流水线', threads: '工作线程', schedules: '定时任务', delivery: '结果交付', inbound: '飞书 / Lark 入站', team: 'Agent 团队', skills: 'Skills 库', context: '长期上下文', runs: '执行记录', settings: '本机 Harness', members: '项目成员' })[page]
}

function NavItem({ icon, label, active, count, warningCount = 0, onClick }: { icon: React.ReactNode; label: string; active: boolean; count?: number; warningCount?: number; onClick: () => void }) {
  return <button className={`nav-item ${active ? 'nav-item-active' : ''}`} aria-label={warningCount ? `${label}，${warningCount} 条投递异常` : undefined} onClick={onClick}>{icon}<span>{label}</span>{warningCount > 0 ? <small className="nav-count nav-count-warning" aria-hidden="true">{warningCount > 99 ? '99+' : warningCount}</small> : count !== undefined && <small className="nav-count">{count}</small>}</button>
}

function WarRoom({ tasks, runs, reviewTasks, approvalCount, agents, handoff, officeRuns, onOpenAgent, paused, onTogglePaused, onCreate, onSelect, onNavigate }: { tasks: Task[]; runs: RunLog[]; reviewTasks: Task[]; approvalCount: number; agents: AgentProfile[]; handoff: OfficeHandoff | null; officeRuns: Map<string, string>; onOpenAgent: (id: string) => void; paused: boolean; onTogglePaused: () => void; onCreate: () => void; onSelect: (id: string) => void; onNavigate: (page: Page) => void }) {
  const activeCount = tasks.filter((task) => task.stage !== 'approved').length
  const doneCount = tasks.filter((task) => task.stage === 'approved').length
  const onlineCount = agents.filter((agent) => agent.online).length
  return <div className="war-room">
    <div className="war-heading"><div><div className="war-eyebrow"><span className="war-live-dot" />AI TEAM OPERATIONS <i /> LOCAL SIMULATION</div><h1>AI Agent 作战中心</h1><p>CEO 统筹任务，专业 Agent 并行协作，你保留最终验收权。</p></div><div className="war-controls"><span className="war-clock">{timeLabel()}</span><button className={`war-control ${paused ? 'control-paused' : ''}`} aria-pressed={paused} onClick={onTogglePaused}>{paused ? <Play size={14} /> : <Pause size={14} />}{paused ? '恢复调度' : '暂停调度'}</button><button className="war-create" onClick={onCreate}><Plus size={15} />派发任务</button></div></div>
    <section className="agent-console" aria-label="Agent 实时状态">{agents.map((agent) => <AgentConsoleCard key={agent.id} agent={agent} tasks={tasks} onClick={() => onOpenAgent(agent.id)} />)}</section>
    <div className="war-main-grid">
      <section className="battle-map-panel"><div className="battle-panel-head"><div><div className="war-kicker"><UsersRound size={13} /> ZHIDIAN AI STUDIO</div><h2>Agent 办公室</h2></div><div className="map-legend"><span><i className="legend-active" />执行链路</span><span><i className="legend-idle" />待命</span></div></div><OfficeScene agents={agents} tasks={tasks} handoff={handoff} officeRuns={officeRuns} onOpenAgent={onOpenAgent} /><div className="map-footer"><span><Radio size={12} /> {onlineCount} AGENTS ONLINE</span><span><GitBranch size={12} /> {activeCount} ACTIVE TASKS</span><span className="simulated-data-label">含演示状态</span></div></section>
      <aside className="war-side-rail"><section className="war-side-panel live-feed-panel"><div className="war-panel-heading"><div><div className="war-kicker"><span className="war-live-dot" />LIVE FEED</div><h2>实时动态</h2></div><button className="war-link" onClick={() => onNavigate('runs')}>全部 <ArrowUpRight size={13} /></button></div><div className="live-feed-list">{runs.slice(0, 5).map((run) => <div className="live-feed-row" key={run.id}><span className="feed-time">{run.time}</span><span className="feed-agent">{run.agent.replace(' Agent', '').toUpperCase()}</span><span className="feed-action"><strong>{run.action}</strong><small>{run.taskTitle}</small></span></div>)}</div></section>
        <section className="war-side-panel runtime-panel"><div className="war-panel-heading"><div><div className="war-kicker"><Cpu size={13} />RUNTIME SNAPSHOT</div><h2>运行概况</h2></div><span className="simulation-pill">含演示统计</span></div><div className="runtime-grid"><RuntimeValue label="在线员工" value={`${onlineCount}/${agents.length}`} tone="cyan" /><RuntimeValue label="执行任务" value={activeCount} tone="lime" /><RuntimeValue label="待确认交付" value={approvalCount} tone="orange" /><RuntimeValue label="已交付" value={doneCount} tone="pink" /></div><button className="route-summary-link" onClick={() => onNavigate('team')}><span><Cpu size={14} />模型路由配置</span><span>{new Set(agents.map((agent) => agent.provider)).size} 个服务商 <ChevronRight size={13} /></span></button></section></aside>
    </div>
    <div className="war-bottom-grid"><section className="war-bottom-panel acceptance-panel" aria-label="验收队列"><div className="war-panel-heading"><div><div className="war-kicker"><ShieldCheck size={13} />HUMAN GATE</div><h2>验收队列 <span className="queue-count">{approvalCount}</span></h2></div><button className="war-link" onClick={() => { onNavigate('tasks') }}>任务列表 <ArrowUpRight size={13} /></button></div>{reviewTasks.map((task) => <button className="acceptance-row" key={task.id} onClick={() => onSelect(task.id)}><span className="acceptance-marker" /><span><strong>{task.title}</strong><small>QA 已通过 · {task.updated}</small></span><span className="acceptance-action">查看 <ArrowRight size={13} /></span></button>)}{!approvalCount && <div className="war-empty">没有待确认的交付。</div>}</section>
      <section className="war-bottom-panel route-board"><div className="war-panel-heading"><div><div className="war-kicker"><GitBranch size={13} />MODEL ROUTING</div><h2>员工模型路由</h2></div><button className="war-link" onClick={() => onNavigate('team')}>配置 <ArrowUpRight size={13} /></button></div><div className="route-board-list">{agents.slice(0, 5).map((agent) => <div className="route-board-row" key={agent.id}><span className={`mini-agent-icon ${agent.tone}`}>{agent.initial.slice(0, 1)}</span><strong>{agent.name}</strong><span className="route-provider">{agent.provider}</span><code>{agent.model || '未填写模型'}</code></div>)}</div><div className="route-footnote"><ShieldCheck size={12} />仅保存路由偏好；尚未连接模型 API</div></section>
      <section className="war-bottom-panel dispatch-panel"><div className="war-panel-heading"><div><div className="war-kicker"><ScanLine size={13} />DISPATCH POLICY</div><h2>调度规则</h2></div><span className={`rule-state ${paused ? 'rule-state-paused' : ''}`}><i />{paused ? '已暂停' : '运行中'}</span></div><div className="dispatch-rule"><span className="rule-number">01</span><span><strong>CEO Agent 接收目标</strong><small>{paused ? '新任务留在队列，恢复后再进行分派' : '拆解子任务并匹配专业员工'}</small></span></div><div className="dispatch-rule"><span className="rule-number">02</span><span><strong>按员工路由到指定模型</strong><small>每个 Agent 独立配置服务商与 model ID</small></span></div><div className="dispatch-rule"><span className="rule-number">03</span><span><strong>人工验收后才算交付</strong><small>未经确认的结果不会标记为完成</small></span></div><button className="dispatch-cta" onClick={onCreate}><Terminal size={14} />创建一个新任务 <ArrowRight size={13} /></button></section></div>
  </div>
}

function AgentConsoleCard({ agent, tasks, onClick }: { agent: AgentProfile; tasks: Task[]; onClick: () => void }) {
  const assigned = tasks.filter((task) => task.owner === agent.name && task.stage !== 'approved')
  const progress = assigned[0]?.progress ?? (agent.online ? 0 : 0)
  return <button className="agent-console-card" onClick={onClick}><span className={`console-avatar ${agent.tone}`}><AgentFigure agentId={agent.id} /><i className={agent.online ? 'online' : ''} /></span><span className="console-main"><span className="console-role">{agent.name}<small>{agent.online ? agent.status : 'OFFLINE'}</small></span><span className="console-model"><span className="provider-mark">{providerShort(agent.provider)}</span>{agent.model}</span><span className="console-progress"><i><b style={{ width: `${progress}%` }} /></i><small>{assigned.length ? `${progress}%` : agent.online ? 'IDLE' : 'OFF'}</small></span></span><ChevronRight size={13} className="console-chevron" /></button>
}

function OfficeScene({ agents, tasks, handoff, officeRuns, onOpenAgent }: { agents: AgentProfile[]; tasks: Task[]; handoff: OfficeHandoff | null; officeRuns: Map<string, string>; onOpenAgent: (id: string) => void }) {
  const officeOrder = ['research', 'ceo', 'design', 'frontend', 'backend', 'qa', 'ops']
  const [dispatchTarget, setDispatchTarget] = useState<string | null>(null)
  const [dispatching, setDispatching] = useState(false)
  const [dispatchStyle, setDispatchStyle] = useState<React.CSSProperties>({})
  const [routePath, setRoutePath] = useState('')
  const [routeEnd, setRouteEnd] = useState({ x: 50, y: 50 })
  const floorRef = useRef<HTMLDivElement>(null)
  const orderedAgents = [...agents].sort((left, right) => {
    const leftIndex = officeOrder.indexOf(left.id)
    const rightIndex = officeOrder.indexOf(right.id)
    return (leftIndex < 0 ? officeOrder.length : leftIndex) - (rightIndex < 0 ? officeOrder.length : rightIndex)
  })
  const targetAgent = agents.find((agent) => agent.id === dispatchTarget)

  useEffect(() => {
    if (!handoff || handoff.sourceAgentId !== 'ceo') return
    const floor = floorRef.current
    const source = floor?.querySelector<HTMLElement>('[data-agent="ceo"] .office-person')
    const targetSelector = '[data-agent="' + CSS.escape(handoff.targetAgentId) + '"] .office-person'
    const target = floor?.querySelector<HTMLElement>(targetSelector)
    if (!floor || !source || !target) return
    let startFrame: number | undefined
    let dispatchTimer: number | undefined

    const frame = window.requestAnimationFrame(() => {
      const floorRect = floor.getBoundingClientRect()
      const sourceRect = source.getBoundingClientRect()
      const targetRect = target.getBoundingClientRect()
      const startX = sourceRect.left + sourceRect.width / 2 - floorRect.left
      const startY = sourceRect.top + sourceRect.height / 2 - floorRect.top
      const targetCenterX = targetRect.left + targetRect.width / 2 - floorRect.left
      const endX = Math.max(34, Math.min(floorRect.width - 34, targetCenterX + (targetCenterX > startX ? -1 : 1) * (targetRect.width / 2 + 40)))
      const endY = targetRect.top + targetRect.height / 2 - floorRect.top
      const startXPct = startX / floorRect.width * 100
      const endXPct = endX / floorRect.width * 100
      const startYPct = startY / floorRect.height * 100
      const endYPct = endY / floorRect.height * 100
      const curveY = (startYPct + endYPct) / 2 - 8
      const route = 'M ' + startXPct.toFixed(2) + ' ' + startYPct.toFixed(2) + ' C ' + startXPct.toFixed(2) + ' ' + curveY.toFixed(2) + ' ' + endXPct.toFixed(2) + ' ' + curveY.toFixed(2) + ' ' + endXPct.toFixed(2) + ' ' + endYPct.toFixed(2)

      setDispatchStyle({
        '--dispatch-start-left': startXPct + '%',
        '--dispatch-start-top': startY + 'px',
        '--dispatch-left': endXPct + '%',
        '--dispatch-top': endY + 'px',
      } as React.CSSProperties)
      setRoutePath(route)
      setRouteEnd({ x: endXPct, y: endYPct })
      setDispatchTarget(handoff.targetAgentId)
      setDispatching(false)
      startFrame = window.requestAnimationFrame(() => setDispatching(true))
      dispatchTimer = window.setTimeout(() => setDispatching(false), 3600)
    })

    return () => {
      window.cancelAnimationFrame(frame)
      if (startFrame !== undefined) window.cancelAnimationFrame(startFrame)
      window.clearTimeout(dispatchTimer)
    }
  }, [handoff])

  return <div className="office-scene" role="region" aria-label="Agent 办公室实时状态">
    <div className="office-wall">
      <div className="office-window" aria-hidden="true"><i /><i /><i /><b /></div>
      <div className="office-brand"><span className="office-brand-mark"><UsersRound size={13} /></span><span><strong>织点 AI STUDIO</strong><small>ONE TEAM · MANY AGENTS</small></span></div>
      <div className="office-whiteboard"><small>本周协作流程</small><strong>PLAN <i>→</i> BUILD <i>→</i> VERIFY</strong><span>CEO · SPECIALISTS · QA</span></div>
      <div className="office-clock" aria-label="团队状态在线"><i /><span>TEAM<br />ONLINE</span></div>
    </div>
    <div className="office-floor" ref={floorRef}>
      <div className="office-floor-caption"><span>开放协作区</span><small>{dispatching && targetAgent ? 'CEO 正在向 ' + targetAgent.name + ' 派发任务' : 'Agent 工位'}</small></div>
      <svg className={'office-dispatch-route ' + (dispatching ? 'is-visible' : '')} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d={routePath} /><circle cx={routeEnd.x} cy={routeEnd.y} r="1.6" /></svg>
      <div className={'office-dispatch-token ' + (dispatching ? 'is-visible' : '')} style={dispatchStyle} aria-hidden="true"><span className="office-dispatch-shadow" /><span className="office-dispatch-person"><AgentFigure agentId="ceo" /></span><span className="office-dispatch-bubble"><strong>任务交接</strong><small>{'CEO → ' + (targetAgent?.name.replace(' Agent', '') ?? 'Agent')}</small></span></div>
      <div className={'office-handoff-note ' + (dispatching ? 'is-visible' : '')} aria-live="polite"><span>CEO</span><ArrowRight size={11} /><strong>{targetAgent?.name ?? '专业 Agent'}</strong><small>{dispatching ? '正在移动 · 交接中' : '等待下一次派发'}</small></div>
      <div className="office-team-grid">
        {orderedAgents.map((agent) => {
          const assignedTask = tasks.find((task) => task.owner === agent.name && task.stage !== 'approved')
          const stateLabel = !agent.online ? '离线' : assignedTask ? '工作中' : agent.status === '空闲' ? '待命' : agent.status
          const isTarget = dispatching && agent.id === dispatchTarget
          const isOrigin = dispatching && agent.id === 'ceo'
          const canOpenRun = officeRuns.has(agent.id)
          return <button className={['office-seat', agent.tone, agent.online ? '' : 'office-seat-offline', agent.id === 'ceo' ? 'office-seat-ceo' : '', isTarget ? 'office-seat-target' : '', isOrigin ? 'office-seat-origin' : ''].filter(Boolean).join(' ')} data-agent={agent.id} key={agent.id} onClick={() => onOpenAgent(agent.id)} title={canOpenRun ? '打开 Harness 运行' : '打开岗位配置'} aria-label={agent.name + '，' + stateLabel + (canOpenRun ? '，打开 Harness 运行' : '，打开岗位配置')}>
            <span className="office-seat-heading"><strong>{agent.name}</strong><span className={agent.online ? 'office-presence is-online' : 'office-presence'}><i />{isTarget ? '接收中' : stateLabel}</span></span>
            <span className="office-workstation">
              <span className="office-chair" />
              <span className="office-person"><AgentFigure agentId={agent.id} /></span>
              <span className="office-monitor"><i /><b /></span>
              <span className="office-desk-top" />
              <span className="office-desk-front"><i /><i /><i /></span>
              <span className="office-mug" />
            </span>
            <span className="office-seat-task">{assignedTask ? assignedTask.title : agent.role}</span>
          </button>
        })}
      </div>
      <span className="office-plant office-plant-left" aria-hidden="true"><i /><i /><b /></span>
      <span className="office-plant office-plant-right" aria-hidden="true"><i /><i /><b /></span>
      <div className="office-rug" aria-hidden="true" />
    </div>
  </div>
}

function RuntimeValue({ label, value, tone }: { label: string; value: string | number; tone: string }) {
  return <div className={`runtime-value runtime-${tone}`}><span>{label}</span><strong>{value}</strong></div>
}

function providerShort(provider: ModelProvider) {
  return provider === 'Anthropic' ? 'ANTHROPIC' : provider === 'OpenAI Compatible' ? 'OPENAI-COMPAT' : provider.toUpperCase()
}

function TasksPage({ demoTasks, revision, filter, setFilter, search, setSearch, onCreate, onSelect }: { demoTasks: Task[]; revision?: string; filter: 'all' | Stage; setFilter: (value: 'all' | Stage) => void; search: string; setSearch: (value: string) => void; onCreate: () => void; onSelect: (id: string) => void }) {
  const history = useWorkbenchHistory(loadTaskHistory, { q: search.trim(), ...(filter !== 'all' && { stage: filter }) }, revision)
  const tasks = [...history.items.map(toWorkbenchTask), ...(history.page === 1 ? demoTasks : [])]
  const filters: Array<{ id: 'all' | Stage; label: string }> = [{ id: 'all', label: '全部' }, ...stageOrder.map((stage) => ({ id: stage, label: stageMeta[stage].label }))]
  return <>
    <div className="page-heading inner-heading"><div><div className="eyebrow"><span className="eyebrow-dot" />TASK OPERATIONS</div><h1>任务流水线</h1><p>从 CEO 拆解目标到专业 Agent 执行，再由你验收交付。</p></div><button className="button-primary" onClick={onCreate}><Plus size={17} />派发任务</button></div>
    <div className="task-toolbar"><div className="filter-tabs">{filters.map((item) => <button className={filter === item.id ? 'filter-tab active-filter' : 'filter-tab'} key={item.id} onClick={() => setFilter(item.id)}>{item.label}</button>)}</div><label className="task-search"><Search size={16} /><input id="global-search" placeholder="搜索标题、渠道或 Agent" value={search} onChange={(event) => setSearch(event.target.value)} /><kbd>/</kbd></label></div>
    <section className="pipeline-list">
      <div className="pipeline-list-head"><span>任务 / 选题</span><span>负责人</span><span>进度</span><span>截止时间</span><span /></div>
      {tasks.map((task) => <PipelineRow key={task.id} task={task} onClick={() => onSelect(task.id)} />)}
      {!history.error && !tasks.length && <div className="empty-pipeline" role="status"><Search size={22} /><strong>{history.loading ? '正在加载任务…' : '没有找到匹配任务'}</strong></div>}
    </section>
    <HistoryControls history={history} />
  </>
}

function PipelineRow({ task, onClick }: { task: Task; onClick: () => void }) {
  return <button className="pipeline-row" onClick={onClick}><span className="pipeline-title"><span className={`pipeline-marker marker-${stageMeta[task.stage].color}`} /><span><strong>{task.title}</strong><small>{task.kind} <i /> {task.channel}</small></span></span><span className="pipeline-owner"><span className="owner-avatar owner-small">{task.ownerInitial}</span>{task.owner}</span><span className="pipeline-progress"><span className="progress-track"><i style={{ width: `${task.progress}%` }} /></span><small>{task.progress}%</small></span><span className="pipeline-due">{task.due}</span><ChevronRight size={16} className="pipeline-chevron" /></button>
}

function TeamPage({ tasks, agents, executorCatalog, onUpdateAgent, onToast, onOpenSkills }: { tasks: Task[]; agents: AgentProfile[]; executorCatalog: ExecutorDefinition[]; onUpdateAgent: (id: string, patch: Partial<AgentProfile>) => void; onToast: (message: string) => void; onOpenSkills: () => void }) {
  return <>
    <div className="page-heading inner-heading"><div><div className="eyebrow"><span className="eyebrow-dot" />TEAM & MODEL ROUTING</div><h1>Agent 团队</h1><p>按岗位配置不同模型：CEO、前端、后端和测试可以各走各的服务商。</p></div><div className="team-status-pill"><span className="demo-pulse" />{agents.filter((agent) => agent.online).length} 个 Agent 在线</div></div>
    <div className="routing-notice"><Cpu size={15} /><span><strong>模型与 Skills 路由</strong> 每个岗位都有独立模型和技能上下文。当前任务只会选择与岗位相关的 Skills，不会把整套技能库全部塞进提示词。</span></div>
    <div className="team-grid">{agents.map((agent) => {
      const assigned = tasks.filter((task) => task.owner === agent.name && task.stage !== 'approved')
      const skills = getSkills(agent.skillIds)
      return <article className="team-card route-agent-card" key={agent.id}><div className="team-card-top"><span className={`team-character ${agent.tone}`}><AgentFigure agentId={agent.id} /><i className={agent.online ? 'online' : ''} /></span><span className={`agent-online-label ${agent.online ? 'state-online' : ''}`}><i />{agent.online ? '在线' : '离线'}</span></div><div className="team-role">{agent.role}</div><h2>{agent.name}</h2><div className="route-controls"><label>模型服务商<select aria-label={`${agent.name} 服务商`} value={executorCatalog.find((item) => item.id === (agent.executor ?? 'model-api'))?.provider || agent.provider} disabled={Boolean(executorCatalog.find((item) => item.id === (agent.executor ?? 'model-api'))?.provider)} onChange={(event) => { const provider = event.target.value as ModelProvider; onUpdateAgent(agent.id, { provider }); onToast(`${agent.name} 已切换为 ${provider}`) }}><option value="OpenAI">OpenAI</option><option value="Anthropic">Anthropic / Claude</option><option value="DeepSeek">DeepSeek</option><option value="OpenAI Compatible">OpenAI Compatible</option><option value="Local">本地模型</option></select></label><label>Model ID<input aria-label={`${agent.name} Model ID`} value={agent.model} placeholder={executorCatalog.find((item) => item.id === (agent.executor ?? 'model-api'))?.modelPlaceholder ?? '连接本机 API 后可查看该执行器的 Model ID 要求'} onChange={(event) => onUpdateAgent(agent.id, { model: event.target.value })} onBlur={() => onToast(`${agent.name} 的模型路由已保存`)} /></label></div><label className="executor-control">本岗位执行器<select aria-label={`${agent.name} 执行器`} value={agent.executor ?? 'model-api'} disabled={!executorCatalog.length} onChange={(event) => { const selected = executorCatalog.find((item) => item.id === event.target.value); if (!selected) return; const providerChanged = Boolean(selected.provider && selected.provider !== agent.provider); onUpdateAgent(agent.id, { executor: selected.id, ...(selected.provider ? { provider: selected.provider as ModelProvider } : {}), ...(selected.defaultModel && (providerChanged || !agent.model) ? { model: selected.defaultModel } : {}) }); onToast(`${agent.name} 已切换执行器`) }}>{executorCatalog.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select><small>{executorCatalog.find((item) => item.id === (agent.executor ?? 'model-api'))?.description ?? '连接本机 API 后可查看可用执行器。'}</small>{executorCatalog.find((item) => item.id === (agent.executor ?? 'model-api')) && <small>权限声明：项目读取 {executorCatalog.find((item) => item.id === (agent.executor ?? 'model-api'))!.capabilities.projectRead}；工作区访问 {executorCatalog.find((item) => item.id === (agent.executor ?? 'model-api'))!.capabilities.workspaceAccess}；文件写入 {executorCatalog.find((item) => item.id === (agent.executor ?? 'model-api'))!.capabilities.fileWrite}；命令 {executorCatalog.find((item) => item.id === (agent.executor ?? 'model-api'))!.capabilities.commandExecution}；网络 {executorCatalog.find((item) => item.id === (agent.executor ?? 'model-api'))!.capabilities.networkAccess}。</small>}</label><div className="agent-skill-summary"><div><span>已绑定 Skills</span><strong>{skills.length} 项</strong></div><div className="skill-chip-list">{skills.map((skill) => <span className={`skill-chip ${skill.tone}`} key={skill.id}>{skill.name}</span>)}</div><button className="text-button skill-manage-button" onClick={onOpenSkills}><Library size={13} />去 Skills 库管理<ArrowRight size={13} /></button></div><div className="team-card-divider" /><div className="team-card-foot"><span><strong>{assigned.length}</strong> 个进行中任务</span><span>{agent.provider}</span></div></article>
    })}</div>
    <section className="team-workflow"><div><span className="section-kicker">HANDOFF RULES <span className="kicker-line" /></span><h2>任务交接</h2><p>CEO 负责拆解与派单，专业岗位执行，测试 Agent 检查后由你验收。</p></div><div className="handoff-flow">{['CEO Agent', '专业 Agent', '测试 Agent', '你验收'].map((item, index) => <div className="handoff-node" key={item}><span className={`handoff-icon handoff-${index}`}>{index === 0 ? <Bot size={17} /> : index === 3 ? <ShieldCheck size={17} /> : index === 2 ? <CheckCheck size={17} /> : <Cpu size={17} />}</span><strong>{item}</strong>{index < 3 && <ArrowRight size={15} />}</div>)}</div></section>
  </>
}

function SkillsPage({ agents, onUpdateAgent, onToast }: { agents: AgentProfile[]; onUpdateAgent: (id: string, patch: Partial<AgentProfile>) => void; onToast: (message: string) => void }) {
  const skillUsage = (skillId: string) => agents.filter((agent) => agent.skillIds.includes(skillId))
  function toggleSkill(agent: AgentProfile, skill: SkillProfile) {
    const hasSkill = agent.skillIds.includes(skill.id)
    const skillIds = hasSkill ? agent.skillIds.filter((id) => id !== skill.id) : [...agent.skillIds, skill.id]
    onUpdateAgent(agent.id, { skillIds })
    onToast(`${agent.name} 已${hasSkill ? '移除' : '绑定'}「${skill.name}」`)
  }
  return <>
    <div className="page-heading inner-heading"><div><div className="eyebrow"><span className="eyebrow-dot" />SKILL LIBRARY & CONTEXT</div><h1>Skills 库</h1><p>把验证过的工作手册绑定到具体岗位，执行时按任务相关性选择上下文。</p></div><div className="team-status-pill"><Library size={15} />{skillCatalog.length} 个可用 Skills</div></div>
    <div className="routing-notice"><Library size={15} /><span><strong>技能绑定是岗位级配置</strong> 技能说明、工具权限和验证步骤会随 Agent 一起进入执行上下文；绑定关系保存在当前浏览器中。</span></div>
    <div className="skills-layout"><section className="skills-catalog"><div className="skills-section-head"><div><span className="section-kicker">CATALOG <span className="kicker-line" /></span><h2>可用 Skills</h2></div><span className="skills-count">{skillCatalog.length} 项</span></div><div className="skill-catalog-grid">{skillCatalog.map((skill) => <article className="skill-card" key={skill.id}><div className="skill-card-heading"><span className={`skill-icon ${skill.tone}`}><Sparkles size={14} /></span><span><strong>{skill.name}</strong><small>{skill.category}</small></span></div><p>{skill.description}</p><div className="skill-meta"><span><strong>适用范围</strong>{skill.scope}</span><span><strong>验证方式</strong>{skill.verification}</span></div><div className="skill-tools">{skill.tools.map((tool) => <code key={tool}>{tool}</code>)}</div><div className="skill-bindings"><span>已绑定 {skillUsage(skill.id).length} 个 Agent</span><div>{agents.map((agent) => { const bound = agent.skillIds.includes(skill.id); return <button className={`skill-agent-toggle ${bound ? 'skill-agent-toggle-on' : ''}`} key={agent.id} aria-pressed={bound} title={`${bound ? '取消' : '绑定'} ${agent.name}`} onClick={() => toggleSkill(agent, skill)}>{agent.initial}</button> })}</div></div></article>)}</div></section><aside className="skill-agent-rail"><div className="skills-section-head"><div><span className="section-kicker">BY AGENT <span className="kicker-line" /></span><h2>岗位技能矩阵</h2></div></div>{agents.map((agent) => { const skills = getSkills(agent.skillIds); return <div className="skill-agent-row" key={agent.id}><span className={`skill-agent-figure ${agent.tone}`}><AgentFigure agentId={agent.id} /></span><span className="skill-agent-copy"><strong>{agent.name}</strong><small>{agent.provider} · {agent.model}</small><span>{skills.length} 项技能 · {skills.map((skill) => skill.name).join('、')}</span></span></div> })}</aside></div>
  </>
}

function RunsPage({ runs }: { runs: RunLog[] }) {
  return <>
    <div className="page-heading inner-heading"><div><div className="eyebrow"><span className="eyebrow-dot" />ACTIVITY LOG</div><h1>执行记录</h1><p>查看团队每次交接和审批变更。</p></div><div className="team-status-pill"><Activity size={15} />{runs.length} 条记录</div></div>
    <section className="runs-panel"><div className="runs-panel-heading"><span>最近活动</span><span>时间</span></div>{runs.map((run, index) => <div className="run-row" key={run.id}><span className={`run-dot ${index === 0 ? 'run-dot-current' : ''}`} /><span className="run-agent-avatar">{run.agent.slice(0, 1)}</span><span className="run-copy"><strong>{run.agent}</strong><span>{run.action}</span><small>{run.taskTitle}</small></span><span className="run-time">{run.time}</span></div>)}{!runs.length && <EmptyState title="还没有执行记录" text="创建任务后，团队活动会显示在这里。" />}</section>
    <div className="data-footnote"><ShieldCheck size={14} />记录仅用于本地演示，不代表真实 Agent 执行</div>
  </>
}

function EmptyState({ title, text, onClick }: { title: string; text: string; onClick?: () => void }) {
  return <div className="empty-state"><span><Sparkles size={17} /></span><strong>{title}</strong><small>{text}</small>{onClick && <button className="text-button" onClick={onClick}>创建任务 <ArrowRight size={14} /></button>}</div>
}

function DeliveryDecisionControls({ busy, onDecide }: { busy: boolean; onDecide: (decision: DeliveryDecision, note?: string) => void }) {
  const [returning, setReturning] = useState(false)
  const [note, setNote] = useState('')
  return returning ? <>
    <label className="delivery-return-reason">退回原因<textarea autoFocus rows={2} maxLength={1000} value={note} onChange={(event) => setNote(event.target.value)} /></label>
    <button className="button-secondary" type="button" disabled={busy} onClick={() => setReturning(false)}>取消退回</button>
    <button className="button-primary" type="button" disabled={busy || !note.trim()} onClick={() => onDecide('return', note)}><ArrowDownRight size={16} />确认退回</button>
  </> : <>
    <button className="button-secondary" type="button" disabled={busy} onClick={() => setReturning(true)}><ArrowDownRight size={16} />退回修改</button>
    <button className="button-approve" type="button" disabled={busy} onClick={() => onDecide('approve')}><Check size={17} />确认交付</button>
  </>
}

function TaskDrawer({ task, agents, detail, busy, onRetry, onCancel, onDecide, onClose, onUpdate }: { task: Task; agents: AgentProfile[]; detail: WorkbenchTaskDetail | null; busy: boolean; onRetry: (task: WorkflowTask) => void; onCancel: (task: WorkflowTask) => void; onDecide: (taskId: string, reviewId: string, decision: DeliveryDecision, note?: string) => void; onClose: () => void; onUpdate: (task: Task, stage: Stage, message: string, agent?: string) => void }) {
  const nextStage = task.stage === 'research' ? 'writing' : task.stage === 'writing' ? 'review' : null
  const executionAgent = /后端|api|数据库|服务/i.test(`${task.title} ${task.kind} ${task.channel}`) ? '后端 Agent' : '前端 Agent'
  const workflowTask = detail?.task
  const workflowRuns = detail?.runs.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt)) ?? []
  const activeRun = [...workflowRuns].reverse().find((run) => run.status === 'queued' || run.status === 'running') ?? workflowRuns[workflowRuns.length - 1]
  const workflowRole = activeRun?.phase === 'ceo-plan' ? 'ceo' : activeRun?.phase === 'qa-review' ? 'qa' : task.stage === 'research' ? 'ceo' : task.stage === 'review' || task.stage === 'approved' ? 'qa' : 'specialist'
  const routedAgent = workflowRole === 'specialist'
    ? (workflowTask?.agents?.specialists ?? []).find((candidate) => candidate.id === activeRun?.agentId) ?? workflowTask?.agents?.specialist
    : workflowTask?.agents?.[workflowRole]
  const activeAgent = agents.find((agent) => agent.name === (task.stage === 'research' ? 'CEO Agent' : task.stage === 'review' ? '测试 Agent' : executionAgent)) ?? agents[0]
  const contextSkills = getSkills(activeAgent?.skillIds ?? [])
  const workflowSkillNames = routedAgent?.skills?.map((skill) => skill.name) ?? []
  const workflowReview = detail?.review
  const returned = workflowReview?.decision?.value === 'return'
  return <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <aside className="task-drawer" aria-label="任务详情">
      <div className="drawer-top"><span className="drawer-kicker"><FileText size={15} />任务详情</span><button className="icon-button" aria-label="关闭详情" onClick={onClose}><X size={19} /></button></div>
      <div className="drawer-body"><span className={`task-badge badge-${stageMeta[task.stage].color}`}><span />{taskStatusLabel(task)}</span><h2>{task.title}</h2><div className="drawer-metadata"><span><span className="owner-avatar owner-small">{task.ownerInitial}</span>{task.owner}</span><i /><span>{task.channel}</span><i /><span>{task.kind}</span></div>
        <div className="drawer-progress"><div><span>任务进度</span><strong>{task.progress}%</strong></div><span className="progress-track"><i style={{ width: `${task.progress}%` }} /></span></div>
        <section className="drawer-section"><div className="drawer-section-title"><h3>任务说明</h3><button className="icon-button subtle-icon" aria-label="更多任务选项"><MoreHorizontal size={17} /></button></div><p>{task.brief}</p></section>
        <section className="drawer-section"><div className="drawer-section-title"><h3>交付概览</h3><span className="source-count"><FileText size={14} />{task.sources} 个附件</span></div><div className="output-preview"><div className="output-preview-icon"><FileText size={17} /></div><span><strong>{task.stage === 'review' || task.stage === 'approved' ? '任务交付物' : task.stage === 'writing' ? '执行产物' : '任务计划'}</strong><small>{taskStatusLabel(task)}</small></span><ArrowUpRight size={15} /></div></section>
        <section className="drawer-section context-section"><div className="drawer-section-title"><h3>本次执行上下文</h3><span className="context-agent-label"><Cpu size={13} />{routedAgent?.name ?? activeAgent?.name}</span></div><p className="context-note">当前岗位的 Skills 会注入对应 Agent；文件与命令权限由项目授权范围单独控制。</p><div className="context-skill-list">{workflowTask ? workflowSkillNames.map((skill) => <span className="skill-chip" key={skill}>{skill}</span>) : contextSkills.map((skill) => <span className={`skill-chip ${skill.tone}`} key={skill.id}>{skill.name}</span>)}</div><div className="context-route"><span>模型路由</span><strong>{(routedAgent?.executor === 'codex-cli' || routedAgent?.executor === 'codex-app-server') ? `本机 Codex${routedAgent.executor === 'codex-app-server' ? ' App Server' : ' CLI'}${routedAgent.model ? ` / ${routedAgent.model}` : ''}` : routedAgent?.executor === 'claude-code' ? `本机 Claude Code CLI${routedAgent.model ? ` / ${routedAgent.model}` : ''}` : routedAgent?.executor === 'pi-cli' ? `本机 Pi CLI${routedAgent.model ? ` / ${routedAgent.model}` : ''}` : routedAgent?.executor === 'deepseek-api' ? `DeepSeek API${routedAgent.model ? ` / ${routedAgent.model}` : ''}` : routedAgent ? `${routedAgent.provider} / ${routedAgent.model}` : `${activeAgent?.provider} / ${activeAgent?.model}`}</strong></div>{workflowTask?.contextSnapshot?.length ? <div className="context-memory-snapshot"><strong>本次命中的长期资料（{workflowTask.contextSnapshot.length}）</strong>{workflowTask.contextSnapshot.map((entry) => <article key={entry.id}><span>{entry.scope === 'personal' ? '个人偏好' : '项目资料'} · {entry.title}</span><small>{entry.content}</small></article>)}</div> : workflowTask && <small className="context-memory-empty">本次任务没有命中长期上下文。</small>}</section>
         {workflowTask && <section className="drawer-section workflow-evidence"><div className="drawer-section-title"><h3>真实工作流证据</h3><span className="context-agent-label"><Radio size={13} />{workflowTask.status}</span></div><div className="workflow-evidence-grid"><div><span>项目目录</span><strong>{task.projectPath}</strong></div><div><span>运行阶段</span><strong>{workflowRuns.map((run) => run.phase).join(' → ') || '排队中'}</strong></div></div>{workflowTask.plan && <div className="workflow-result-block"><span>CEO 计划</span><pre>{JSON.stringify(workflowTask.plan, null, 2)}</pre></div>}{workflowTask.execution && <div className="workflow-result-block"><span>执行结果</span><pre>{JSON.stringify(workflowTask.execution, null, 2)}</pre></div>}{workflowReview && <div className={`workflow-review ${workflowReview.status === 'passed' ? 'review-pass' : 'review-fail'}`}><strong>测试 Agent：{workflowReview.status === 'passed' ? '独立验收通过' : '需要整改'}</strong><span>{workflowReview.summary}</span></div>}</section>}
        {workflowRuns.length > 0 && <section className="drawer-section"><h3>运行日志</h3>{workflowRuns.map((run) => <details className="workflow-result-block" key={run.id}><summary>{run.agentName} · {run.phase} · {run.status}</summary><pre>{[run.error, run.output, (run.events ?? []).map((event) => `${event.at ?? ''} ${event.message ?? event.type}`).join('\n')].filter(Boolean).join('\n\n')}</pre></details>)}</section>}
        <section className="drawer-section drawer-timeline"><h3>任务进展</h3>{stageOrder.map((stage, index) => { const reached = stageOrder.indexOf(task.stage) >= index; return <div className={`timeline-row ${reached ? 'timeline-reached' : ''}`} key={stage}><span className="timeline-node">{reached ? <Check size={11} /> : <span />}</span><span><strong>{stageMeta[stage].label}</strong><small>{stage === task.stage ? task.updated : reached ? '已完成' : '待开始'}</small></span>{index < 3 && <i className={reached ? 'timeline-line reached-line' : 'timeline-line'} />}</div>})}</section>
      </div>
      <div className="drawer-actions">
        {workflowTask ? <>
          {workflowTask.status === 'awaiting-approval' && workflowReview && workflowReview.id === workflowTask.reviewId && <DeliveryDecisionControls key={workflowReview.id} busy={busy} onDecide={(decision, note) => onDecide(workflowTask.id, workflowReview.id, decision, note)} />}
          {workflowTask.status === 'approved' && <div className="completed-banner"><CircleCheck size={17} />{workflowReview?.decision?.value === 'approve' ? `已人工确认交付 · ${new Date(workflowReview.decision.decidedAt).toLocaleString()}` : '历史交付 · 独立验收通过'}</div>}
          {workflowTask.status === 'cancelled' && <div className="workflow-status-note is-error"><strong>运行已取消</strong><span>取消前已完成的本机文件修改可能仍保留。</span></div>}
          {['failed', 'needs-fix'].includes(workflowTask.status) && <div className="workflow-status-note is-error">
            <strong>{returned ? '已人工退回' : workflowTask.status === 'failed' ? '工作流失败' : '验收需要整改'}</strong>
            <span>{returned ? workflowReview?.decision?.note : activeRun?.error ?? workflowReview?.summary ?? '请查看上方运行证据与验收记录。'}</span>
            <button className="button-primary drawer-advance" type="button" disabled={busy} onClick={() => onRetry(workflowTask)}><Sparkles size={16} />{busy ? '重新排队中…' : returned ? '重新执行' : '重试失败阶段'}<ArrowRight size={15} /></button>
          </div>}
          {activeRun && ['queued', 'running'].includes(activeRun.status) && <div className="workflow-status-note"><span className="demo-pulse" /><span>运行正在排队或执行。</span><button className="button-secondary" type="button" disabled={busy} onClick={() => onCancel(workflowTask)}><X size={15} />{busy ? '停止请求中…' : '取消运行'}</button></div>}
        </> : task.stage === 'review' ? <><button className="button-secondary" onClick={() => onUpdate(task, 'writing', '验收未通过，任务退回执行岗位', task.owner)}><ArrowDownRight size={16} />退回修改</button><button className="button-approve" onClick={() => onUpdate(task, 'approved', '交付物通过人工验收', '林同学')}><Check size={17} />通过验收</button></> : task.stage === 'approved' ? <div className="completed-banner"><CircleCheck size={17} />已通过人工验收</div> : <button className="button-primary drawer-advance" onClick={() => nextStage && onUpdate(task, nextStage, nextStage === 'review' ? '执行完成，交给测试 Agent 验收' : `CEO 拆解完成，派发给 ${executionAgent}`, nextStage === 'review' ? '测试 Agent' : executionAgent)}><Sparkles size={16} />模拟推进到{nextStage ? stageMeta[nextStage].label : ''}<ArrowRight size={15} /></button>}
         <small className="drawer-demo-note">{task.workflowTaskId ? '状态来自本地队列、模型调用与项目授权执行记录' : '演示推进只更新本地界面，不会触发真实模型调用'}</small>
      </div>
    </aside>
  </div>
}

function CreateModal({ busy, agents, onClose, onCreate }: { busy: boolean; agents: AgentProfile[]; onClose: () => void; onCreate: (title: string, brief: string, channel: string, projectPath: string, accessMode: ProjectAccessMode, allowedCommands: string[], verificationCommands: string[], specialistIds: string[]) => void }) {
  const [title, setTitle] = useState('')
  const [brief, setBrief] = useState('')
  const [channel, setChannel] = useState('全栈开发')
  const [specialistIds, setSpecialistIds] = useState(['frontend', 'backend'])
  const [projectPath, setProjectPath] = useState('E:\\codexs')
  const [accessMode, setAccessMode] = useState<ProjectAccessMode>('read-only')
  const [allowedCommands, setAllowedCommands] = useState('pnpm lint\npnpm build')
  const [verificationCommands, setVerificationCommands] = useState('pnpm test')
  const canSubmit = title.trim().length > 0
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><form className="create-modal" onSubmit={(event) => { event.preventDefault(); if (canSubmit) onCreate(title.trim(), brief.trim(), channel, projectPath.trim(), accessMode, allowedCommands.split(/\r?\n/).map((command) => command.trim()).filter(Boolean), verificationCommands.split(/\r?\n/).map((command) => command.trim()).filter(Boolean), specialistIds) }}>
    <div className="modal-heading"><div><span className="modal-icon"><Plus size={18} /></span><span><small>NEW WORKFLOW</small><h2>派发新任务</h2></span></div><button className="icon-button" type="button" aria-label="关闭创建任务" onClick={onClose}><X size={19} /></button></div>
    <p className="modal-intro">先写清楚目标与交付标准，CEO Agent 会拆解并派发给对应岗位。</p>
    <label className="form-label">任务目标 <span>必填</span><input autoFocus maxLength={80} placeholder="例如：给后台新增用户权限管理页面和 API" value={title} onChange={(event) => setTitle(event.target.value)} /></label>
    <label className="form-label">验收标准与背景 <span>选填</span><textarea rows={4} maxLength={500} placeholder="说明技术栈、边界条件、需要交付的文件或验收方式……" value={brief} onChange={(event) => setBrief(event.target.value)} /></label>
    <label className="form-label">任务方向<select value={channel} onChange={(event) => { const next = event.target.value; setChannel(next); setSpecialistIds(next === '全栈开发' ? ['frontend', 'backend'] : next === '前端开发' ? ['frontend'] : next === '后端开发' ? ['backend'] : next === 'Agent 研究' ? ['research'] : ['ops']) }}><option>全栈开发</option><option>前端开发</option><option>后端开发</option><option>Agent 研究</option><option>内容与运营</option></select></label>
    <fieldset className="specialist-picker"><legend>参与执行的专业 Agent</legend><div>{agents.filter((agent) => agent.id !== 'ceo' && agent.id !== 'qa').map((agent) => <label key={agent.id}><input type="checkbox" checked={specialistIds.includes(agent.id)} onChange={(event) => setSpecialistIds((current) => event.target.checked ? [...current, agent.id] : current.filter((id) => id !== agent.id))} /><span>{agent.name}</span></label>)}</div><small>CEO 会按计划决定执行顺序；当前版本依次共享同一工作区，避免并行写入冲突。</small></fieldset>
    <div className="form-grid"><label className="form-label">授权项目目录<input value={projectPath} onChange={(event) => setProjectPath(event.target.value)} placeholder="例如：E:\\codexs" /></label><label className="form-label">访问范围<select value={accessMode} onChange={(event) => setAccessMode(event.target.value as ProjectAccessMode)}><option value="read-only">只读分析</option><option value="write">允许写文件</option><option value="execute">允许写文件并执行白名单命令</option></select></label></div>
    <label className="form-label">允许 Agent 调用的普通命令 <span>模型 API 执行器的精确命令白名单；Codex 沙箱不能替代命令审查</span><textarea rows={2} value={allowedCommands} onChange={(event) => setAllowedCommands(event.target.value)} placeholder="pnpm lint&#10;pnpm build" /></label>
    <label className="form-label">独立验收命令 <span>execute 模式下由 QA 独立运行；失败或未配置都会阻止通过</span><textarea rows={2} value={verificationCommands} onChange={(event) => setVerificationCommands(event.target.value)} placeholder="pnpm test&#10;pnpm build" /></label>
    <div className="modal-flow-note"><span className="demo-pulse" /><span>首先交给 <strong>CEO Agent</strong> 拆解任务</span><span className="flow-note-arrow"><ArrowRight size={14} /> 专业岗位执行 <ArrowRight size={14} /> 你验收</span></div>
    <div className="modal-actions"><button className="button-secondary" type="button" onClick={onClose} disabled={busy}>取消</button><button className="button-primary" type="submit" disabled={!canSubmit || busy}><Send size={15} />{busy ? '启动中…' : '派发任务'}</button></div>
  </form></div>
}

export default App
