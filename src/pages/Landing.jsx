import React from 'react'
import { useNavigate } from 'react-router-dom'
import styles from './Landing.module.css'

export default function Landing() {
  const nav = useNavigate()
  return (
    <div className={styles.wrap}>
      <div className={styles.logo}>ExamLock</div>
      <p className={styles.tagline}>Secure in-class exams — no installs required</p>
      <div className={styles.cards}>
        <button className={styles.roleCard} onClick={() => nav('/teacher/login')}>
          <span className={styles.icon}>👩‍🏫</span>
          <strong>Teacher</strong>
          <span>Create &amp; monitor exams</span>
        </button>
        <button className={styles.roleCard} onClick={() => nav('/student')}>
          <span className={styles.icon}>🎒</span>
          <strong>Student</strong>
          <span>Join an exam session</span>
        </button>
      </div>
    </div>
  )
}
