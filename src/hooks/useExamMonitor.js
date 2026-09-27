import { useEffect, useRef, useState, useCallback } from 'react'
import { io } from 'socket.io-client'
import { useAuth } from '../context/AuthContext'

// One activity-log line per stored event, in the same words the live feed
// uses, so a reload shows the same log the teacher saw building up.
function logLine(e) {
  const name = e.student_name
  switch (e.type) {
    case 'joined': return [`${name} joined${e.detail?.startsWith('IP ') ? ` (${e.detail.slice(3)})` : ''}`, 'info']
    case 'disconnected': return [`${name} disconnected`, 'info']
    case 'violation': {
      const m = e.detail?.match(/^#(\d+) – (.*)$/)
      return [m ? `${name}: violation #${m[1]} (${m[2]})` : `${name}: violation ${e.detail || ''}`, 'warn']
    }
    case 'note': return [`${name} ${e.detail}`, 'note']
    case 'brief_exit': return [`${name} briefly left the exam (${e.detail})`, 'note']
    case 'env': return [`${name}: ${e.detail}`, 'env']
    case 'submitted': return [`${name} submitted`, 'ok']
    case 'paused': return [`${name} paused (break)`, 'info']
    case 'resumed': return [`${name} resumed`, 'info']
    case 'keystrokes': {
      const keys = (e.detail || '').split(', ')
      return [`${name} typed: ${keys.slice(0, 8).join(', ')}${keys.length > 8 ? '…' : ''}`, 'keystroke']
    }
    default: return [`${name}: ${e.detail || e.type}`, 'warn']
  }
}

const newStudent = (name, extra = {}) => ({
  name, violations: 0, notes: 0, briefExits: 0, envFlags: 0, submitted: false, ip: null, paused: false, ...extra,
})

// The teacher's live view of one exam sitting: who is in, what they have
// done, what they submitted, plus the actions the monitor offers. The sitting
// is the one in `sessionParam` when given, else the exam's current one.
export function useExamMonitor({ exam, sessionParam }) {
  const { authHeaders, getToken } = useAuth()
  const examId = exam?.id || null
  const sid = sessionParam || exam?.active_session_id || null

  const [sessions, setSessions] = useState([])
  const [students, setStudents] = useState([])
  const [submissions, setSubmissions] = useState([])
  const [events, setEvents] = useState([])
  const [log, setLog] = useState([])
  const [exporting, setExporting] = useState(false)
  const [denied, setDenied] = useState(false)
  const socketRef = useRef(null)
  const sidRef = useRef(sid)
  useEffect(() => { sidRef.current = sid }, [sid])

  const loadSessions = useCallback(() => {
    if (!examId) return Promise.resolve()
    return fetch(`/api/exams/${examId}/sessions`, { headers: authHeaders() })
      .then(r => (r.ok ? r.json() : []))
      .then(setSessions)
  }, [examId])
  useEffect(() => { loadSessions() }, [loadSessions, exam?.active_session_id])

  const addLog = useCallback((msg, type = 'info') => {
    setLog(l => [{ msg, type, time: new Date().toLocaleTimeString() }, ...l].slice(0, 50))
  }, [])
  const appendEvent = useCallback((student_name, type, detail = null, at = Date.now()) => {
    setEvents(ev => [...ev, { session_id: sidRef.current, student_name, type, detail, at }])
  }, [])

  // Load the sitting's data and join its live feed. Re-runs whenever the
  // sitting changes, starting from a clean slate each time.
  useEffect(() => {
    if (!sid) return
    setStudents([]); setSubmissions([]); setEvents([]); setLog([]); setDenied(false)

    function loadData() {
      Promise.all([
        fetch(`/api/sessions/${sid}/submissions`, { headers: authHeaders() }).then(r => (r.ok ? r.json() : [])),
        fetch(`/api/sessions/${sid}/events`, { headers: authHeaders() }).then(r => (r.ok ? r.json() : [])),
      ]).then(([subs, evts]) => {
        setSubmissions(subs)
        setEvents(evts)
        setLog(evts.slice(-50).reverse().map(e => {
          const [msg, type] = logLine(e)
          return { msg, type, time: new Date(e.at).toLocaleTimeString() }
        }))
        const map = {}
        for (const e of evts) {
          if (!map[e.student_name]) map[e.student_name] = newStudent(e.student_name)
          const s = map[e.student_name]
          if (e.type === 'violation') s.violations = Math.max(s.violations, parseInt(e.detail?.match(/#(\d+)/)?.[1] || 0))
          if (e.type === 'note') s.notes += 1
          if (e.type === 'brief_exit') s.briefExits += 1
          if (e.type === 'env') s.envFlags += 1
          if (e.type === 'submitted') s.submitted = true
          if (e.type === 'paused') s.paused = true
          if (e.type === 'resumed') s.paused = false
          if (e.type === 'joined' && e.detail?.startsWith('IP ')) s.ip = e.detail.slice(3)
        }
        for (const sub of subs) {
          if (!map[sub.student_name]) map[sub.student_name] = newStudent(sub.student_name, { violations: sub.violations, submitted: true, ip: sub.ip || null })
          else {
            const s = map[sub.student_name]
            s.submitted = true
            s.violations = Math.max(s.violations, sub.violations)
            s.ip = s.ip || sub.ip || null
          }
        }
        setStudents(Object.values(map))
      })
    }

    loadData()
    const socket = io()
    socketRef.current = socket

    socket.on('connect', () => {
      // Teacher-only feed: the server checks the token and exam ownership.
      socket.emit('join_session', { session_id: sid, token: getToken() })
      loadData()
    })
    socket.on('join_denied', () => {
      setDenied(true)
      addLog('Live updates unavailable: not authorized for this session', 'warn')
    })
    socket.on('student_joined', ({ student_name, ip }) => {
      setStudents(s => s.find(x => x.name === student_name)
        ? s.map(x => x.name === student_name ? { ...x, ip: x.ip || ip || null } : x)
        : [...s, newStudent(student_name, { ip: ip || null })])
      addLog(`${student_name} joined${ip ? ` (${ip})` : ''}`, 'info')
      appendEvent(student_name, 'joined', ip ? `IP ${ip}` : null)
    })
    socket.on('pause_state', ({ student_name, paused, at }) => {
      setStudents(s => s.map(x => x.name === student_name ? { ...x, paused } : x))
      addLog(`${student_name} ${paused ? 'paused (break)' : 'resumed'}`, 'info')
      appendEvent(student_name, paused ? 'paused' : 'resumed', null, at)
    })
    socket.on('student_left', ({ student_name }) => {
      addLog(`${student_name} disconnected`, 'info')
      appendEvent(student_name, 'disconnected')
    })
    socket.on('student_violation', ({ student_name, count, reason, at }) => {
      const why = reason || 'switched away from exam'
      setStudents(s => s.map(x => x.name === student_name ? { ...x, violations: count } : x))
      addLog(`${student_name}: violation #${count} (${why})`, 'warn')
      appendEvent(student_name, 'violation', `#${count} – ${why}`, at)
    })
    socket.on('student_note', ({ student_name, action, at }) => {
      setStudents(s => s.map(x => x.name === student_name ? { ...x, notes: (x.notes || 0) + 1 } : x))
      addLog(`${student_name} ${action}`, 'note')
      appendEvent(student_name, 'note', action, at)
    })
    socket.on('student_brief_exit', ({ student_name, reason, at }) => {
      setStudents(s => s.map(x => x.name === student_name ? { ...x, briefExits: (x.briefExits || 0) + 1 } : x))
      addLog(`${student_name} briefly left the exam (${reason})`, 'note')
      appendEvent(student_name, 'brief_exit', reason, at)
    })
    socket.on('student_env', ({ student_name, detail, at }) => {
      setStudents(s => s.map(x => x.name === student_name ? { ...x, envFlags: (x.envFlags || 0) + 1 } : x))
      addLog(`${student_name}: ${detail}`, 'env')
      appendEvent(student_name, 'env', detail, at)
    })
    socket.on('student_flag', ({ student_name, type, detail, at }) => {
      addLog(`${student_name}: ${detail}`, 'warn')
      appendEvent(student_name, type, detail, at)
    })
    socket.on('student_keystrokes', ({ student_name, keys, at }) => {
      const preview = keys.slice(0, 8).map(k => k.key).join(', ') + (keys.length > 8 ? '…' : '')
      addLog(`${student_name} typed: ${preview}`, 'keystroke')
      appendEvent(student_name, 'keystrokes', keys.map(k => k.key).join(', '), at)
    })
    socket.on('submission', ({ student_name, violations, answers, ip, submitted_at }) => {
      loadSessions()
      setStudents(s => s.map(x => x.name === student_name ? { ...x, submitted: true, ip: x.ip || ip || null } : x))
      setSubmissions(prev => prev.find(p => p.student_name === student_name)
        ? prev
        : [...prev, { student_name, violations, answers: answers || {}, ip, submitted_at }])
      addLog(`${student_name} submitted`, 'ok')
      appendEvent(student_name, 'submitted', null, submitted_at)
    })

    return () => { socket.disconnect(); socketRef.current = null }
  }, [sid])

  const togglePause = useCallback((student_name, paused) => {
    socketRef.current?.emit('set_pause', { session_id: sidRef.current, student_name, paused })
  }, [])

  // The export route needs the bearer token, which a plain download link
  // cannot send: fetch with auth, then hand the browser the file.
  const exportCsv = useCallback(async () => {
    if (!sidRef.current) return
    setExporting(true)
    try {
      const res = await fetch(`/api/sessions/${sidRef.current}/export.csv`, { headers: authHeaders() })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      const disposition = res.headers.get('Content-Disposition') || ''
      const filename = disposition.match(/filename="([^"]+)"/)?.[1] || 'results.csv'
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch {
      alert('Could not export results. Please try again.')
    } finally {
      setExporting(false)
    }
  }, [])

  const isCurrentSitting = !exam || !sid || sid === exam.active_session_id

  return { sid, sessions, students, submissions, events, log, exporting, denied, isCurrentSitting, togglePause, exportCsv, loadSessions }
}
