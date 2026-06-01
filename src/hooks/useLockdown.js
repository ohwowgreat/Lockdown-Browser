import { useEffect, useRef, useState, useCallback } from 'react'
import { io } from 'socket.io-client'

const DEFAULT_SETTINGS = { detect_navigation: true, track_copy_paste: true, log_keystrokes: false }

export function useLockdown({ sessionId, studentName, enabled = true, settings = DEFAULT_SETTINGS }) {
  const [violations, setViolations] = useState(0)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [warningMsg, setWarningMsg] = useState('')

  const violationsRef    = useRef(0)
  const socketRef        = useRef(null)
  const sessionIdRef     = useRef(sessionId)
  const studentNameRef   = useRef(studentName)
  const lastViolationRef = useRef(0)
  const keystrokeBuffer  = useRef([])    // batched keystrokes
  const flushTimerRef    = useRef(null)

  useEffect(() => { sessionIdRef.current = sessionId },   [sessionId])
  useEffect(() => { studentNameRef.current = studentName }, [studentName])

  const warn = useCallback((msg) => {
    setWarningMsg(msg)
    setTimeout(() => setWarningMsg(''), 3500)
  }, [])

  // Stable violation emitter — reads from refs, never stale
  const recordViolation = useCallback((reason) => {
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
  }, [warn])

  const recordNote = useCallback((action) => {
    const sid   = sessionIdRef.current
    const sname = studentNameRef.current
    if (socketRef.current && sid && sname) {
      socketRef.current.emit('note', { session_id: sid, student_name: sname, action })
    }
  }, [])

  const flushKeystrokes = useCallback(() => {
    if (!keystrokeBuffer.current.length) return
    const sid   = sessionIdRef.current
    const sname = studentNameRef.current
    if (socketRef.current && sid && sname) {
      socketRef.current.emit('keystrokes', {
        session_id: sid, student_name: sname, keys: [...keystrokeBuffer.current]
      })
    }
    keystrokeBuffer.current = []
  }, [])

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

    socket.on('connect', join)
    return () => {
      flushKeystrokes()
      socket.off('connect', join)
      socket.disconnect()
    }
  }, [enabled, sessionId, flushKeystrokes])

  // Flush keystroke buffer every 15 seconds
  useEffect(() => {
    if (!enabled || !settings.log_keystrokes) return
    flushTimerRef.current = setInterval(flushKeystrokes, 15000)
    return () => clearInterval(flushTimerRef.current)
  }, [enabled, settings.log_keystrokes, flushKeystrokes])

  // ── Fullscreen ────────────────────────────────────────────────────────────
  const requestFullscreen = useCallback(() => {
    const el = document.documentElement
    if (el.requestFullscreen)            el.requestFullscreen()
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
      if (!fs && settings.detect_navigation) recordViolation('Exited fullscreen')
    }
    document.addEventListener('fullscreenchange',       onFsChange)
    document.addEventListener('webkitfullscreenchange', onFsChange)
    return () => {
      document.removeEventListener('fullscreenchange',       onFsChange)
      document.removeEventListener('webkitfullscreenchange', onFsChange)
    }
  }, [enabled, settings.detect_navigation])

  // ── Visibility (tab switch / minimize) ───────────────────────────────────
  useEffect(() => {
    if (!enabled || !settings.detect_navigation) return
    function onVisibilityChange() {
      if (document.hidden) recordViolation('Left the exam tab')
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [enabled, settings.detect_navigation])

  // ── Window blur (app switch — more reliable on macOS fullscreen) ─────────
  useEffect(() => {
    if (!enabled || !settings.detect_navigation) return
    function onBlur() { recordViolation('Switched to another window or app') }
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [enabled, settings.detect_navigation])

  // ── Copy / paste tracking ─────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled || !settings.track_copy_paste) return
    function onCopy()  { recordNote('copied text') }
    function onPaste() { recordNote('pasted text') }
    document.addEventListener('copy',  onCopy)
    document.addEventListener('paste', onPaste)
    return () => {
      document.removeEventListener('copy',  onCopy)
      document.removeEventListener('paste', onPaste)
    }
  }, [enabled, settings.track_copy_paste])

  // ── Keystroke logging ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled || !settings.log_keystrokes) return
    function onKeyDown(e) {
      // Skip modifier-only keypresses; record the actual key + any modifiers
      if (['Control', 'Meta', 'Alt', 'Shift'].includes(e.key)) return
      keystrokeBuffer.current.push({
        key:  e.key,
        ctrl: e.ctrlKey || e.metaKey,
        alt:  e.altKey,
        at:   Date.now(),
      })
    }
    document.addEventListener('keydown', onKeyDown, { capture: true })
    return () => document.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [enabled, settings.log_keystrokes])

  // ── Block keyboard shortcuts (always on) ─────────────────────────────────
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

  // ── Block right-click (always on) ────────────────────────────────────────
  useEffect(() => {
    if (!enabled) return
    function onContextMenu(e) { e.preventDefault() }
    document.addEventListener('contextmenu', onContextMenu)
    return () => document.removeEventListener('contextmenu', onContextMenu)
  }, [enabled])

  return { violations, isFullscreen, warningMsg, requestFullscreen, recordNote }
}
