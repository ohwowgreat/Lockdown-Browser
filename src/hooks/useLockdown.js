import { useEffect, useRef, useState, useCallback } from 'react'
import { io } from 'socket.io-client'

/**
 * Lockdown hook — enforces exam rules in the browser:
 *  - Requests fullscreen on mount
 *  - Detects visibility change (tab switch / window minimise)
 *  - Detects fullscreen exit
 *  - Blocks right-click context menu
 *  - Blocks common keyboard shortcuts (Ctrl/Cmd+T, +N, +W, +Tab, F12, etc.)
 *  - Reports violations over Socket.IO
 */
export function useLockdown({ sessionId, studentName, enabled = true }) {
  const [violations, setViolations] = useState(0)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [warningMsg, setWarningMsg] = useState('')
  const violationsRef = useRef(0)
  const socketRef = useRef(null)

  const warn = useCallback((msg) => {
    setWarningMsg(msg)
    setTimeout(() => setWarningMsg(''), 3500)
  }, [])

  const recordViolation = useCallback((reason) => {
    violationsRef.current += 1
    setViolations(violationsRef.current)
    warn(`⚠️ Violation #${violationsRef.current}: ${reason}`)
    if (socketRef.current && sessionId && studentName) {
      socketRef.current.emit('violation', {
        session_id: sessionId,
        student_name: studentName,
        count: violationsRef.current,
      })
    }
  }, [sessionId, studentName, warn])

  // Socket connection
  useEffect(() => {
    if (!enabled || !sessionId) return
    const socket = io()
    socketRef.current = socket
    socket.emit('student_join', { session_id: sessionId, student_name: studentName })
    return () => socket.disconnect()
  }, [enabled, sessionId, studentName])

  // Request fullscreen
  const requestFullscreen = useCallback(() => {
    const el = document.documentElement
    if (el.requestFullscreen) el.requestFullscreen()
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen()
  }, [])

  useEffect(() => {
    if (!enabled) return
    requestFullscreen()
  }, [enabled, requestFullscreen])

  // Fullscreen change detection
  useEffect(() => {
    if (!enabled) return
    function onFsChange() {
      const fs = Boolean(
        document.fullscreenElement || document.webkitFullscreenElement
      )
      setIsFullscreen(fs)
      if (!fs) {
        recordViolation('Exited fullscreen')
      }
    }
    document.addEventListener('fullscreenchange', onFsChange)
    document.addEventListener('webkitfullscreenchange', onFsChange)
    return () => {
      document.removeEventListener('fullscreenchange', onFsChange)
      document.removeEventListener('webkitfullscreenchange', onFsChange)
    }
  }, [enabled, recordViolation])

  // Visibility change (tab switch / window hide)
  useEffect(() => {
    if (!enabled) return
    function onVisibilityChange() {
      if (document.hidden) {
        recordViolation('Switched away from exam tab')
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [enabled, recordViolation])

  // Block right-click
  useEffect(() => {
    if (!enabled) return
    function onContextMenu(e) { e.preventDefault() }
    document.addEventListener('contextmenu', onContextMenu)
    return () => document.removeEventListener('contextmenu', onContextMenu)
  }, [enabled])

  // Block keyboard shortcuts
  useEffect(() => {
    if (!enabled) return
    function onKeyDown(e) {
      const ctrl = e.ctrlKey || e.metaKey
      const blocked = [
        ctrl && ['t', 'n', 'w', 'r', 'l', 'a'].includes(e.key.toLowerCase()), // new tab/window/close/reload/address
        ctrl && e.key === 'Tab',          // tab switch
        ctrl && e.shiftKey && e.key === 'i', // devtools
        ctrl && e.shiftKey && e.key === 'j', // devtools
        ctrl && e.shiftKey && e.key === 'c', // inspect element
        e.key === 'F12',                  // devtools
        e.key === 'F5',                   // reload
        e.altKey && e.key === 'Tab',      // OS tab switch (won't always work)
      ].some(Boolean)

      if (blocked) {
        e.preventDefault()
        e.stopPropagation()
        warn('That shortcut is disabled during the exam')
      }
    }
    document.addEventListener('keydown', onKeyDown, { capture: true })
    return () => document.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [enabled, warn])

  return {
    violations,
    isFullscreen,
    warningMsg,
    requestFullscreen,
  }
}
