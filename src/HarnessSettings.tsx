import { useCallback, useEffect, useState } from 'react'
import { Check, CircleAlert, CircleCheck, ExternalLink, LoaderCircle, RefreshCw, ShieldCheck, Terminal } from 'lucide-react'
import ProviderSettings from './ProviderSettings'
import { loadHarnessStatuses } from './provider-client'
import type { HarnessStatus, ProviderId } from './provider-client'
import type { HarnessLayout } from './harness-layout'

type AgentRoute = { name: string; provider: ProviderId; model: string }

type DesktopBridge = {
  openCodexCli?: () => Promise<boolean>
  loadHarnessLayout?: () => Promise<HarnessLayout | null>
  saveHarnessLayout?: (layout: HarnessLayout) => Promise<boolean>
}
declare global { interface Window { zhidianDesktop?: DesktopBridge } }

const statusLabels: Record<string, string> = {
  connected: '已连接',
  'login-required': '需要登录',
  'connection-unknown': '状态未知',
  'connection-error': '连接失败',
  'not-installed': '未发现 CLI',
  incompatible: '版本不兼容',
  'integration-pending': '适配待完成',
}

const capabilityLabels: Record<string, string> = {
  'thread-resume': '线程续接',
  events: '运行事件',
  cancel: '取消运行',
  'approval-deny': '拒绝额外授权',
}

export default function HarnessSettings({ agents, onNavigate }: { agents: AgentRoute[]; onNavigate: (page: 'team') => void }) {
  const [harnesses, setHarnesses] = useState<HarnessStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [showApiCompatibility, setShowApiCompatibility] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try { setHarnesses(await loadHarnessStatuses()) } catch (cause) {
      setError(cause instanceof Error ? cause.message : '本机 Harness 状态读取失败。')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => {
    let mounted = true
    loadHarnessStatuses().then((result) => {
      if (mounted) setHarnesses(result)
    }).catch((cause) => {
      if (mounted) setError(cause instanceof Error ? cause.message : '本机 Harness 状态读取失败。')
    }).finally(() => {
      if (mounted) setLoading(false)
    })
    return () => { mounted = false }
  }, [])

  const openCodex = async () => {
    setNotice('')
    try {
      if (!window.zhidianDesktop?.openCodexCli) {
        setNotice('此入口仅在织点 Windows 桌面应用中可用。')
        return
      }
      await window.zhidianDesktop.openCodexCli()
      setNotice('已在新终端打开 Codex CLI。')
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : '无法打开 Codex CLI。')
    }
  }

  return <>
    <div className="page-heading harness-page-heading">
      <div><div className="eyebrow"><span className="eyebrow-dot" />LOCAL HARNESS CONTROL</div><h1>本机 Harness</h1><p>优先调用本机已登录的 Harness；织点只保存线程与运行关联，不接收 Harness API Key。</p></div>
      <button className="button-secondary" onClick={() => void refresh()} disabled={loading}><RefreshCw size={15} className={loading ? 'spin-icon' : ''} />{loading ? '正在检测…' : '重新检测'}</button>
    </div>
    <div className="harness-security-note"><ShieldCheck size={16} /><span>检查不读取或显示凭据内容。Codex 使用官方 App Server；DeepSeek 当前只运行 `dsh --version`，不检查登录态、读取或复用桌面端配置。</span></div>
    {error && <div className="provider-notice provider-notice-error"><CircleAlert size={15} /><span>{error}</span></div>}
    {notice && <div className="provider-notice provider-notice-info" role="status"><Terminal size={15} /><span>{notice}</span></div>}
    <section className="harness-card-list" aria-label="本机 Harness 列表">
      {harnesses.map((harness) => {
        const statusLabel = statusLabels[harness.status] ?? harness.status
        const ready = harness.status === 'connected'
        const pending = harness.status === 'integration-pending'
        return <article className="harness-card" key={harness.id}>
          <header><div className={`harness-icon ${harness.id === 'codex-app-server' ? 'harness-icon-codex' : 'harness-icon-deepseek'}`}>{harness.id === 'codex-app-server' ? <Terminal size={20} /> : <span>DS</span>}</div><div className="harness-card-title"><h2>{harness.name}</h2><p>{harness.id === 'codex-app-server' ? '官方 Codex CLI App Server · 使用本机登录态' : 'DeepSeek 官方 CLI · 当前只探测版本'}</p></div><span className={`harness-status ${ready ? 'harness-status-ready' : pending ? 'harness-status-pending' : 'harness-status-warn'}`}><i />{statusLabel}</span></header>
          <div className="harness-meta"><span>版本</span><strong>{harness.version ?? (pending ? '—' : '未检测到')}</strong>{harness.minimumVersion && <small>最低支持 {harness.minimumVersion}</small>}</div>
          {harness.capabilities.length > 0 && <div className="harness-capabilities">{harness.capabilities.map((capability) => <span key={capability}><Check size={12} />{capabilityLabels[capability] ?? capability}</span>)}</div>}
          {harness.message && <p className="harness-message">{harness.message}</p>}
          {harness.id === 'codex-app-server' && <footer><button className="button-secondary" onClick={() => void openCodex()}><ExternalLink size={15} />在终端打开 Codex CLI</button><span>{ready ? <><CircleCheck size={14} /> 可分配给 Agent</> : <><CircleAlert size={14} />{harness.status === 'login-required' ? '请先在本机完成 Codex 登录' : '当前不能分配任务'}</>}</span></footer>}
          {pending && <footer><span><CircleAlert size={14} />真实 SDK 运行、独立 DSH_HOME、隐私补丁与取消流程待验收</span></footer>}
        </article>
      })}
      {loading && harnesses.length === 0 && <div className="harness-empty"><LoaderCircle size={17} className="spin-icon" />正在检查本机 Harness…</div>}
      {!loading && !error && harnesses.length === 0 && <div className="harness-empty">没有可显示的 Harness 状态。</div>}
    </section>
    <section className="settings-status-row"><div><h2>团队路由</h2><p>在 Agent 团队页将 CEO、专业 Agent 或 QA 路由到已启用的执行器。未连接的 Harness 不会自动回退到 API 服务商。</p></div><button className="text-button" onClick={() => onNavigate('team')}>打开 Agent 团队 <span>→</span></button></section>
    <details className="harness-compatibility" open={showApiCompatibility} onToggle={(event) => setShowApiCompatibility(event.currentTarget.open)}>
      <summary>兼容模式：旧版模型 API 配置</summary>
      <p>此区域保留用于旧工作流兼容；不会清除已保存配置。新岗位优先选择本机 Harness。</p>
      <ProviderSettings agents={agents} onNavigate={onNavigate} />
    </details>
  </>
}
