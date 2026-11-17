import { useEffect, useState } from 'react'
import { Activity, ArrowRight, Check, CircleCheck, Eye, EyeOff, LoaderCircle, LockKeyhole, PlugZap, Save, ShieldCheck, Trash2, X } from 'lucide-react'
import { deleteProviderKey, loadProviderStatuses, providerOptions, saveProvider, testProviderConnection } from './provider-client'
import type { ProviderId, ProviderStatuses } from './provider-client'

type AgentRoute = { name: string; provider: ProviderId; model: string }
type Notice = { kind: 'success' | 'error' | 'info'; text: string }

export default function ProviderSettings({ agents, onNavigate }: { agents: AgentRoute[]; onNavigate: (page: 'team') => void }) {
  const [selected, setSelected] = useState<ProviderId>('OpenAI')
  const [statuses, setStatuses] = useState<ProviderStatuses | null>(null)
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [busy, setBusy] = useState<'save' | 'test' | 'delete' | ''>('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [loadError, setLoadError] = useState('')
  const selectedProvider = providerOptions.find((provider) => provider.id === selected)!
  const selectedStatus = statuses?.[selected]

  useEffect(() => {
    let mounted = true
    loadProviderStatuses()
      .then((result) => {
        if (mounted) {
          setStatuses(result)
          setBaseUrl(result.OpenAI.baseUrl)
          setLoadError('')
        }
      })
      .catch((error: unknown) => {
        if (mounted) setLoadError(error instanceof Error ? error.message : '无法连接本地设置服务。')
      })
    return () => { mounted = false }
  }, [])

  function chooseProvider(id: ProviderId) {
    setSelected(id)
    setBaseUrl(statuses?.[id].baseUrl ?? providerOptions.find((provider) => provider.id === id)?.baseUrl ?? '')
    setApiKey('')
    setModel('')
    setShowApiKey(false)
    setNotice(null)
  }

  async function refreshStatuses() {
    const next = await loadProviderStatuses()
    setStatuses(next)
  }

  async function handleSave() {
    setBusy('save')
    setNotice(null)
    try {
      await saveProvider(selected, { baseUrl, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) })
      setApiKey('')
      await refreshStatuses()
      setNotice({ kind: 'success', text: '配置已保存在本机，API Key 已使用 Windows 用户级加密。' })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '保存失败。' })
    } finally {
      setBusy('')
    }
  }

  async function handleTest() {
    setBusy('test')
    setNotice({ kind: 'info', text: '正在向服务商发送一次简短测试请求…' })
    try {
      const result = await testProviderConnection(selected, { baseUrl, model, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) })
      setNotice({ kind: 'success', text: `${result.message} 往返 ${result.latencyMs} ms。` })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '连接测试失败。' })
    } finally {
      setBusy('')
    }
  }

  async function handleDeleteKey() {
    setBusy('delete')
    setNotice(null)
    try {
      await deleteProviderKey(selected)
      setApiKey('')
      await refreshStatuses()
      setNotice({ kind: 'success', text: '该服务商保存的 API Key 已从本机删除。' })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '删除失败。' })
    } finally {
      setBusy('')
    }
  }

  const routedAgents = agents.filter((agent) => agent.provider === selected)
  const canTest = model.trim().length > 0 && Boolean(baseUrl.trim()) && (!selectedProvider.keyRequired || Boolean(apiKey.trim() || selectedStatus?.hasApiKey))

  return <>
    <div className="page-heading inner-heading">
      <div><div className="eyebrow"><span className="eyebrow-dot" />MODEL PROVIDER SETUP</div><h1>模型接入</h1><p>在这里配置服务商凭据，再到 Agent 团队里为各岗位选择模型。</p></div>
      <div className="team-status-pill"><LockKeyhole size={15} />密钥仅保存在本机</div>
    </div>
    <div className="routing-notice"><ShieldCheck size={15} /><span><strong>安全存储</strong> API Key 不会写入浏览器存储；本地服务使用 Windows 用户级加密后保存凭据。</span></div>
    {loadError && <div className="provider-notice provider-notice-error"><X size={15} /><span>{loadError} 请重新启动 `pnpm dev`，确保本地 API 服务已运行。</span></div>}
    <section className="provider-settings">
      <div className="provider-tabs" role="tablist" aria-label="模型服务商">
        {providerOptions.map((provider) => <button className={`provider-tab ${selected === provider.id ? 'provider-tab-active' : ''}`} key={provider.id} role="tab" aria-selected={selected === provider.id} onClick={() => chooseProvider(provider.id)}>
          <span className={`provider-tab-dot provider-dot-${provider.id.replaceAll(' ', '-').toLowerCase()}`} />
          <span><strong>{provider.label}</strong><small>{provider.description}</small></span>
          {statuses?.[provider.id].hasApiKey && <Check size={14} aria-label="已保存凭据" />}
        </button>)}
      </div>
      <div className="provider-form" role="tabpanel" aria-label={`${selectedProvider.label} 配置`}>
        <div className="provider-form-heading">
          <div><span className="provider-kicker">PROVIDER CREDENTIALS</span><h2>{selectedProvider.label}</h2></div>
          <span className={`provider-state ${selectedStatus?.hasApiKey || !selectedProvider.keyRequired ? 'provider-state-ready' : ''}`}><i />{selectedStatus?.hasApiKey ? '凭据已保存' : selectedProvider.keyRequired ? '尚未配置' : 'API Key 可选'}</span>
        </div>
        <label className="provider-field"><span>API 地址</span><input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" spellCheck={false} autoCapitalize="off" autoComplete="url" /></label>
        <label className="provider-field"><span>API Key <small>{selectedProvider.keyRequired ? '必填' : '可选'}</small></span><span className="secret-input-wrap"><input type={showApiKey ? 'text' : 'password'} value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={selectedStatus?.hasApiKey ? `已保存 ${selectedStatus.maskedApiKey} · 留空表示不修改` : selectedProvider.keyRequired ? '粘贴服务商 API Key' : '本地模型通常无需填写'} autoComplete="new-password" spellCheck={false} /><button type="button" className="icon-button secret-toggle" aria-label={showApiKey ? '隐藏 API Key' : '显示 API Key'} title={showApiKey ? '隐藏 API Key' : '显示 API Key'} onClick={() => setShowApiKey((value) => !value)}>{showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}</button></span></label>
        <label className="provider-field"><span>连接测试 Model ID</span><input value={model} onChange={(event) => setModel(event.target.value)} placeholder="输入服务商支持的准确模型 ID" spellCheck={false} autoCapitalize="off" />{routedAgents.length > 0 && <small className="provider-hint">当前有 {routedAgents.length} 个 Agent 使用此服务商：{routedAgents.map((agent) => `${agent.name}（${agent.model}）`).join('、')}。测试时请填已开通的准确 Model ID。</small>}</label>
        {notice && <div className={`provider-notice provider-notice-${notice.kind}`} role="status">{notice.kind === 'success' ? <CircleCheck size={15} /> : notice.kind === 'error' ? <X size={15} /> : <LoaderCircle size={15} className={busy === 'test' ? 'spin-icon' : ''} />}<span>{notice.text}</span></div>}
        <div className="provider-actions">
          <button className="button-primary" onClick={handleSave} disabled={Boolean(busy) || !baseUrl.trim()}><Save size={15} />{busy === 'save' ? '正在保存…' : '保存配置'}</button>
          <button className="button-secondary" onClick={handleTest} disabled={Boolean(busy) || !canTest}><PlugZap size={15} />{busy === 'test' ? '测试中…' : '连接测试'}</button>
          {selectedStatus?.hasApiKey && <button className="button-danger" onClick={handleDeleteKey} disabled={Boolean(busy)}><Trash2 size={15} />删除已保存 Key</button>}
        </div>
        <div className="provider-security-note"><LockKeyhole size={14} /><span>Key 由本地服务通过 Windows DPAPI 按当前用户加密；浏览器只接收掩码状态。连接测试会产生一次短模型请求，可能计入服务商用量。</span></div>
      </div>
    </section>
    <section className="settings-status-row"><div><h2>团队路由</h2><p>在 Agent 团队页分别选择服务商与 Model ID。凭据按服务商共享，岗位路由彼此独立。</p></div><button className="text-button" onClick={() => onNavigate('team')}>打开 Agent 团队 <ArrowRight size={14} /></button></section>
    <div className="data-footnote"><Activity size={14} />连接测试已接通服务商；任务派发与执行目前仍为本地模拟，不会自动运行 Agent。</div>
  </>
}
