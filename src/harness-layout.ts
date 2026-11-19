import { useEffect, useState } from 'react'

const storageKey = 'zhidian-harness-layout-v1'
export const maxHarnessPanes = 4

export type HarnessLayout = { ids: string[]; focused: string | null; mode: 'split' | 'focus' }
const emptyLayout: HarnessLayout = { ids: [], focused: null, mode: 'split' }

function readLayout(): HarnessLayout {
  try {
    const saved = JSON.parse(window.localStorage.getItem(storageKey) ?? 'null')
    if (!Array.isArray(saved?.ids)) return emptyLayout
    const ids = [...new Set<string>(saved.ids.filter((id: unknown) => typeof id === 'string' && /^run-[\w-]{1,100}$/.test(id)))].slice(0, maxHarnessPanes)
    return { ids, focused: ids.includes(saved.focused) ? saved.focused : ids[0] ?? null, mode: saved.mode === 'focus' ? 'focus' : 'split' }
  } catch { return emptyLayout }
}

export function useHarnessLayout() {
  const desktop = window.zhidianDesktop
  const [layout, setLayout] = useState(() => desktop?.loadHarnessLayout ? emptyLayout : readLayout())
  const [ready, setReady] = useState(() => !desktop?.loadHarnessLayout)
  useEffect(() => {
    if (!desktop?.loadHarnessLayout) return
    let disposed = false
    void desktop.loadHarnessLayout().then((restored) => {
      if (disposed) return
      if (restored) setLayout((current) => current === emptyLayout ? restored : current)
      setReady(true)
    }).catch(() => { if (!disposed) setReady(true) })
    return () => { disposed = true }
  }, [desktop])
  useEffect(() => {
    if (!ready) return
    if (desktop?.saveHarnessLayout) { void desktop.saveHarnessLayout(layout).catch(() => undefined); return }
    try { window.localStorage.setItem(storageKey, JSON.stringify(layout)) } catch { /* Optional preference. */ }
  }, [desktop, layout, ready])
  const open = (id: string) => setLayout((current) => {
    if (current.ids.includes(id)) return { ...current, focused: id }
    if (current.ids.length >= maxHarnessPanes) return current
    return { ...current, focused: id, ids: [...current.ids, id] }
  })
  const close = (id: string) => setLayout((current) => {
    const ids = current.ids.filter((candidate) => candidate !== id)
    return { ...current, ids, focused: current.focused === id ? ids.at(-1) ?? null : current.focused }
  })
  const setMode = (mode: HarnessLayout['mode']) => setLayout((current) => ({ ...current, mode }))
  return { layout, open, close, setMode }
}
