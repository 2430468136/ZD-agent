import { useEffect, useState, type FormEvent } from 'react'
import App from './App.tsx'
import { MemberWorkspace } from './ProjectMembers'
import { loadLocalAuth, loginLocal, logoutLocal, type AuthStatus } from './provider-client'

function readTaskLink() {
  const match = /^#task=([A-Za-z0-9-]{1,100})$/.exec(window.location.hash)
  return match?.[1] ?? null
}

export default function LocalWorkbench() {
  const [auth, setAuth] = useState<AuthStatus | null>(null)
  const [memberLogin, setMemberLogin] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [linkedTaskId, setLinkedTaskId] = useState(readTaskLink)

  useEffect(() => {
    const sync = () => setLinkedTaskId(readTaskLink())
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [])

  function closeTaskLink() {
    if (readTaskLink()) window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search)
    setLinkedTaskId(null)
  }

  function refresh() {
    return loadLocalAuth().then(setAuth, () => setError('无法连接本机服务。'))
  }

  useEffect(() => {
    void refresh()
    const invalidate = () => { void refresh() }
    window.addEventListener('zhidian-session-expired', invalidate)
    return () => window.removeEventListener('zhidian-session-expired', invalidate)
  }, [])

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const input = form.elements.namedItem('key') as HTMLInputElement
    setBusy(true)
    setError('')
    const memberId = memberLogin ? String(new FormData(form).get('memberId')).trim() : undefined
    try { await loginLocal(input.value, memberId); await refresh() } catch (cause) { setError(cause instanceof Error ? cause.message : '登录失败。') }
    finally { input.value = ''; setBusy(false) }
  }

  async function logout() {
    setError('')
    try { await logoutLocal(); setAuth({ required: true, signedIn: false }) } catch { window.location.reload() }
  }

  if (auth?.signedIn && auth.role === 'viewer') return <MemberWorkspace linkedTaskId={linkedTaskId} onCloseTaskLink={closeTaskLink} onLogout={() => { void logout() }} />
  if (auth?.signedIn) return <App linkedTaskId={linkedTaskId} onCloseTaskLink={closeTaskLink} onLogout={auth.required ? () => { void logout() } : undefined} />
  return <main className="local-login"><section aria-labelledby="local-login-title">
    <h1 id="local-login-title">织点</h1>
    {auth?.required ? <form onSubmit={(event) => { void login(event) }}>
      <label>账号类型<select value={memberLogin ? 'member' : 'owner'} onChange={(event) => { setMemberLogin(event.target.value === 'member'); setError('') }}><option value="owner">主人</option><option value="member">项目成员</option></select></label>
      {memberLogin && <label>成员 ID<input name="memberId" required maxLength={80} autoComplete="username" /></label>}
      <label>访问密钥<input name="key" type="password" required minLength={32} maxLength={256} autoComplete="current-password" /></label>
      {error && <p role="alert">{error}</p>}
      <button className="button-primary" type="submit" disabled={busy}>{busy ? '登录中…' : '登录'}</button>
    </form> : error ? <><p role="alert">{error}</p><button className="button-secondary" onClick={() => { setError(''); void refresh() }}>重新连接</button></> : <p>正在连接本机服务…</p>}
  </section></main>
}

