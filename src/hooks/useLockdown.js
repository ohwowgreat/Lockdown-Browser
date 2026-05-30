import { useEffect, useRef, useState, useCallback } from 'react'
import { io } from 'socket.io-client'

export function useLockdown({ sessionId, studentName, enabled = true }) {
  const [violations, setViolations] = useState(0)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [warningMsg, setWarningMsg] = useState('')

  // Refs so callbacks always read the latest values — no stale closures
  const violationsRef    = useRef(0)
  const socketRef        = useRef(null)
  const sessionIdRef     = useRef(sessionId)
  const studentNameRef   = useRef(studentName)
  const lastViolationRef = useRef(0)   // for debounce

  // Keep refs in sync with props
  useEffect(() => { sessionIdRef.current = sessionId },   [sessionId])
  useEffect(() => { studentNameRef.current = studentName }, [studentName])

  const warn = useCallback((msg) => {
    setWarningMsg(msg)
    setTimeout(() => setWarningMsg(''), 3500)
  }, [])

  // Stable — never recreated because it reads from refs, not props
  const recordViolation = useCallback((reason) => {
    // Debounce: window.blur + visibilitychange can both fire for the
    // same action (app switch on some platforms). Ignore the 2nd event
    // within 800 ms so students don't get double-counted.
    const now = Date.now()
    if (now - lastViolationRef.current < 800) return
    lastViolationRef.current = now

    violationsRef.current += 1
    const count = violationsRef.current
    setViolations(count)
    warn(`⚠️ Violation #${count}: ${reason}`)

    const sid   = sessionIdRef.current
    const sname = studentNameRef.current
    if (socketRef.current && sid && sname) {
      socketRef.current.emit('violation', { session_id: sid, student_name: sname, count })
    }
  }, [warn])  // warn is stable; no sessionId/studentName deps needed — we use refs

  const recordNote = useCallback((action) => {
    const sid   = sessionIdRef.current
    const sname = studentNameRef.current
    if (socketRef.current && sid && sname) {
      socketRef.current.emit('note', { session_id: sid, student_name: sname, action })
    }
  }, [])  // stable

  // ── Socket ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled || !sessionId) return
    const socket = io()
    socketRef.current = socket

    function join() {
      socket.emit('student_join', {
        session_id:   sessionIdRef.current,
        student_name: studentNameRef.current,
      })
    }

    socket.on('connect', join)   // fires on first connect AND every reconnect
    return () => {
      socket.off('connect', join)
      socket.disconnect()
    }
  }, [enabled, sessionId])      // sessionId only to trigger reconnect when it changes

  // ── Fullscreen ────────────────────────────────────────────────────────────
  const requestFullscreen = useCallback(() => {
    const el = document.documentElement
    if (el.requestFullscreen)        el.requestFullscreen()
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen()
  }, [])

  useEffect(() => {
    if (!enabled) return
    requestFullscreen()
  }, [enabled, requestFullscreen])

  useEffect(() => {
    if (!enabled) return
    function onFsChange() {
      const fs = Boolean(document.fullscreenElement || document.webkitFullscreenElement)
      setIsFullscreen(fs)
      if (!fs) recordViolation('Exited fullscreen')
    }
    document.addEventListener('fullscreenchange',       onFsChange)
    document.addEventListener('webkitfullscreenchange', onFsChange)
    return () => {
      document.removeEventListener('fullscreenchange',       onFsChange)
      document.removeEventListener('webkitfullscreenchange', onFsChange)
    }
  }, [enabled])   // recordViolation is now stable — no need to include it

  // ── Visibility (tab switch, minimize) ─────────────────────────────────────
  // Fires when the tab becomes hidden — works for in-browser tab switches
  useEffect(() => {
    if (!enabled) return
    function onVisibilityChange() {
      if (document.hidden) recordViolation('Left the exam tab')
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [enabled])

  // ── Window blur (app switch) ───────────────────────────────────────────────
  // visibilitychange does NOT fire on macOS when the user Cmd+Tabs to another
  // app while the browser is in fullscreen. window.blur covers that case.
  useEffect(() => {
    if (!enabled) return
    function onBlur() { recordViolation('Switched to another window or app') }
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [enabled])

  // ── Block right-click ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled) return
    function onContextMenu(e) { e.preventDefault() }
    document.addEventListener('contextmenu', onContextMenu)
    return () => document.removeEventListener('contextmenu', onContextMenu)
  }, [enabled])

  // ── Track copy / paste (note, not a violation) ────────────────────────────
  useEffect(() => {
    if (!enabled) return
    function onCopy()  { recordNote('copied text') }
    function onPaste() { recordNote('pasted text') }
    document.addEventListener('copy',  onCopy)
    document.addEventListener('paste', onPaste)
    return () => {
      document.removeEventListener('copy',  onCopy)
      document.removeEventListener('paste', onPaste)
    }
  }, [enabled])

  // ── Block keyboard shortcuts ──────────────────────────────────────────────
  useEffect(() => {
    if (!enabled) return
    function onKeyDown(e) {
      const ctrl = e.ctrlKey || e.metaKey
      const blocked = [
        ctrl && ['t', 'n', 'w', 'r', 'l'].includes(e.key.toLowerCase()),
        ctrl && e.key === 'Tab',
        ctrl && e.shiftKey && ['i', 'j', 'c'].includes(e.key.toLowerCase()),
        e.key === 'F12',
        e.key === 'F5',
        e.altKey && e.key === 'Tab',
      ].some(Boolean)

      if (blocked) {
        e.preventDefault()
        e.stopPropagation()
        warn('That shortcut is disabled during the exam')
      }
    }
    document.addEventListener('keydown', onKeyDown, { capture: true })
    return () => document.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [enabled])

  return { violations, isFullscreen, warningMsg, requestFullscreen, recordNote }
}
