import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import styles from './AdminDashboard.module.css'

function StatCard({ label, value }) {
  return (
    <div className={styles.statCard}>
      <span className={styles.statValue}>{value}</span>
      <span className={styles.statLabel}>{label}</span>
    </div>
  )
}

export default function AdminDashboard() {
  const nav = useNavigate()
  const { teacher, logout, authHeaders } = useAuth()
  const [stats, setStats] = useState(null)
  const [teachers, setTeachers] = useState([])
  const [expandedId, setExpandedId] = useState(null)
  const [teacherExams, setTeacherExams] = useState({})

  useEffect(() => {
    load()
  }, [])

  function load() {
    fetch('/api/admin/stats',    { headers: authHeaders() }).then(r => r.json()).then(setStats)
    fetch('/api/admin/teachers', { headers: authHeaders() }).then(r => r.json()).then(setTeachers)
  }

  async function toggleSuspend(t) {
    await fetch(`/api/admin/teachers/${t.id}/suspend`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ is_suspended: !t.is_suspended })
    })
    setTeachers(ts => ts.map(x => x.id === t.id ? { ...x, is_suspended: !x.is_suspended } : x))
  }

  async function deleteTeacher(t) {
    if (!confirm(`Delete ${t.name} (${t.email}) and all their exams? This cannot be undone.`)) return
    await fetch(`/api/admin/teachers/${t.id}`, { method: 'DELETE', headers: authHeaders() })
    setTeachers(ts => ts.filter(x => x.id !== t.id))
    load() // refresh stats
  }

  async function toggleExpand(t) {
    if (expandedId === t.id) { setExpandedId(null); return }
    setExpandedId(t.id)
    if (!teacherExams[t.id]) {
      const exams = await fetch(`/api/admin/teachers/${t.id}/exams`, { headers: authHeaders() }).then(r => r.json())
      setTeacherExams(prev => ({ ...prev, [t.id]: exams }))
    }
  }

  return (
    <div className={styles.wrap}>
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <span className={styles.logo}>ExamLock</span>
          <span className={styles.adminBadge}>Admin</span>
        </div>
        <button className="btn-ghost" onClick={() => { logout(); nav('/') }}>Log out</button>
      </header>

      <main className={styles.main}>
        <h1>Admin Dashboard</h1>

        {stats && (
          <div className={styles.statsRow}>
            <StatCard label="Teachers" value={stats.teachers} />
            <StatCard label="Exams" value={stats.exams} />
            <StatCard label="Sessions" value={stats.sessions} />
            <StatCard label="Submissions" value={stats.submissions} />
          </div>
        )}

        <section style={{ marginTop: '2rem' }}>
          <h2>Registered Teachers ({teachers.length})</h2>

          {teachers.length === 0 && (
            <p className={styles.empty}>No teachers registered yet.</p>
          )}

          <div className={styles.teacherList}>
            {teachers.map(t => (
              <div key={t.id} className={`card ${styles.teacherCard}`}>
                <div className={styles.teacherRow}>
                  <div className={styles.teacherInfo}>
                    <div className={styles.teacherName}>
                      {t.name}
                      {t.is_suspended ? (
                        <span className="badge badge-red" style={{ marginLeft: '0.5rem' }}>Suspended</span>
                      ) : (
                        <span className="badge badge-green" style={{ marginLeft: '0.5rem' }}>Active</span>
                      )}
                    </div>
                    <div className={styles.teacherMeta}>
                      {t.email} · {t.exam_count} exam{t.exam_count !== 1 ? 's' : ''} · Joined {new Date(t.created_at * 1000).toLocaleDateString()}
                    </div>
                  </div>

                  <div className={styles.teacherActions}>
                    <button className="btn-ghost" onClick={() => toggleExpand(t)}>
                      {expandedId === t.id ? 'Hide Exams ▲' : `View Exams (${t.exam_count}) ▼`}
                    </button>
                    <button
                      className={t.is_suspended ? 'btn-primary' : 'btn-ghost'}
                      onClick={() => toggleSuspend(t)}
                    >
                      {t.is_suspended ? 'Unsuspend' : 'Suspend'}
                    </button>
                    <button className="btn-danger" onClick={() => deleteTeacher(t)}>
                      Delete
                    </button>
                  </div>
                </div>

                {expandedId === t.id && (
                  <div className={styles.examList}>
                    {!teacherExams[t.id] && <p className={styles.empty}>Loading...</p>}
                    {teacherExams[t.id]?.length === 0 && <p className={styles.empty}>No exams yet.</p>}
                    {teacherExams[t.id]?.map(exam => (
                      <div key={exam.id} className={styles.examRow}>
                        <div className={styles.examInfo}>
                          <span className={styles.examTitle}>{exam.title}</span>
                          <span className={styles.examMeta}>
                            Code: <strong>{exam.code}</strong> ·
                            {exam.questions?.length} questions ·
                            {exam.submission_count} submission{exam.submission_count !== 1 ? 's' : ''} ·
                            {exam.is_active ? <span className={styles.open}> Open</span> : <span className={styles.closed}> Closed</span>}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  )
}
