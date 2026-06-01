import React, { useEffect, useState, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { ReactSketchCanvas } from 'react-sketch-canvas'
import { useLockdown } from '../hooks/useLockdown'
import styles from './StudentExam.module.css'

function DrawingAnswer({ value, onChange }) {
  const canvasRef = useRef(null)
  const [color, setColor] = useState('#000000')
  const [strokeWidth, setStrokeWidth] = useState(4)

  async function exportPng() {
    if (!canvasRef.current) return
    const data = await canvasRef.current.exportImage('png')
    onChange(data)
  }

  function clear() {
    canvasRef.current?.clearCanvas()
    onChange(null)
  }

  return (
    <div className={styles.drawingWrap}>
      <div className={styles.drawingToolbar}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontSize: '0.8125rem' }}>
          Color
          <input type="color" value={color} onChange={e => setColor(e.target.value)} style={{ width: 32, height: 28, padding: 0, border: 'none', cursor: 'pointer' }} />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontSize: '0.8125rem' }}>
          Size
          <input type="range" min="1" max="20" value={strokeWidth} onChange={e => setStrokeWidth(Number(e.target.value))} style={{ width: 80 }} />
        </label>
        <button className="btn-ghost" onClick={clear} style={{ padding: '0.25rem 0.75rem', fontSize: '0.8125rem' }}>Clear</button>
      </div>
      <ReactSketchCanvas
        ref={canvasRef}
        width="100%"
        height="300px"
        strokeWidth={strokeWidth}
        strokeColor={color}
        canvasColor="#ffffff"
        style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}
        onStroke={exportPng}
      />
      {value && <p className={styles.drawingSaved}>✓ Drawing saved</p>}
    </div>
  )
}

export default function StudentExam() {
  const nav = useNavigate()
  const [exam, setExam] = useState(null)
  const [studentName, setStudentName] = useState('')
  const [sessionId, setSessionId] = useState(null)
  const [answers, setAnswers] = useState({})
  const [timeLeft, setTimeLeft] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  // Load from sessionStorage
  useEffect(() => {
    const e = sessionStorage.getItem('exam')
    const n = sessionStorage.getItem('studentName')
    const s = sessionStorage.getItem('sessionId')
    if (!e || !n) { nav('/student'); return }
    const parsed = JSON.parse(e)
    setExam(parsed)
    setStudentName(n)

    // Use the teacher's active session — do NOT create a new one
    const activeSession = parsed.active_session_id
    if (!activeSession) { nav('/student'); return }
    setSessionId(activeSession)
    sessionStorage.setItem('sessionId', activeSession)

    // Timer
    if (parsed.time_limit > 0) {
      setTimeLeft(parsed.time_limit * 60)
    }
  }, [nav])

  // Countdown timer
  useEffect(() => {
    if (timeLeft === null || submitted) return
    if (timeLeft <= 0) { submitExam(); return }
    const t = setTimeout(() => setTimeLeft(t => t - 1), 1000)
    return () => clearTimeout(t)
  }, [timeLeft, submitted])

  const { violations, warningMsg, requestFullscreen, isFullscreen } = useLockdown({
    sessionId,
    studentName,
    enabled: Boolean(exam && !submitted),
  })

  const submitExam = useCallback(async () => {
    if (submitting || submitted || !sessionId) return
    setSubmitting(true)
    await fetch('/api/submissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, student_name: studentName, answers, violations }),
    })
    setSubmitted(true)
    // Exit fullscreen
    if (document.exitFullscreen) document.exitFullscreen()
    sessionStorage.clear()
    nav('/student/done')
  }, [submitting, submitted, sessionId, studentName, answers, violations, nav])

  function setAnswer(qid, value) {
    setAnswers(a => ({ ...a, [qid]: value }))
  }

  function formatTime(s) {
    const m = Math.floor(s / 60)
    const sec = s % 60
    return `${m}:${String(sec).padStart(2, '0')}`
  }

  if (!exam) return null

  const answered = exam.questions.filter(q => answers[q.id] !== undefined && answers[q.id] !== '').length
  const total = exam.questions.length

  return (
    <div className={styles.wrap}>
      {/* Warning toast */}
      {warningMsg && (
        <div className={styles.warningToast}>{warningMsg}</div>
      )}

      {/* Fullscreen nudge */}
      {!isFullscreen && !submitted && (
        <div className={styles.fsBar}>
          Exam should be fullscreen.
          <button onClick={requestFullscreen} className="btn-primary" style={{ marginLeft: '0.75rem', padding: '0.25rem 0.75rem' }}>
            Re-enter fullscreen
          </button>
        </div>
      )}

      <header className={styles.header}>
        <div className={styles.examTitle}>{exam.title}</div>
        <div className={styles.headerRight}>
          <span className={styles.progress}>{answered}/{total} answered</span>
          {timeLeft !== null && (
            <span className={`${styles.timer} ${timeLeft < 60 ? styles.timerRed : ''}`}>
              ⏱ {formatTime(timeLeft)}
            </span>
          )}
          {violations > 0 && (
            <span className="badge badge-yellow">⚠️ {violations} violation{violations > 1 ? 's' : ''}</span>
          )}
        </div>
      </header>

      <main className={styles.main}>
        {exam.questions.map((q, idx) => (
          <div key={q.id} className={`card ${styles.qCard}`}>
            <p className={styles.qNum}>Question {idx + 1}</p>
            <p className={styles.qText}>{q.text}</p>
            {q.image && <img src={q.image} alt="Question" className={styles.qImage} />}

            {q.type === 'multiple_choice' && (
              <div className={styles.options}>
                {q.options.map((opt, i) => (
                  <label key={i} className={`${styles.optLabel} ${answers[q.id] === i ? styles.selected : ''}`}>
                    <input type="radio" name={q.id} checked={answers[q.id] === i} onChange={() => setAnswer(q.id, i)} />
                    <span>{opt}</span>
                  </label>
                ))}
              </div>
            )}

            {q.type === 'short_answer' && (
              <input
                value={answers[q.id] || ''}
                onChange={e => setAnswer(q.id, e.target.value)}
                placeholder="Your answer..."
                className={styles.shortInput}
              />
            )}

            {q.type === 'essay' && (
              <textarea
                rows={6}
                value={answers[q.id] || ''}
                onChange={e => setAnswer(q.id, e.target.value)}
                placeholder="Write your answer here..."
                className={styles.essayInput}
              />
            )}

            {q.type === 'drawing' && (
              <DrawingAnswer
                value={answers[q.id]}
                onChange={val => setAnswer(q.id, val)}
              />
            )}
          </div>
        ))}

        <div className={styles.submitRow}>
          <button
            className={`btn-primary ${styles.submitBtn}`}
            onClick={submitExam}
            disabled={submitting}
          >
            {submitting ? 'Submitting...' : `Submit Exam (${answered}/${total} answered)`}
          </button>
        </div>
      </main>
    </div>
  )
}
