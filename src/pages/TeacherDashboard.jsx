import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import styles from './TeacherDashboard.module.css'

export default function TeacherDashboard() {
  const nav = useNavigate()
  const [exams, setExams] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/exams')
      .then(r => r.json())
      .then(data => { setExams(data); setLoading(false) })
  }, [])

  async function deleteExam(id) {
    if (!confirm('Delete this exam?')) return
    await fetch(`/api/exams/${id}`, { method: 'DELETE' })
    setExams(exams.filter(e => e.id !== id))
  }

  async function startSession(examId) {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ exam_id: examId })
    })
    const { id: sessionId } = await res.json()
    nav(`/teacher/exam/${examId}/monitor?session=${sessionId}`)
  }

  return (
    <div className={styles.wrap}>
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <span className={styles.logo} onClick={() => nav('/')}>ExamLock</span>
          <span className={styles.role}>Teacher</span>
        </div>
        <button className="btn-primary" onClick={() => nav('/teacher/exam/new')}>
          + New Exam
        </button>
      </header>

      <main className={styles.main}>
        <h1>Your Exams</h1>

        {loading && <p className={styles.empty}>Loading...</p>}

        {!loading && exams.length === 0 && (
          <div className={`card ${styles.emptyCard}`}>
            <p>No exams yet. Create your first one!</p>
            <button className="btn-primary" onClick={() => nav('/teacher/exam/new')}>
              Create Exam
            </button>
          </div>
        )}

        <div className={styles.grid}>
          {exams.map(exam => (
            <div key={exam.id} className={`card ${styles.examCard}`}>
              <div className={styles.examTop}>
                <h2>{exam.title}</h2>
                <span className="badge badge-blue">{exam.code}</span>
              </div>
              <p className={styles.meta}>
                {exam.questions.length} question{exam.questions.length !== 1 ? 's' : ''}
                {exam.time_limit > 0 ? ` · ${exam.time_limit} min` : ' · No time limit'}
              </p>
              <div className={styles.examActions}>
                <button className="btn-primary" onClick={() => startSession(exam.id)}>
                  Start Session
                </button>
                <button className="btn-ghost" onClick={() => nav(`/teacher/exam/${exam.id}/edit`)}>
                  Edit
                </button>
                <button className="btn-danger" onClick={() => deleteExam(exam.id)}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      </main>
    </div>
  )
}
