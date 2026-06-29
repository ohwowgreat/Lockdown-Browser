import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import styles from './TeacherDashboard.module.css'

export default function TeacherDashboard() {
  const nav = useNavigate()
  const { teacher, logout, authHeaders } = useAuth()
  const [exams, setExams] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/exams', { headers: authHeaders() })
      .then(r => r.json())
      .then(data => { setExams(data); setLoading(false) })
  }, [])

  async function deleteExam(id) {
    if (!confirm('Delete this exam?')) return
    await fetch(`/api/exams/${id}`, { method: 'DELETE', headers: authHeaders() })
    setExams(exams.filter(e => e.id !== id))
  }

  async function toggleActive(exam) {
    const next = !exam.is_active
    const res = await fetch(`/api/exams/${exam.id}/active`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ is_active: next })
    })
    const data = await res.json()
    setExams(exams.map(e =>
      e.id === exam.id
        ? { ...e, is_active: next, active_session_id: data.session_id || e.active_session_id }
        : e
    ))
  }

  function viewResults(exam) {
    nav(`/teacher/exam/${exam.id}/monitor?session=${exam.active_session_id || ''}`)
  }

  return (
    <div className={styles.wrap}>
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <span className={styles.logo} onClick={() => nav('/')}>ExamLock</span>
          <span className={styles.role}>Teacher</span>
          <span className={styles.teacherName}>{teacher?.name}</span>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button className="btn-primary" onClick={() => nav('/teacher/exam/new')}>+ New Exam</button>
          <button className="btn-ghost" onClick={() => { logout(); nav('/') }}>Log out</button>
        </div>
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
                <div className={styles.examTopRight}>
                  <span className={`badge ${exam.is_active ? 'badge-green' : 'badge-yellow'}`}>
                    {exam.is_active ? '● Open' : '○ Closed'}
                  </span>
                  <span className="badge badge-blue">{exam.code}</span>
                </div>
              </div>
              <p className={styles.meta}>
                {exam.questions.length} question{exam.questions.length !== 1 ? 's' : ''}
                {exam.time_limit > 0 ? ` · ${exam.time_limit} min` : ' · No time limit'}
              </p>
              <div className={styles.examActions}>
                <button
                  className={exam.is_active ? 'btn-danger' : 'btn-primary'}
                  onClick={() => toggleActive(exam)}
                >
                  {exam.is_active ? 'Close Exam' : 'Open Exam'}
                </button>
                <button className="btn-ghost" onClick={() => nav(`/teacher/exam/${exam.id}/preview`)}>
                  Preview
                </button>
                <button className="btn-ghost" onClick={() => viewResults(exam)}>
                  View Results
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
