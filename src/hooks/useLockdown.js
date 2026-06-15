import { useEffect, useRef, useState, useCallback } from 'react'
import { io } from 'socket.io-client'

// Settings shape:
//   navigation:  'off' | 'track' | 'block'
//   copy_paste:  'off' | 'track' | 'block'
//   log_keystrokes: boolean
const DEFAULT_SETTINGS = { navigation: 'track', copy_paste: 'track', log_keystrokes: false }

// How long a student may be "away" (tab hidden / window blurred / fullscreen
// exited) before it counts as a violation. A quick, accidental blur that returns
// within this window is forgiven; a deliberate exit that persists is recorded.
const GRACE_MS = 2500

export function useLockdown({ sessionId, studentName, enabled = true, settings = DEFAULT_SETTINGS }) {
  const s = { ...DEFAULT_SETTINGS, ...settings }

  const [violations, setViolations] = useState(0)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [warningMsg, setWarningMsg] = useState('')
  const [awayBlocked, setAwayBlocked] = useState(false)  // overlay when blocked + returned
  const [paused, setPaused] = useState(false)            // teacher-granted break

  const violationsRef    = useRef(0)
  const socketRef        = useRef(null)
  const sessionIdRef     = useRef(sessionId)
  const studentNameRef   = useRef(studentName)
  const keystrokeBuffer  = useRef([])
  const flushTimerRef    = useRef(null)
  const awayTimerRef     = useRef(null)   // pending grace timer for the current away-episode
  const awayReasonRef    = useRef('')
  const blockNavRef      = useRef(s.navigation === 'block')
  const pausedRef        = useRef(false)  // synchronous gate for event handlers

  useEffect(() => { sessionIdRef.current = sessionId },   [sessionId])
  useEffect(() => { studentNameRef.current = studentName }, [studentName])
  useEffect(() => { blockNavRef.current = s.navigation === 'block' }, [s.navigation])

  const warn = useCallback((msg) => {
    setWarningMsg(msg)
    setTimeout(() => setWarningMsg(''), 3500)
  }, [])

  const recordViolation = useCallback((reason) => {
    violationsRef.current += 1
    const count = violationsRef.current
    setViolations(count)
    warn(`⚠️ Violation #${count}: ${reason}`)
    const sid = sessionIdRef.current, sname = studentNameRef.current
    if (socketRef.current && sid && sname) {
      socketRef.current.emit('violation', { session_id: sid, student_name: sname, count })
    }
  }, [warn])

  // ── Away-episode tracking ──────────────────────────────────────────────────
  // goneAway starts a grace timer; if the student returns (cameBack) before it
  // fires, nothing is recorded. Multiple events for one action (blur +
  // visibilitychange + fullscreenchange) collapse into a single episode. Each
  // *completed* away-episode that outlasts the grace window counts once, so
  // deliberate repeat exits each add a violation while accidental flickers don't.
  const cameBack = useCallback(() => {
    if (awayTimerRef.current) {
      clearTimeout(awayTimerRef.current)
      awayTimerRef.current = null
    }
  }, [])

  const goneAway = useCallback((reason) => {
    if (pausedRef.current) return        // on a teacher-granted break — no violations
    if (awayTimerRef.current) return
    awayReasonRef.current = reason
    awayTimerRef.current = setTimeout(() => {
      awayTimerRef.current = null
      recordViolation(awayReasonRef.current)
      if (blockNavRef.current) setAwayBlocked(true)
    }, GRACE_MS)
  }, [recordViolation])

  useEffect(() => () => { if (awayTimerRef.current) clearTimeout(awayTimerRef.current) }, [])

  const recordNote = useCallback((action) => {
    const sid = sessionIdRef.current, sname = studentNameRef.current
    if (socketRef.current && sid && sname) {
      socketRef.current.emit('note', { session_id: sid, student_name: sname, action })
    }
  }, [])

  const flushKeystrokes = useCallback(() => {
    if (!keystrokeBuffer.current.length) return
    const sid = sessionIdRef.current, sname = studentNameRef.current
    if (socketRef.current && sid && sname) {
      socketRef.current.emit('keystrokes', { session_id: sid, student_name: sname, keys: [...keystrokeBuffer.current] })
    }
    keystrokeBuffer.current = []
  }, [])

  const requestFullscreen = useCallback(() => {
    const el = document.documentElement
    if (el.requestFullscreen)            el.requestFullscreen()
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen()
  }, [])

  // ── Socket ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled || !sessionId) return
    const socket = io()
    socketRef.current = socket
    function join() {
      socket.emit('student_join', { session_id: sessionIdRef.current, student_name: studentNameRef.current })
    }
    function onPauseState({ student_name, paused: p }) {
      if (student_name !== studentNameRef.current) return
      pausedRef.current = p
      setPaused(p)
      if (p) {
        // Starting a break: cancel any pending away-episode so the break
        // itself never counts, and let the student leave the page freely.
        cameBack()
        setAwayBlocked(false)
      } else {
        // Break over: pull the student back into the exam.
        requestFullscreen()
      }
    }
    socket.on('connect', join)
    socket.on('pause_state', onPauseState)
    return () => {
      flushKeystrokes()
      socket.off('connect', join)
      socket.off('pause_state', onPauseState)
      socket.disconnect()
    }
  }, [enabled, sessionId, flushKeystrokes, cameBack, requestFullscreen])

  useEffect(() => {
    if (!enabled || !s.log_keystrokes) return
    flushTimerRef.current = setInterval(flushKeystrokes, 15000)
    return () => clearInterval(flushTimerRef.current)
  }, [enabled, s.log_keystrokes, flushKeystrokes])

  // ── Fullscreen ────────────────────────────────────────────────────────────
  useEffect(() => { if (!enabled) return; requestFullscreen() }, [enabled, requestFullscreen])

  useEffect(() => {
    if (!enabled) return
    function onFsChange() {
      const fs = Boolean(document.fullscreenElement || document.webkitFullscreenElement)
      setIsFullscreen(fs)
      if (s.navigation === 'off') return
      if (fs) cameBack()
      else    goneAway('Exited fullscreen')
    }
    document.addEventListener('fullscreenchange',       onFsChange)
    document.addEventListener('webkitfullscreenchange', onFsChange)
    return () => {
      document.removeEventListener('fullscreenchange',       onFsChange)
      document.removeEventListener('webkitfullscreenchange', onFsChange)
    }
  }, [enabled, s.navigation, goneAway, cameBack])

  // ── Navigation — visibility change ────────────────────────────────────────
  useEffect(() => {
    if (!enabled || s.navigation === 'off') return
    function onVisibilityChange() {
      if (document.hidden) goneAway('Left the exam tab')
      else                 cameBack()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [enabled, s.navigation, goneAway, cameBack])

  // ── Navigation — window blur/focus (macOS fullscreen app switch, Tab to
  //    browser chrome). A blur that regains focus within the grace window is
  //    forgiven, which absorbs accidental Tab-key focus jumps. ───────────────
  useEffect(() => {
    if (!enabled || s.navigation === 'off') return
    function onBlur()  { goneAway('Switched to another window or app') }
    function onFocus() { cameBack() }
    window.addEventListener('blur',  onBlur)
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('blur',  onBlur)
      window.removeEventListener('focus', onFocus)
    }
  }, [enabled, s.navigation, goneAway, cameBack])

  // ── Navigation — prevent accidental page close/refresh ───────────────────
  useEffect(() => {
    if (!enabled || s.navigation === 'off') return
    function onBeforeUnload(e) { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [enabled, s.navigation])

  // ── Copy / paste ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled || s.copy_paste === 'off') return
    function onCopy(e) {
      if (s.copy_paste === 'block') { e.preventDefault(); warn('Copying is not allowed during this exam') }
      recordNote('copied text')  // always track regardless of block/track
    }
    function onPaste(e) {
      if (s.copy_paste === 'block') { e.preventDefault(); warn('Pasting is not allowed during this exam') }
      recordNote('pasted text')  // always track regardless of block/track
    }
    document.addEventListener('copy',  onCopy)
    document.addEventListener('paste', onPaste)
    return () => { document.removeEventListener('copy', onCopy); document.removeEventListener('paste', onPaste) }
  }, [enabled, s.copy_paste])

  // ── Keystroke logging ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled || !s.log_keystrokes) return
    function onKeyDown(e) {
      if (['Control', 'Meta', 'Alt', 'Shift'].includes(e.key)) return
      keystrokeBuffer.current.push({ key: e.key, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey, at: Date.now() })
    }
    document.addEventListener('keydown', onKeyDown, { capture: true })
    return () => document.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [enabled, s.log_keystrokes])

  // ── Block keyboard shortcuts (always on) ─────────────────────────────────
  useEffect(() => {
    if (!enabled) return
    function onKeyDown(e) {
      const ctrl = e.ctrlKey || e.metaKey
      const blocked = [
        ctrl && ['t', 'n', 'w', 'r', 'l'].includes(e.key.toLowerCase()),
        ctrl && e.key === 'Tab',
        ctrl && e.shiftKey && ['i', 'j', 'c'].includes(e.key.toLowerCase()),
        e.key === 'F12', e.key === 'F5',
        e.altKey && e.key === 'Tab',
      ].some(Boolean)
      if (blocked) { e.preventDefault(); e.stopPropagation(); warn('That shortcut is disabled during the exam') }
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

  return { violations, isFullscreen, warningMsg, awayBlocked, setAwayBlocked, paused, requestFullscreen, recordNote }
}
