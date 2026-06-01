import React, { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import styles from './TeacherLogin.module.css'

export default function TeacherLogin() {
  const nav = useNavigate()
  const { login } = useAuth()
  const [mode, setMode] = useState('login') // 'login' | 'register'
  const [form, setForm] = useState({ email: '', password: '', name: '' })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  function set(field) {
    return e => setForm(f => ({ ...f, [field]: e.target.value }))
  }

  async function submit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    const url = mode === 'login' ? '/api/auth/login' : '/api/auth/register'
    const body = mode === 'login'
      ? { email: form.email, password: form.password }
      : { email: form.email, password: form.password, name: form.name }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    const data = await res.json()
    setLoading(false)
    if (!res.ok) { setError(data.error); return }
    login(data.token, data.teacher)
    nav('/teacher')
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.card}>
        <div className={styles.logo} onClick={() => nav('/')}>ExamLock</div>
        <h1>{mode === 'login' ? 'Teacher Login' : 'Create Account'}</h1>

        <form onSubmit={submit} className={styles.form}>
          {mode === 'register' && (
            <div className={styles.field}>
              <label>Your Name</label>
              <input value={form.name} onChange={set('name')} placeholder="Ms. Smith" required />
            </div>
          )}
          <div className={styles.field}>
            <label>Email</label>
            <input type="email" value={form.email} onChange={set('email')} placeholder="teacher@school.com" required />
          </div>
          <div className={styles.field}>
            <label>Password</label>
            <input type="password" value={form.password} onChange={set('password')} placeholder="••••••••" required />
          </div>

          {error && <p className={styles.error}>{error}</p>}

          <button type="submit" className={`btn-primary ${styles.submitBtn}`} disabled={loading}>
            {loading ? 'Please wait...' : mode === 'login' ? 'Log In' : 'Create Account'}
          </button>
        </form>

        <p className={styles.toggle}>
          {mode === 'login'
            ? <>No account? <button onClick={() => setMode('register')}>Register</button></>
            : <>Have an account? <button onClick={() => setMode('login')}>Log in</button></>
          }
        </p>
      </div>
    </div>
  )
}
