import React, { useEffect, useState, useRef } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { io } from 'socket.io-client'
import styles from './TeacherMonitor.module.css'

export default function TeacherMonitor() {
  const nav = useNavigate()
  const { id: examId } = useParams()
  const [params] = useSearchParams()
  const sessionId = params.get('session')

  const [exam, setExam] = useState(null)
  const [students, setStudents] = useState([]) // live presence
  const [submissions, setSubmissions] = useState([])
  const [log, setLog] = useState([])
  const socketRef = useRef(null)

  useEffect(() => {
    fetch(`/api/exams/${examId}`).then(r => r.json()).then(setExam)
    fetch(`/api/sessions/${sessionId}/submissions`).then(r => r.json()).then(setSubmissions)

    const socket = io()
    socketRef.current = socket
    socket.emit('join_session', { session_id: sessionId })

    socket.on('student_joined', ({ student_name }) => {
      setStudents(s => s.find(x => x.name === student_name)
        ? s : [...s, { name: student_name, violations: 0, submitted: false }])
      addLog(`${student_name} joined`)
    })

    socket.on('student_left', ({ student_name }) => {
      addLog(`${student_name} disconnected`)
    })

    socket.on('student_violation', ({ student_name, count }) => {
      setStudents(s => s.map(x => x.name === student_name ? { ...x, violations: count } : x))
      addLog(`⚠️ ${student_name} switched away (violation #${count})`)
    })

    socket.on('submission', ({ student_name, violations }) => {
      setStudents(s => s.map(x => x.name === student_name ? { ...x, submitted: true } : x))
      setSubmissions(prev => [...prev, { student_name, violations, submitted_at: Date.now() }])
      addLog(`✅ ${student_name} submitted`)
    })

    return () => socket.disconnect()
  }, [sessionId, examId])

  function addLog(msg) {
    setLog(l => [{ msg, time: new Date().toLocaleTimeString() }, ...l].slice(0, 50))
  }

  const examUrl = `${window.location.origin}/student`

  return (
    <div className={styles.wrap}>
      <header className={styles.header}>
        <button className="btn-ghost" onClick={() => nav('/teacher')}>← Dashboard</button>
        <h1>{exam?.title ?? 'Loading...'}</h1>
        <div className={styles.sessionInfo}>
          <span className={styles.code}>{exam?.code}</span>
          <span className={styles.sessionLabel}>Active Session</span>
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
                <div key={i} className={styles.logRow}>
                  <span className={styles.logTime}>{l.time}</span>
                  <span>{l.msg}</span>
                </div>
              ))}
            </div>
          </section>
        </div>

        {submissions.length > 0 && (
          <section style={{ marginTop: '1.5rem' }}>
            <h2>Submissions ({submissions.length})</h2>
            <div className={styles.submissionList}>
              {submissions.map((s, i) => (
                <div key={i} className={`card ${styles.submissionCard}`}>
                  <div className={styles.subHeader}>
                    <strong>{s.student_name}</strong>
                    <span className={styles.subMeta}>
                      {s.violations > 0 && <span className="badge badge-yellow" style={{ marginRight: '0.5rem' }}>⚠️ {s.violations} violations</span>}
                      <span className="badge badge-green">Submitted</span>
                    </span>
                  </div>
                  {exam && s.answers && (
                    <div className={styles.answers}>
                      {exam.questions.map((q, qi) => (
                        <div key={q.id} className={styles.answerRow}>
                          <span className={styles.answerQ}>Q{qi + 1}: {q.text}</span>
                          <span className={styles.answerA}>
                            {q.type === 'multiple_choice'
                              ? `${q.options[s.answers[q.id]]} ${s.answers[q.id] === q.correct ? '✓' : '✗'}`
                              : s.answers[q.id] || '(no answer)'}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  )
}
