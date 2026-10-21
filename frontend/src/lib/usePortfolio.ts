/**
 * Loads the portfolio once, exposes refresh/reload, and keeps the active
 * configuration (source and optional API key) in React state.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  loadPortfolio,
  refreshPortfolio,
  resolveConfig,
  setStoredApiKey,
  setStoredPortfolioId,
  type DataConfig,
} from './api'
import type { PortfolioState } from './types'

export interface PortfolioController {
  data: PortfolioState | null
  error: Error | null
  loading: boolean
  refreshing: boolean
  config: DataConfig
  reload: () => void
  refresh: () => Promise<void>
  setApiKey: (key: string) => void
  /** Switch to another portfolio and reload everything for it. */
  setPortfolio: (id: number) => void
  clearError: () => void
}

export function usePortfolio(): PortfolioController {
  const [config, setConfig] = useState<DataConfig>(resolveConfig)
  const [data, setData] = useState<PortfolioState | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [attempt, setAttempt] = useState(0)

  // Guards against a slow in-flight request resolving after a newer one.
  const requestId = useRef(0)
  // A background reload (after an edit) should not blank the dashboard.
  const hasData = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    const id = ++requestId.current

    setLoading(!hasData.current)
    setError(null)

    loadPortfolio(config, controller.signal)
      .then((payload) => {
        if (id !== requestId.current) return
        hasData.current = true
        setData(payload)
        setLoading(false)
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || id !== requestId.current) return
        setError(cause instanceof Error ? cause : new Error(String(cause)))
        setLoading(false)
      })

    return () => controller.abort()
  }, [config, attempt])

  const reload = useCallback(() => setAttempt((value) => value + 1), [])

  const refresh = useCallback(async () => {
    if (config.source === 'snapshot') {
      reload()
      return
    }
    setRefreshing(true)
    try {
      await refreshPortfolio(config)
      setAttempt((value) => value + 1)
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(String(cause)))
    } finally {
      setRefreshing(false)
    }
  }, [config, reload])

  const setApiKey = useCallback((key: string) => {
    setStoredApiKey(key)
    setConfig((current) => ({ ...current, apiKey: key }))
  }, [])

  const setPortfolio = useCallback((id: number) => {
    setStoredPortfolioId(id)
    setConfig((current) => ({ ...current, portfolioId: id }))
  }, [])

  const clearError = useCallback(() => setError(null), [])

  return useMemo(
    () => ({
      data,
      error,
      loading,
      refreshing,
      config,
      reload,
      refresh,
      setApiKey,
      setPortfolio,
      clearError,
    }),
    [data, error, loading, refreshing, config, reload, refresh, setApiKey, setPortfolio, clearError],
  )
}
