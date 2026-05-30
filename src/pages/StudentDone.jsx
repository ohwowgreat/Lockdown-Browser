import React from 'react'
import { useNavigate } from 'react-router-dom'
import styles from './StudentDone.module.css'

export default function StudentDone() {
  const nav = useNavigate()
  return (
    <div className={styles.wrap}>
      <div className={styles.card}>
        <div className={styles.icon}>✅</div>
        <h1>Exam Submitted</h1>
        <p>Your answers have been sent to your teacher. You can close this window.</p>
        <button className="btn-ghost" onClick={() => nav('/')}>Back to Home</button>
      </div>
    </div>
  )
}
