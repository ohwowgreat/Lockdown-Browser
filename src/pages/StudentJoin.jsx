import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import styles from './StudentJoin.module.css'

export default function StudentJoin() {
  const nav = useNavigate()
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function join() {
    if (!code.trim() || !name.trim()) { setError('Please enter both your name and the exam code.'); return }
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/exams/code/${code.trim()}`)
      if (!res.ok) { setError('Invalid exam code. Check with your teacher.'); setLoading(false); return }
      const exam = await res.json()
      // Store in session storage so StudentExam can pick it up
      sessionStorage.setItem('exam', JSON.stringify(exam))
      sessionStorage.setItem('studentName', name.trim())
      nav('/student/exam')
    } catch {
      setError('Could not connect. Make sure you are on the same network as your teacher.')
      setLoading(false)
    }
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.card}>
        <div className={styles.logo}>ExamLock</div>
        <h1>Join Exam</h1>
        <p className={styles.sub}>Enter the code your teacher gave you</p>

        <div className={styles.field}>
          <label>Your Name</label>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="First and Last Name"
            onKeyDown={e => e.key === 'Enter' && join()}
          />
        </div>

        <div className={styles.field}>
          <label>Exam Code</label>
          <input
            value={code}
            onChange={e => setCode(e.target.value.toUpperCase())}
            placeholder="e.g. AB3X7K"
            className={styles.codeInput}
            maxLength={8}
            onKeyDown={e => e.key === 'Enter' && join()}
          />
        </div>

        {error && <p className={styles.error}>{error}</p>}

        <button className={`btn-primary ${styles.joinBtn}`} onClick={join} disabled={loading}>
          {loading ? 'Joining...' : 'Join Exam →'}
        </button>

        <p className={styles.warning}>
          Once you start, the exam will go fullscreen. Switching tabs or windows will be flagged as a violation.
        </p>
      </div>
    </div>
  )
}
