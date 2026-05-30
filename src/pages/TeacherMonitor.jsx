import React, { useEffect, useState, useRef } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { io } from 'socket.io-client'
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
                  {q.type === 'multiple_choice' ? (
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
  const sessionId = params.get('session')

  const [exam, setExam] = useState(null)
  const [students, setStudents] = useState([])
  const [submissions, setSubmissions] = useState([])
  const [events, setEvents] = useState([])
  const [log, setLog] = useState([])
  const socketRef = useRef(null)

  // Derive sessionId from exam rather than URL param if not provided
  const resolvedSessionId = sessionId || exam?.active_session_id

  useEffect(() => {
    fetch(`/api/exams/${examId}`).then(r => r.json()).then(setExam)
    fetch(`/api/sessions/${sessionId}/submissions`).then(r => r.json()).then(setSubmissions)
    fetch(`/api/sessions/${sessionId}/events`).then(r => r.json()).then(setEvents)

    const socket = io()
    socketRef.current = socket
    socket.emit('join_session', { session_id: sessionId })

    socket.on('student_joined', ({ student_name }) => {
      setStudents(s => s.find(x => x.name === student_name)
        ? s : [...s, { name: student_name, violations: 0, notes: 0, submitted: false }])
      addLog(`${student_name} joined`, 'info')
      appendEvent(sessionId, student_name, 'joined')
    })

    socket.on('student_left', ({ student_name }) => {
      addLog(`${student_name} disconnected`, 'info')
      appendEvent(sessionId, student_name, 'disconnected')
    })

    socket.on('student_violation', ({ student_name, count, at }) => {
      setStudents(s => s.map(x => x.name === student_name ? { ...x, violations: count } : x))
      addLog(`${student_name} switched away (violation #${count})`, 'warn')
      appendEvent(sessionId, student_name, 'violation', `#${count} – switched away from exam`, at)
    })

    socket.on('student_note', ({ student_name, action, at }) => {
      setStudents(s => s.map(x => x.name === student_name ? { ...x, notes: (x.notes || 0) + 1 } : x))
      addLog(`${student_name} ${action}`, 'note')
      appendEvent(sessionId, student_name, 'note', action, at)
    })

    socket.on('submission', ({ student_name, violations, answers, submitted_at }) => {
      setStudents(s => s.map(x => x.name === student_name ? { ...x, submitted: true } : x))
      setSubmissions(prev => {
        if (prev.find(p => p.student_name === student_name)) return prev
        return [...prev, { student_name, violations, answers: answers || {}, submitted_at }]
      })
      addLog(`${student_name} submitted`, 'ok')
      appendEvent(sessionId, student_name, 'submitted', null, submitted_at)
    })

    return () => socket.disconnect()
  }, [sessionId, examId])

  function addLog(msg, type = 'info') {
    setLog(l => [{ msg, type, time: new Date().toLocaleTimeString() }, ...l].slice(0, 50))
  }

  function appendEvent(session_id, student_name, type, detail = null, at = Date.now()) {
    setEvents(ev => [...ev, { session_id, student_name, type, detail, at }])
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
                  <span className={styles.studentName}>{s.name}</span>
                  <div className={styles.studentBadges}>
                    {s.violations > 0 && (
                      <span className="badge badge-yellow">⚠️ {s.violations} violation{s.violations > 1 ? 's' : ''}</span>
                    )}
                    {s.notes > 0 && (
                      <span className="badge badge-blue">📋 {s.notes} copy/paste</span>
                    )}
                    {s.submitted
                      ? <span className="badge badge-green">Submitted</span>
                      : <span className="badge badge-blue">In Progress</span>
                    }
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
                    {l.type === 'warn' && '⚠️ '}
                    {l.type === 'note' && '📋 '}
                    {l.type === 'ok'   && '✅ '}
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
                href={`/api/sessions/${sessionId}/export.csv`}
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
