import { useEffect, useState } from 'react'
import type { HistoryPage } from './provider-client'

export function useWorkbenchHistory<T>(
  load: (params: URLSearchParams, signal: AbortSignal) => Promise<HistoryPage<T>>,
  filters: Record<string, string>,
  revision: string | undefined,
) {
  const scope = new URLSearchParams(filters).toString()
  const [position, setPosition] = useState<{ scope: string; cursors: string[] }>({ scope, cursors: [] })
  const cursors = position.scope === scope ? position.cursors : []
  const cursor = cursors.at(-1)
  const key = `${scope}:${cursor ?? ''}`
  const [result, setResult] = useState<{ key: string; data?: HistoryPage<T>; error?: string } | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const abort = new AbortController()
    const params = new URLSearchParams(scope)
    if (cursor) params.set('after', cursor)
    const timer = window.setTimeout(() => {
      void load(params, abort.signal).then((data) => {
        if (!abort.signal.aborted) setResult({ key, data })
      }).catch((cause: Error) => {
        if (!abort.signal.aborted) setResult({ key, error: cause.message })
      })
    }, 160)
    return () => { window.clearTimeout(timer); abort.abort() }
  }, [load, scope, key, cursor, revision, attempt])

  const current = result?.key === key ? result : null
  return {
    items: current?.data?.items ?? [], loading: !current, error: current?.error,
    page: cursors.length + 1, hasPrevious: cursors.length > 0, hasNext: Boolean(current?.data?.next),
    previous: () => setPosition({ scope, cursors: cursors.slice(0, -1) }),
    next: () => { if (current?.data?.next) setPosition({ scope, cursors: [...cursors, current.data.next] }) },
    reset: () => setPosition({ scope, cursors: [] }),
    retry: () => setAttempt((last) => last + 1),
  }
}
