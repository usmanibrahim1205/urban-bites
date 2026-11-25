import { useEffect, useEffectEvent, useState } from 'react'
import { io } from 'socket.io-client'

export function useLiveUpdate(namespace: string, event: string, enabled: boolean, refresh: () => void,
  onEvent?: (payload?: { kind?: unknown; reference?: unknown }) => void) {
  const [connected, setConnected] = useState(false)
  const currentRefresh = useEffectEvent(refresh)
  const handleEvent = useEffectEvent((payload?: { kind?: unknown; reference?: unknown }) => {
    onEvent?.(payload)
    currentRefresh()
  })
  useEffect(() => {
    if (!enabled) return
    const socket = io(namespace)
    socket.on('connect', () => {
      setConnected(true)
      currentRefresh()
    })
    socket.on('disconnect', () => {
      setConnected(false)
      currentRefresh()
    })
    socket.on(event, handleEvent)
    const reconcile = () => {
      if (document.visibilityState !== 'visible') return
      currentRefresh()
      if (!socket.connected && !socket.active) socket.connect()
    }
    const poll = window.setInterval(reconcile, 15_000)
    document.addEventListener('visibilitychange', reconcile)
    return () => {
      window.clearInterval(poll)
      document.removeEventListener('visibilitychange', reconcile)
      socket.removeAllListeners()
      socket.disconnect()
      setConnected(false)
    }
  }, [namespace, event, enabled])
  return enabled && connected
}
