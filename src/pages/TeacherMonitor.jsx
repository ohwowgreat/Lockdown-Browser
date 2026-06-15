import React, { useEffect, useState, useRef } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { io } from 'socket.io-client'
import { useAuth } from '../context/AuthContext'
import styles from './TeacherMonitor.module.css'

function calcScore(questions, answers) {
  const mc = questions.filter(q => q.type === 'multiple_choice')
  if (mc.length === 0) return null
  const correct = mc.filter(q => answers[q.id] === q.correct).length
  return { correct, total: mc.length }
}

function SubmissionCard({ sub, exam, events }) {
  const [open, setOpen] = useState(false)
  if (!exam) return null

  const score = calcScore(exam.questions, sub.answers || {})
  const studentEvents = (events || []).filter(e => e.student_name === sub.student_name)
  const copyPasteCount = studentEvents.filter(e => e.type === 'note').length

  return (
    <div className={`card ${styles.submissionCard}`}>
      {/* Summary row — always visible */}
      <button className={styles.subToggle} onClick={() => setOpen(o => !o)}>
        <div className={styles.subLeft}>
          <strong>{sub.student_name}</strong>
          <div className={styles.subBadges}>
            {score && (
              <span className={`badge ${score.correct === score.total ? 'badge-green' : score.correct >= score.total / 2 ? 'badge-blue' : 'badge-red'}`}>
                {score.correct}/{score.total} correct
              </span>
            )}
            {sub.violations > 0 && (
              <span className="badge badge-yellow">⚠️ {sub.violations} violation{sub.violations !== 1 ? 's' : ''}</span>
            )}
            {copyPasteCount > 0 && (
              <span className="badge badge-blue">📋 {copyPasteCount} copy/paste</span>
            )}
            <span className="badge badge-green">Submitted</span>
          </div>
        </div>
        <span className={styles.subChevron}>{open ? '▲' : '▼'}</span>
      </button>

      {/* Expanded detail */}
      {open && (
        <div className={styles.subDetail}>
          {/* Answers */}
          <h3 className={styles.subSection}>Answers</h3>
          <div className={styles.answers}>
            {exam.questions.map((q, qi) => {
              const ans = sub.answers?.[q.id]
              const isCorrect = q.type === 'multiple_choice' ? ans === q.correct : null
              return (
                <div
                  key={q.id}
                  className={`${styles.answerRow} ${
                    isCorrect === true ? styles.answerCorrect :
                    isCorrect === false ? styles.answerWrong : ''
                  }`}
                >
                  <div className={styles.answerMeta}>
                    <span className={styles.answerQNum}>Q{qi + 1}</span>
                    <span className={styles.answerType}>{q.type.replace('_', ' ')}</span>
                    {isCorrect === true  && <span className={styles.answerMark}>✓ Correct</span>}
                    {isCorrect === false && <span className={styles.answerMarkWrong}>✗ Wrong</span>}
                  </div>
                  <p className={styles.answerQ}>{q.text}</p>
                  {q.type === 'drawing' ? (
                    ans
                      ? <img src={ans} alt="Student drawing" style={{ maxWidth: '100%', maxHeight: 200, borderRadius: 6, border: '1px solid var(--border)', marginTop: 4 }} />
                      : <p className={styles.noAnswer}>(no drawing)</p>
                  ) : q.type === 'multiple_choice' ? (
                    <div className={styles.mcOptions}>
                      {q.options.map((opt, i) => (
                        <div
                          key={i}
                          className={`${styles.mcOpt}
                            ${i === q.correct ? styles.mcCorrect : ''}
                            ${ans === i && i !== q.correct ? styles.mcChosen : ''}
                          `}
                        >
                          {i === q.correct && '✓ '}
                          {ans === i && i !== q.correct && '✗ '}
                          {opt}
                          {i === q.correct && ans !== i && <span className={styles.mcHint}> (correct answer)</span>}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className={styles.answerA}>{ans || <em className={styles.noAnswer}>(no answer)</em>}</p>
                  )}

                </div>
              )
            })}
          </div>

          {/* Event log */}
          {studentEvents.length > 0 && (
            <>
              <h3 className={styles.subSection} style={{ marginTop: '1.25rem' }}>Activity Log</h3>
              <div className={styles.eventList}>
                {studentEvents.map((e, i) => (
                  <div key={i} className={`${styles.eventRow} ${styles[`event_${e.type}`]}`}>
                    <span className={styles.eventTime}>
                      {new Date(e.at).toLocaleTimeString()}
                    </span>
                    <span className={styles.eventMsg}>
                      {e.type === 'violation'    && '⚠️ '}
                      {e.type === 'note'         && '📋 '}
                      {e.type === 'submitted'    && '✅ '}
                      {e.type === 'joined'       && '→ '}
                      {e.type === 'disconnected' && '← '}
                      {e.type === 'keystrokes'   && '⌨️ '}
                      {e.detail || e.type}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

export default function TeacherMonitor() {
  const nav = useNavigate()
  const { id: examId } = useParams()
  const [params] = useSearchParams()
  const { authHeaders } = useAuth()

  const [exam, setExam] = useState(null)
  const [sid, setSid] = useState(null)          // resolved session id
  const [students, setStudents] = useState([])
  const [submissions, setSubmissions] = useState([])
  const [events, setEvents] = useState([])
  const [log, setLog] = useState([])
  const socketRef = useRef(null)
  const sidRef = useRef(null)                   // always-current sid for socket callbacks

  // Phase 1 — load exam, derive real session id
  useEffect(() => {
    fetch(`/api/exams/${examId}`, { headers: authHeaders() })
      .then(r => r.json())
      .then(examData => {
        setExam(examData)
        // prefer URL param, fall back to exam's active_session_id
        const urlSid = params.get('session')
        const resolved = (urlSid && urlSid !== 'null') ? urlSid : examData.active_session_id
        setSid(resolved)
        sidRef.current = resolved
      })
  }, [examId])

  // Phase 2 — once we have a real session id, load data + connect socket
  useEffect(() => {
    if (!sid) return

    function loadData() {
      // Load submissions and events in parallel, then rebuild students from both
      Promise.all([
        fetch(`/api/sessions/${sid}/submissions`, { headers: authHeaders() }).then(r => r.json()),
        fetch(`/api/sessions/${sid}/events`,      { headers: authHeaders() }).then(r => r.json()),
      ]).then(([subs, evts]) => {
        setSubmissions(subs)
        setEvents(evts)
        // Rebuild students list from DB so the box is always populated
        // even when the teacher opens the monitor after students joined
        const studentMap = {}
        for (const e of evts) {
          if (!studentMap[e.student_name]) {
            studentMap[e.student_name] = { name: e.student_name, violations: 0, notes: 0, submitted: false, ip: null, paused: false }
          }
          if (e.type === 'violation') {
            const num = parseInt(e.detail?.match(/#(\d+)/)?.[1] || 0)
            studentMap[e.student_name].violations = Math.max(studentMap[e.student_name].violations, num)
          }
          if (e.type === 'note')      studentMap[e.student_name].notes += 1
          if (e.type === 'submitted') studentMap[e.student_name].submitted = true
          if (e.type === 'paused')    studentMap[e.student_name].paused = true
          if (e.type === 'resumed')   studentMap[e.student_name].paused = false
          if (e.type === 'joined' && e.detail?.startsWith('IP ')) studentMap[e.student_name].ip = e.detail.slice(3)
        }
        // Also mark submitted from submissions table
        for (const s of subs) {
          if (!studentMap[s.student_name]) {
            studentMap[s.student_name] = { name: s.student_name, violations: s.violations, notes: 0, submitted: true, ip: s.ip || null, paused: false }
          } else {
            studentMap[s.student_name].submitted = true
            studentMap[s.student_name].violations = Math.max(studentMap[s.student_name].violations, s.violations)
            studentMap[s.student_name].ip = studentMap[s.student_name].ip || s.ip || null
          }
        }
        setStudents(Object.values(studentMap))
      })
    }

    loadData()

    const socket = io()
    socketRef.current = socket

    function joinRoom() {
      socket.emit('join_session', { session_id: sid })
    }

    // Re-join the room on every (re)connect and reload data in case we missed events
    socket.on('connect', () => {
      joinRoom()
      loadData()
    })

    socket.on('student_joined', ({ student_name, ip }) => {
      setStudents(s => s.find(x => x.name === student_name)
        ? s.map(x => x.name === student_name ? { ...x, ip: x.ip || ip || null } : x)
        : [...s, { name: student_name, violations: 0, notes: 0, submitted: false, ip: ip || null, paused: false }])
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

    socket.on('student_violation', ({ student_name, count, at }) => {
      setStudents(s => s.map(x => x.name === student_name ? { ...x, violations: count } : x))
      addLog(`${student_name} switched away (violation #${count})`, 'warn')
      appendEvent(student_name, 'violation', `#${count} – switched away from exam`, at)
    })

    socket.on('student_note', ({ student_name, action, at }) => {
      setStudents(s => s.map(x => x.name === student_name ? { ...x, notes: (x.notes || 0) + 1 } : x))
      addLog(`${student_name} ${action}`, 'note')
      appendEvent(student_name, 'note', action, at)
    })

    socket.on('student_keystrokes', ({ student_name, keys, at }) => {
      const preview = keys.slice(0, 8).map(k => k.key).join(', ') + (keys.length > 8 ? '…' : '')
      addLog(`${student_name} typed: ${preview}`, 'keystroke')
      appendEvent(student_name, 'keystrokes', keys.map(k => k.key).join(', '), at)
    })

    socket.on('submission', ({ student_name, violations, answers, ip, submitted_at }) => {
      setStudents(s => s.map(x => x.name === student_name ? { ...x, submitted: true, ip: x.ip || ip || null } : x))
      setSubmissions(prev => {
        if (prev.find(p => p.student_name === student_name)) return prev
        return [...prev, { student_name, violations, answers: answers || {}, ip, submitted_at }]
      })
      addLog(`${student_name} submitted`, 'ok')
      appendEvent(student_name, 'submitted', null, submitted_at)
    })

    return () => socket.disconnect()
  }, [sid])

  function addLog(msg, type = 'info') {
    setLog(l => [{ msg, type, time: new Date().toLocaleTimeString() }, ...l].slice(0, 50))
  }

  function appendEvent(student_name, type, detail = null, at = Date.now()) {
    setEvents(ev => [...ev, { session_id: sidRef.current, student_name, type, detail, at }])
  }

  function togglePause(student_name, paused) {
    socketRef.current?.emit('set_pause', { session_id: sidRef.current, student_name, paused })
  }

  const examUrl = `${window.location.origin}/student`

  return (
    <div className={styles.wrap}>
      <header className={styles.header}>
        <button className="btn-ghost" onClick={() => nav('/teacher')}>← Dashboard</button>
        <h1>{exam?.title ?? 'Loading...'}</h1>
        <div className={styles.sessionInfo}>
          <span className={styles.code}>{exam?.code}</span>
          <span className={`${styles.sessionLabel} ${exam?.is_active ? styles.sessionOpen : styles.sessionClosed}`}>
            {exam?.is_active ? '● Open' : '○ Closed'}
          </span>
        </div>
      </header>

      <main className={styles.main}>
        <div className={styles.joinBox}>
          <p>Students go to <strong>{examUrl}</strong> and enter code <strong>{exam?.code}</strong></p>
        </div>

        <div className={styles.grid}>
          <section>
            <h2>Live Students ({students.length})</h2>
            <div className={styles.studentList}>
              {students.length === 0 && <p className={styles.empty}>Waiting for students to join...</p>}
              {students.map(s => (
                <div key={s.name} className={styles.studentRow}>
                  <span className={styles.studentName}>
                    {s.name}
                    {s.ip && <span className={styles.studentIp}>{s.ip}</span>}
                  </span>
                  <div className={styles.studentBadges}>
                    {s.violations > 0 && (
                      <span className="badge badge-yellow">⚠️ {s.violations} violation{s.violations > 1 ? 's' : ''}</span>
                    )}
                    {s.notes > 0 && (
                      <span className="badge badge-blue">📋 {s.notes} copy/paste</span>
                    )}
                    {s.paused && !s.submitted && (
                      <span className="badge badge-yellow">⏸️ On break</span>
                    )}
                    {s.submitted
                      ? <span className="badge badge-green">Submitted</span>
                      : <span className="badge badge-blue">In Progress</span>
                    }
                    {!s.submitted && (
                      <button
                        className="btn-ghost"
                        style={{ padding: '0.2rem 0.6rem', fontSize: '0.8125rem' }}
                        onClick={() => togglePause(s.name, !s.paused)}
                      >
                        {s.paused ? 'Resume' : 'Pause'}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section>
            <h2>Activity Log</h2>
            <div className={styles.logBox}>
              {log.length === 0 && <p className={styles.empty}>No activity yet</p>}
              {log.map((l, i) => (
                <div key={i} className={`${styles.logRow} ${styles[`log_${l.type}`]}`}>
                  <span className={styles.logTime}>{l.time}</span>
                  <span>
                    {l.type === 'warn'      && '⚠️ '}
                    {l.type === 'note'      && '📋 '}
                    {l.type === 'ok'        && '✅ '}
                    {l.type === 'keystroke' && '⌨️ '}
                    {l.msg}
                  </span>
                </div>
              ))}
            </div>
          </section>
        </div>

        {/* Submissions */}
        <section style={{ marginTop: '1.5rem' }}>
          <div className={styles.subHeader2}>
            <h2>Submissions ({submissions.length})</h2>
            {submissions.length > 0 && (
              <a
                href={`/api/sessions/${sid}/export.csv`}
                download
                className={`btn-primary ${styles.exportBtn}`}
              >
                ↓ Export All as CSV
              </a>
            )}
          </div>

          {submissions.length === 0 && (
            <p className={styles.empty} style={{ padding: '2rem 0' }}>No submissions yet</p>
          )}

          <div className={styles.submissionList}>
            {submissions.map((s, i) => (
              <SubmissionCard
                key={s.student_name || i}
                sub={s}
                exam={exam}
                events={events}
              />
            ))}
          </div>
        </section>
      </main>
    </div>
  )
}
