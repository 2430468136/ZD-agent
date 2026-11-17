import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Bell,
  Bot,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Command,
  Cpu,
  FileText,
  GitBranch,
  LayoutDashboard,
  ListChecks,
  Menu,
  MoreHorizontal,
  Network,
  Pause,
  Plus,
  Play,
  Radio,
  ScanLine,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Terminal,
  UsersRound,
  Workflow,
  X,
} from 'lucide-react'
import type { ProviderId } from './provider-client'
import ProviderSettings from './ProviderSettings'
import AgentFigure from './AgentFigure'
import './App.css'

type Stage = 'research' | 'writing' | 'review' | 'approved'
type Page = 'overview' | 'tasks' | 'team' | 'runs' | 'settings'
type ModelProvider = ProviderId

type AgentProfile = {
  id: string
  name: string
  role: string
  initial: string
  tone: string
  provider: ModelProvider
  model: string
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
}

type RunLog = {
  id: string
  taskTitle: string
  agent: string
  action: string
  time: string
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
  { id: 'ceo', name: 'CEO Agent', role: '目标拆解 · 任务调度', initial: 'CEO', tone: 'agent-yellow', provider: 'OpenAI', model: 'gpt', status: '统筹中', online: true },
  { id: 'frontend', name: '前端 Agent', role: 'React · UI · 浏览器交互', initial: '前', tone: 'agent-blue', provider: 'DeepSeek', model: 'deepseek-chat', status: '执行中', online: true },
  { id: 'backend', name: '后端 Agent', role: 'API · 数据库 · 服务逻辑', initial: '后', tone: 'agent-lilac', provider: 'OpenAI', model: 'gpt', status: '执行中', online: true },
  { id: 'qa', name: '测试 Agent', role: '测试用例 · 验收 · 回归', initial: '测', tone: 'agent-coral', provider: 'Anthropic', model: 'claude', status: '待验收', online: true },
  { id: 'research', name: '研究 Agent', role: '资料检索 · 方案比较', initial: '研', tone: 'agent-cyan', provider: 'DeepSeek', model: 'deepseek-chat', status: '空闲', online: true },
  { id: 'design', name: '设计 Agent', role: '交互结构 · 视觉规范', initial: '设', tone: 'agent-pink', provider: 'Anthropic', model: 'claude', status: '空闲', online: true },
  { id: 'ops', name: '运营 Agent', role: '发布 · 监控 · 复盘', initial: '运', tone: 'agent-green', provider: 'OpenAI Compatible', model: 'model-id', status: '离线', online: false },
]

function readStorage<T,>(key: string, fallback: T): T {
  try {
    const saved = window.localStorage.getItem(key)
    return saved ? (JSON.parse(saved) as T) : fallback
  } catch {
    return fallback
  }
}

function timeLabel() {
  return new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date())
}

function App() {
  const [tasks, setTasks] = useState<Task[]>(() => readStorage(taskKey, seedTasks))
  const [runs, setRuns] = useState<RunLog[]>(() => readStorage(logKey, seedRuns))
  const [agents, setAgents] = useState<AgentProfile[]>(() => readStorage(agentKey, seedAgents))
  const [page, setPage] = useState<Page>('overview')
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | Stage>('all')
  const [toast, setToast] = useState('')
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [dispatchPaused, setDispatchPaused] = useState(false)
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? null
  const reviewTasks = tasks.filter((task) => task.stage === 'review')
  const activeTasks = tasks.filter((task) => task.stage !== 'approved')
  const filteredTasks = useMemo(() => {
    const query = search.trim().toLowerCase()
    return tasks.filter((task) => {
      const matchesStage = filter === 'all' || task.stage === filter
      const matchesQuery = !query || `${task.title} ${task.brief} ${task.channel} ${task.owner}`.toLowerCase().includes(query)
      return matchesStage && matchesQuery
    })
  }, [filter, search, tasks])

  useEffect(() => window.localStorage.setItem(taskKey, JSON.stringify(tasks)), [tasks])
  useEffect(() => window.localStorage.setItem(logKey, JSON.stringify(runs)), [runs])
  useEffect(() => window.localStorage.setItem(agentKey, JSON.stringify(agents)), [agents])
  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 3000)
    return () => window.clearTimeout(timer)
  }, [toast])

  function addRun(task: Task, agent: string, action: string) {
    setRuns((current) => [{ id: `r-${Date.now()}`, taskTitle: task.title, agent, action, time: '刚刚' }, ...current])
  }

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

  function createTask(title: string, brief: string, channel: string) {
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
    setTasks((current) => [task, ...current])
    addRun(task, 'CEO Agent', '拆解目标并加入待分派队列')
    setCreateOpen(false)
    setPage('tasks')
    setFilter('all')
    setToast('任务已交给 CEO Agent 拆解')
  }

  function navigate(next: Page) {
    setPage(next)
    setMobileNavOpen(false)
    if (next !== 'tasks') setFilter('all')
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
          <NavItem icon={<Workflow size={18} />} label="任务流水线" count={activeTasks.length} active={page === 'tasks'} onClick={() => navigate('tasks')} />
          <NavItem icon={<UsersRound size={18} />} label="Agent 团队" active={page === 'team'} onClick={() => navigate('team')} />
          <NavItem icon={<ListChecks size={18} />} label="执行记录" active={page === 'runs'} onClick={() => navigate('runs')} />
        </nav>
        <div className="nav-label nav-label-spaced">偏好设置</div>
        <nav className="primary-nav" aria-label="偏好设置">
          <NavItem icon={<Settings2 size={18} />} label="模型接入" active={page === 'settings'} onClick={() => navigate('settings')} />
        </nav>
        <div className="sidebar-bottom">
          <div className="demo-note"><span className="demo-pulse" /><span><strong>本地演示模式</strong><small>Agent 执行为模拟数据</small></span></div>
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
            <button className="icon-button mobile-menu" aria-label="打开导航" onClick={() => setMobileNavOpen(true)}><Menu size={19} /></button>
            <div className="breadcrumbs"><span>栖光工作室</span><ChevronRight size={14} /><strong>{pageLabel(page)}</strong></div>
          </div>
          <div className="topbar-actions">
            <div className="demo-chip"><span className="demo-pulse" />演示环境</div>
            <button className="search-trigger" onClick={() => document.getElementById('global-search')?.focus()}><Search size={15} /><span>搜索任务</span><kbd><Command size={11} /> K</kbd></button>
            <button className="icon-button notification-button" aria-label="查看待审批" onClick={() => { setPage('tasks'); setFilter('review') }}>
              <Bell size={18} />{reviewTasks.length > 0 && <span className="notification-dot" />}
            </button>
            <div className="topbar-avatar">林</div>
          </div>
        </header>

        <div className="page-content">
          {page === 'overview' && <WarRoom tasks={tasks} runs={runs} reviewTasks={reviewTasks} agents={agents} paused={dispatchPaused} onTogglePaused={() => setDispatchPaused((value) => !value)} onCreate={() => setCreateOpen(true)} onSelect={setSelectedTaskId} onNavigate={navigate} />}
          {page === 'tasks' && <TasksPage tasks={filteredTasks} filter={filter} setFilter={setFilter} search={search} setSearch={setSearch} onCreate={() => setCreateOpen(true)} onSelect={setSelectedTaskId} />}
          {page === 'team' && <TeamPage tasks={tasks} agents={agents} onUpdateAgent={updateAgent} onToast={setToast} />}
          {page === 'runs' && <RunsPage runs={runs} />}
          {page === 'settings' && <ProviderSettings agents={agents} onNavigate={navigate} />}
          <footer className="page-footer"><span>织点 AI 工作团队</span><span><ShieldCheck size={13} /> 任务数据保存在浏览器，API Key 由本地服务加密保存</span></footer>
        </div>
      </main>

      {mobileNavOpen && <button className="mobile-scrim" aria-label="关闭导航" onClick={() => setMobileNavOpen(false)} />}
      {selectedTask && <TaskDrawer task={selectedTask} onClose={() => setSelectedTaskId(null)} onUpdate={updateStage} />}
      {createOpen && <CreateModal onClose={() => setCreateOpen(false)} onCreate={createTask} />}
      {toast && <div className="toast"><CircleCheck size={17} />{toast}</div>}
    </div>
  )
}

function pageLabel(page: Page) {
  return ({ overview: '作战大屏', tasks: '任务流水线', team: 'Agent 团队', runs: '执行记录', settings: '模型接入' })[page]
}

function NavItem({ icon, label, active, count, onClick }: { icon: React.ReactNode; label: string; active: boolean; count?: number; onClick: () => void }) {
  return <button className={`nav-item ${active ? 'nav-item-active' : ''}`} onClick={onClick}>{icon}<span>{label}</span>{count !== undefined && <small className="nav-count">{count}</small>}</button>
}

function WarRoom({ tasks, runs, reviewTasks, agents, paused, onTogglePaused, onCreate, onSelect, onNavigate }: { tasks: Task[]; runs: RunLog[]; reviewTasks: Task[]; agents: AgentProfile[]; paused: boolean; onTogglePaused: () => void; onCreate: () => void; onSelect: (id: string) => void; onNavigate: (page: Page) => void }) {
  const activeCount = tasks.filter((task) => task.stage !== 'approved').length
  const doneCount = tasks.filter((task) => task.stage === 'approved').length
  const onlineCount = agents.filter((agent) => agent.online).length
  return <div className="war-room">
    <div className="war-heading"><div><div className="war-eyebrow"><span className="war-live-dot" />AI TEAM OPERATIONS <i /> LOCAL SIMULATION</div><h1>AI Agent 作战中心</h1><p>CEO 统筹任务，专业 Agent 并行协作，你保留最终验收权。</p></div><div className="war-controls"><span className="war-clock">{timeLabel()}</span><button className={`war-control ${paused ? 'control-paused' : ''}`} aria-pressed={paused} onClick={onTogglePaused}>{paused ? <Play size={14} /> : <Pause size={14} />}{paused ? '恢复调度' : '暂停调度'}</button><button className="war-create" onClick={onCreate}><Plus size={15} />派发任务</button></div></div>
    <section className="agent-console" aria-label="Agent 实时状态">{agents.map((agent) => <AgentConsoleCard key={agent.id} agent={agent} tasks={tasks} onClick={() => onNavigate('team')} />)}</section>
    <div className="war-main-grid">
      <section className="battle-map-panel"><div className="battle-panel-head"><div><div className="war-kicker"><Network size={13} /> LIVE ORCHESTRATION MAP</div><h2>团队协作网络</h2></div><div className="map-legend"><span><i className="legend-active" />执行链路</span><span><i className="legend-idle" />待命</span></div></div><TacticalMap agents={agents} onConfigure={() => onNavigate('team')} /><div className="map-footer"><span><Radio size={12} /> {onlineCount} AGENTS ONLINE</span><span><GitBranch size={12} /> {activeCount} ACTIVE TASKS</span><span className="simulated-data-label">数据为本地模拟</span></div></section>
      <aside className="war-side-rail"><section className="war-side-panel live-feed-panel"><div className="war-panel-heading"><div><div className="war-kicker"><span className="war-live-dot" />LIVE FEED</div><h2>实时动态</h2></div><button className="war-link" onClick={() => onNavigate('runs')}>全部 <ArrowUpRight size={13} /></button></div><div className="live-feed-list">{runs.slice(0, 5).map((run) => <div className="live-feed-row" key={run.id}><span className="feed-time">{run.time}</span><span className="feed-agent">{run.agent.replace(' Agent', '').toUpperCase()}</span><span className="feed-action"><strong>{run.action}</strong><small>{run.taskTitle}</small></span></div>)}</div></section>
        <section className="war-side-panel runtime-panel"><div className="war-panel-heading"><div><div className="war-kicker"><Cpu size={13} />RUNTIME SNAPSHOT</div><h2>运行概况</h2></div><span className="simulation-pill">模拟统计</span></div><div className="runtime-grid"><RuntimeValue label="在线员工" value={`${onlineCount}/${agents.length}`} tone="cyan" /><RuntimeValue label="执行任务" value={activeCount} tone="lime" /><RuntimeValue label="待验收" value={reviewTasks.length} tone="orange" /><RuntimeValue label="已交付" value={doneCount} tone="pink" /></div><button className="route-summary-link" onClick={() => onNavigate('team')}><span><Cpu size={14} />模型路由配置</span><span>{new Set(agents.map((agent) => agent.provider)).size} 个服务商 <ChevronRight size={13} /></span></button></section></aside>
    </div>
    <div className="war-bottom-grid"><section className="war-bottom-panel acceptance-panel"><div className="war-panel-heading"><div><div className="war-kicker"><ShieldCheck size={13} />HUMAN GATE</div><h2>验收队列 <span className="queue-count">{reviewTasks.length}</span></h2></div><button className="war-link" onClick={() => { onNavigate('tasks') }}>任务列表 <ArrowUpRight size={13} /></button></div>{reviewTasks.slice(0, 3).map((task) => <button className="acceptance-row" key={task.id} onClick={() => onSelect(task.id)}><span className="acceptance-marker" /><span><strong>{task.title}</strong><small>{task.owner} · {task.updated}</small></span><span className="acceptance-action">查看 <ArrowRight size={13} /></span></button>)}{!reviewTasks.length && <div className="war-empty">验收队列为空，所有交付都已处理。</div>}</section>
      <section className="war-bottom-panel route-board"><div className="war-panel-heading"><div><div className="war-kicker"><GitBranch size={13} />MODEL ROUTING</div><h2>员工模型路由</h2></div><button className="war-link" onClick={() => onNavigate('team')}>配置 <ArrowUpRight size={13} /></button></div><div className="route-board-list">{agents.slice(0, 5).map((agent) => <div className="route-board-row" key={agent.id}><span className={`mini-agent-icon ${agent.tone}`}>{agent.initial.slice(0, 1)}</span><strong>{agent.name}</strong><span className="route-provider">{agent.provider}</span><code>{agent.model || '未填写模型'}</code></div>)}</div><div className="route-footnote"><ShieldCheck size={12} />仅保存路由偏好；尚未连接模型 API</div></section>
      <section className="war-bottom-panel dispatch-panel"><div className="war-panel-heading"><div><div className="war-kicker"><ScanLine size={13} />DISPATCH POLICY</div><h2>调度规则</h2></div><span className={`rule-state ${paused ? 'rule-state-paused' : ''}`}><i />{paused ? '已暂停' : '运行中'}</span></div><div className="dispatch-rule"><span className="rule-number">01</span><span><strong>CEO Agent 接收目标</strong><small>{paused ? '新任务留在队列，恢复后再进行分派' : '拆解子任务并匹配专业员工'}</small></span></div><div className="dispatch-rule"><span className="rule-number">02</span><span><strong>按员工路由到指定模型</strong><small>每个 Agent 独立配置服务商与 model ID</small></span></div><div className="dispatch-rule"><span className="rule-number">03</span><span><strong>人工验收后才算交付</strong><small>未经确认的结果不会标记为完成</small></span></div><button className="dispatch-cta" onClick={onCreate}><Terminal size={14} />创建一个新任务 <ArrowRight size={13} /></button></section></div>
  </div>
}

function AgentConsoleCard({ agent, tasks, onClick }: { agent: AgentProfile; tasks: Task[]; onClick: () => void }) {
  const assigned = tasks.filter((task) => task.owner === agent.name && task.stage !== 'approved')
  const progress = assigned[0]?.progress ?? (agent.online ? 0 : 0)
  return <button className="agent-console-card" onClick={onClick}><span className={`console-avatar ${agent.tone}`}><AgentFigure agentId={agent.id} /><i className={agent.online ? 'online' : ''} /></span><span className="console-main"><span className="console-role">{agent.name}<small>{agent.online ? agent.status : 'OFFLINE'}</small></span><span className="console-model"><span className="provider-mark">{providerShort(agent.provider)}</span>{agent.model}</span><span className="console-progress"><i><b style={{ width: `${progress}%` }} /></i><small>{assigned.length ? `${progress}%` : agent.online ? 'IDLE' : 'OFF'}</small></span></span><ChevronRight size={13} className="console-chevron" /></button>
}

function TacticalMap({ agents, onConfigure }: { agents: AgentProfile[]; onConfigure: () => void }) {
  const positions: Array<{ id: string; x: number; y: number; label: string; status: string }> = [
    { id: 'research', x: 150, y: 175, label: 'RESEARCH', status: 'SCOUT' },
    { id: 'design', x: 325, y: 192, label: 'DESIGN', status: 'PLAN' },
    { id: 'frontend', x: 520, y: 178, label: 'FRONTEND', status: 'BUILD' },
    { id: 'backend', x: 725, y: 180, label: 'BACKEND', status: 'BUILD' },
    { id: 'qa', x: 470, y: 335, label: 'QA / TEST', status: 'VERIFY' },
    { id: 'ops', x: 710, y: 335, label: 'OPS', status: 'STANDBY' },
  ]
  const ceo = agents.find((agent) => agent.id === 'ceo')
  const getAgent = (id: string) => agents.find((agent) => agent.id === id)
  return <div className="tactical-map"><svg viewBox="0 0 860 410" role="img" aria-label="CEO Agent 向各专业 Agent 派发任务的协作网络">
    <defs><pattern id="map-grid" width="28" height="28" patternUnits="userSpaceOnUse"><path d="M 28 0 L 0 0 0 28" fill="none" stroke="#25333a" strokeWidth=".65" /></pattern><filter id="node-glow" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="5" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter></defs>
    <rect width="860" height="410" fill="url(#map-grid)" />
    <path className="route-path route-primary" d="M430 105 C370 124 240 128 150 145" /><path className="route-path route-primary" d="M430 105 C395 130 360 136 325 162" /><path className="route-path route-live" d="M430 105 C465 132 495 136 520 148" /><path className="route-path route-live" d="M430 105 C535 124 643 122 725 150" /><path className="route-path route-primary" d="M430 105 C445 180 455 235 470 302" /><path className="route-path route-idle" d="M430 105 C540 166 642 232 710 302" /><path className="route-path route-live" d="M520 205 C510 245 495 272 478 301" /><path className="route-path route-live" d="M725 207 C655 246 565 277 490 306" />
    <g className="map-task-chip" transform="translate(245 113)"><rect width="118" height="24" rx="4" /><text x="10" y="16">T-204 · REVIEW</text></g><g className="map-task-chip map-task-chip-alt" transform="translate(565 235)"><rect width="120" height="24" rx="4" /><text x="10" y="16">T-203 · API ROUTE</text></g><g className="map-task-chip" transform="translate(340 258)"><rect width="120" height="24" rx="4" /><text x="10" y="16">T-202 · UI BUILD</text></g>
    {ceo && <AgentMapNode agent={ceo} x={430} y={75} chief onClick={onConfigure} />}
    {positions.map((position) => { const agent = getAgent(position.id); return agent ? <AgentMapNode key={position.id} agent={agent} x={position.x} y={position.y} label={position.label} status={position.status} onClick={onConfigure} /> : null })}
    <g className="map-caption"><text x="20" y="29">ORCHESTRATION / GRAPH 01</text><text x="840" y="29" textAnchor="end">LOCAL · SIMULATED</text></g>
  </svg></div>
}

function AgentMapNode({ agent, x, y, chief = false, label, status, onClick }: { agent: AgentProfile; x: number; y: number; chief?: boolean; label?: string; status?: string; onClick: () => void }) {
  return <g className={`map-node ${agent.tone} ${agent.online ? 'map-node-online' : 'map-node-offline'} ${chief ? 'map-node-chief' : ''}`} transform={`translate(${x} ${y})`} role="button" tabIndex={0} aria-label={`${agent.name}, ${agent.provider} ${agent.model}`} onClick={onClick} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onClick() }}><circle className="node-halo" r={chief ? 43 : 34} /><circle className="node-ring" r={chief ? 32 : 25} /><circle className="node-core" r={chief ? 24 : 18} /><text className="node-initial" y="4">{agent.initial}</text><circle className="node-status" cx={chief ? 23 : 18} cy={chief ? -22 : -17} r="4" /><text className="node-name" y={chief ? 54 : 48}>{label ?? agent.name.toUpperCase()}</text><text className="node-role" y={chief ? 68 : 62}>{status ?? `${providerShort(agent.provider)} · ${agent.model}`}</text></g>
}

function RuntimeValue({ label, value, tone }: { label: string; value: string | number; tone: string }) {
  return <div className={`runtime-value runtime-${tone}`}><span>{label}</span><strong>{value}</strong></div>
}

function providerShort(provider: ModelProvider) {
  return provider === 'Anthropic' ? 'ANTHROPIC' : provider === 'OpenAI Compatible' ? 'OPENAI-COMPAT' : provider.toUpperCase()
}

function TasksPage({ tasks, filter, setFilter, search, setSearch, onCreate, onSelect }: { tasks: Task[]; filter: 'all' | Stage; setFilter: (value: 'all' | Stage) => void; search: string; setSearch: (value: string) => void; onCreate: () => void; onSelect: (id: string) => void }) {
  const filters: Array<{ id: 'all' | Stage; label: string }> = [{ id: 'all', label: '全部' }, ...stageOrder.map((stage) => ({ id: stage, label: stageMeta[stage].label }))]
  return <>
    <div className="page-heading inner-heading"><div><div className="eyebrow"><span className="eyebrow-dot" />TASK OPERATIONS</div><h1>任务流水线</h1><p>从 CEO 拆解目标到专业 Agent 执行，再由你验收交付。</p></div><button className="button-primary" onClick={onCreate}><Plus size={17} />派发任务</button></div>
    <div className="task-toolbar"><div className="filter-tabs">{filters.map((item) => <button className={filter === item.id ? 'filter-tab active-filter' : 'filter-tab'} key={item.id} onClick={() => setFilter(item.id)}>{item.label}</button>)}</div><label className="task-search"><Search size={16} /><input id="global-search" placeholder="搜索标题、渠道或 Agent" value={search} onChange={(event) => setSearch(event.target.value)} /><kbd>/</kbd></label></div>
    <section className="pipeline-list">
      <div className="pipeline-list-head"><span>任务 / 选题</span><span>负责人</span><span>进度</span><span>截止时间</span><span /></div>
      {tasks.map((task) => <PipelineRow key={task.id} task={task} onClick={() => onSelect(task.id)} />)}
      {!tasks.length && <div className="empty-pipeline"><Search size={22} /><strong>没有找到匹配任务</strong><span>试试其他关键词，或调整状态筛选。</span></div>}
    </section>
    <div className="data-footnote"><ShieldCheck size={14} />显示当前浏览器中保存的演示任务</div>
  </>
}

function PipelineRow({ task, onClick }: { task: Task; onClick: () => void }) {
  return <button className="pipeline-row" onClick={onClick}><span className="pipeline-title"><span className={`pipeline-marker marker-${stageMeta[task.stage].color}`} /><span><strong>{task.title}</strong><small>{task.kind} <i /> {task.channel}</small></span></span><span className="pipeline-owner"><span className="owner-avatar owner-small">{task.ownerInitial}</span>{task.owner}</span><span className="pipeline-progress"><span className="progress-track"><i style={{ width: `${task.progress}%` }} /></span><small>{task.progress}%</small></span><span className="pipeline-due">{task.due}</span><ChevronRight size={16} className="pipeline-chevron" /></button>
}

function TeamPage({ tasks, agents, onUpdateAgent, onToast }: { tasks: Task[]; agents: AgentProfile[]; onUpdateAgent: (id: string, patch: Partial<AgentProfile>) => void; onToast: (message: string) => void }) {
  return <>
    <div className="page-heading inner-heading"><div><div className="eyebrow"><span className="eyebrow-dot" />TEAM & MODEL ROUTING</div><h1>Agent 团队</h1><p>按岗位配置不同模型：CEO、前端、后端和测试可以各走各的服务商。</p></div><div className="team-status-pill"><span className="demo-pulse" />{agents.filter((agent) => agent.online).length} 个 Agent 在线</div></div>
    <div className="routing-notice"><Cpu size={15} /><span><strong>模型路由草稿</strong> 当前只保存岗位到服务商 / model ID 的映射，尚未配置 API Key，也不会发起真实模型调用。</span></div>
    <div className="team-grid">{agents.map((agent) => {
      const assigned = tasks.filter((task) => task.owner === agent.name && task.stage !== 'approved')
      return <article className="team-card route-agent-card" key={agent.id}><div className="team-card-top"><span className={`team-character ${agent.tone}`}><AgentFigure agentId={agent.id} /><i className={agent.online ? 'online' : ''} /></span><span className={`agent-online-label ${agent.online ? 'state-online' : ''}`}><i />{agent.online ? '在线' : '离线'}</span></div><div className="team-role">{agent.role}</div><h2>{agent.name}</h2><div className="route-controls"><label>模型服务商<select aria-label={`${agent.name} 服务商`} value={agent.provider} onChange={(event) => { const provider = event.target.value as ModelProvider; onUpdateAgent(agent.id, { provider }); onToast(`${agent.name} 已切换为 ${provider}`) }}><option value="OpenAI">OpenAI</option><option value="Anthropic">Anthropic / Claude</option><option value="DeepSeek">DeepSeek</option><option value="OpenAI Compatible">OpenAI Compatible</option><option value="Local">本地模型</option></select></label><label>Model ID<input aria-label={`${agent.name} Model ID`} value={agent.model} placeholder="填写服务商要求的 model ID" onChange={(event) => onUpdateAgent(agent.id, { model: event.target.value })} onBlur={() => onToast(`${agent.name} 的模型路由已保存`)} /></label></div><div className="team-card-divider" /><div className="team-card-foot"><span><strong>{assigned.length}</strong> 个进行中任务</span><span>{agent.provider}</span></div></article>
    })}</div>
    <section className="team-workflow"><div><span className="section-kicker">HANDOFF RULES <span className="kicker-line" /></span><h2>任务交接</h2><p>CEO 负责拆解与派单，专业岗位执行，测试 Agent 检查后由你验收。</p></div><div className="handoff-flow">{['CEO Agent', '专业 Agent', '测试 Agent', '你验收'].map((item, index) => <div className="handoff-node" key={item}><span className={`handoff-icon handoff-${index}`}>{index === 0 ? <Bot size={17} /> : index === 3 ? <ShieldCheck size={17} /> : index === 2 ? <CheckCheck size={17} /> : <Cpu size={17} />}</span><strong>{item}</strong>{index < 3 && <ArrowRight size={15} />}</div>)}</div></section>
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

function TaskDrawer({ task, onClose, onUpdate }: { task: Task; onClose: () => void; onUpdate: (task: Task, stage: Stage, message: string, agent?: string) => void }) {
  const nextStage = task.stage === 'research' ? 'writing' : task.stage === 'writing' ? 'review' : null
  const executionAgent = /后端|api|数据库|服务/i.test(`${task.title} ${task.kind} ${task.channel}`) ? '后端 Agent' : '前端 Agent'
  return <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <aside className="task-drawer" aria-label="任务详情">
      <div className="drawer-top"><span className="drawer-kicker"><FileText size={15} />任务详情</span><button className="icon-button" aria-label="关闭详情" onClick={onClose}><X size={19} /></button></div>
      <div className="drawer-body"><span className={`task-badge badge-${stageMeta[task.stage].color}`}><span />{stageMeta[task.stage].label}</span><h2>{task.title}</h2><div className="drawer-metadata"><span><span className="owner-avatar owner-small">{task.ownerInitial}</span>{task.owner}</span><i /><span>{task.channel}</span><i /><span>{task.kind}</span></div>
        <div className="drawer-progress"><div><span>任务进度</span><strong>{task.progress}%</strong></div><span className="progress-track"><i style={{ width: `${task.progress}%` }} /></span></div>
        <section className="drawer-section"><div className="drawer-section-title"><h3>任务说明</h3><button className="icon-button subtle-icon" aria-label="更多任务选项"><MoreHorizontal size={17} /></button></div><p>{task.brief}</p></section>
        <section className="drawer-section"><div className="drawer-section-title"><h3>交付概览</h3><span className="source-count"><FileText size={14} />{task.sources} 个附件</span></div><div className="output-preview"><div className="output-preview-icon"><FileText size={17} /></div><span><strong>{task.stage === 'review' || task.stage === 'approved' ? '任务交付物' : task.stage === 'writing' ? '执行产物' : '任务计划'}</strong><small>{task.stage === 'review' ? '已完成 · 等待人工验收' : task.stage === 'approved' ? '已通过验收并交付' : `当前阶段 · ${stageMeta[task.stage].label}`}</small></span><ArrowUpRight size={15} /></div></section>
        <section className="drawer-section drawer-timeline"><h3>任务进展</h3>{stageOrder.map((stage, index) => { const reached = stageOrder.indexOf(task.stage) >= index; return <div className={`timeline-row ${reached ? 'timeline-reached' : ''}`} key={stage}><span className="timeline-node">{reached ? <Check size={11} /> : <span />}</span><span><strong>{stageMeta[stage].label}</strong><small>{stage === task.stage ? task.updated : reached ? '已完成' : '待开始'}</small></span>{index < 3 && <i className={reached ? 'timeline-line reached-line' : 'timeline-line'} />}</div>})}</section>
      </div>
      <div className="drawer-actions">
        {task.stage === 'review' ? <><button className="button-secondary" onClick={() => onUpdate(task, 'writing', '验收未通过，任务退回执行岗位', task.owner)}><ArrowDownRight size={16} />退回修改</button><button className="button-approve" onClick={() => onUpdate(task, 'approved', '交付物通过人工验收', '林同学')}><Check size={17} />通过验收</button></> : task.stage === 'approved' ? <div className="completed-banner"><CircleCheck size={17} />已通过人工验收</div> : <button className="button-primary drawer-advance" onClick={() => nextStage && onUpdate(task, nextStage, nextStage === 'review' ? '执行完成，交给测试 Agent 验收' : `CEO 拆解完成，派发给 ${executionAgent}`, nextStage === 'review' ? '测试 Agent' : executionAgent)}><Sparkles size={16} />模拟推进到{nextStage ? stageMeta[nextStage].label : ''}<ArrowRight size={15} /></button>}
        <small className="drawer-demo-note">模拟推进只更新本地任务，不会触发真实模型调用</small>
      </div>
    </aside>
  </div>
}

function CreateModal({ onClose, onCreate }: { onClose: () => void; onCreate: (title: string, brief: string, channel: string) => void }) {
  const [title, setTitle] = useState('')
  const [brief, setBrief] = useState('')
  const [channel, setChannel] = useState('全栈开发')
  const canSubmit = title.trim().length > 0
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><form className="create-modal" onSubmit={(event) => { event.preventDefault(); if (canSubmit) onCreate(title.trim(), brief.trim(), channel) }}>
    <div className="modal-heading"><div><span className="modal-icon"><Plus size={18} /></span><span><small>NEW WORKFLOW</small><h2>派发新任务</h2></span></div><button className="icon-button" type="button" aria-label="关闭创建任务" onClick={onClose}><X size={19} /></button></div>
    <p className="modal-intro">先写清楚目标与交付标准，CEO Agent 会拆解并派发给对应岗位。</p>
    <label className="form-label">任务目标 <span>必填</span><input autoFocus maxLength={80} placeholder="例如：给后台新增用户权限管理页面和 API" value={title} onChange={(event) => setTitle(event.target.value)} /></label>
    <label className="form-label">验收标准与背景 <span>选填</span><textarea rows={4} maxLength={500} placeholder="说明技术栈、边界条件、需要交付的文件或验收方式……" value={brief} onChange={(event) => setBrief(event.target.value)} /></label>
    <label className="form-label">任务方向<select value={channel} onChange={(event) => setChannel(event.target.value)}><option>全栈开发</option><option>前端开发</option><option>后端开发</option><option>Agent 研究</option><option>内容与运营</option></select></label>
    <div className="modal-flow-note"><span className="demo-pulse" /><span>首先交给 <strong>CEO Agent</strong> 拆解任务</span><span className="flow-note-arrow"><ArrowRight size={14} /> 专业岗位执行 <ArrowRight size={14} /> 你验收</span></div>
    <div className="modal-actions"><button className="button-secondary" type="button" onClick={onClose}>取消</button><button className="button-primary" type="submit" disabled={!canSubmit}><Send size={15} />派发任务</button></div>
  </form></div>
}

export default App
