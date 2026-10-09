import { useCallback, useEffect, useRef, useState } from 'react'
import { discoverLocalEnvironment } from '@/lib/bridge'
import type { LocalDiscoveryReport } from '@/lib/types'

let activeScan: Promise<LocalDiscoveryReport> | null = null
function discoverOnce() {
  if (!activeScan) {
    activeScan = discoverLocalEnvironment().finally(() => { activeScan = null })
  }
  return activeScan
}

export function useEnvironmentDiscovery() {
  const [report, setReport] = useState<LocalDiscoveryReport | null>(null)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState('')
  const request = useRef(0)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current++ } }, [])
  const scan = useCallback(async () => {
    const id = ++request.current
    setScanning(true); setError(''); setReport(null)
    try {
      const result = await discoverOnce()
      if (mounted.current && request.current === id) setReport(result)
    } catch (error) {
      if (mounted.current && request.current === id) setError(error instanceof Error ? error.message : String(error))
    } finally {
      if (mounted.current && request.current === id) setScanning(false)
    }
  }, [])
  return { report, scanning, error, scan }
}
