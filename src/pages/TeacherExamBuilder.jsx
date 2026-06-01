import React, { useEffect, useState, useRef } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { v4 as uuid } from 'uuid'
import { useAuth } from '../context/AuthContext'
import styles from './TeacherExamBuilder.module.css'

const QUESTION_TYPES = [
  { value: 'multiple_choice', label: 'Multiple Choice' },
  { value: 'short_answer',    label: 'Short Answer' },
  { value: 'essay',           label: 'Essay' },
  { value: 'drawing',         label: 'Drawing' },
]

function emptyQuestion() {
  return { id: uuid(), type: 'multiple_choice', text: '', options: ['', '', '', ''], correct: 0, image: null }
}

function ImageUpload({ value, onChange, authHeaders }) {
  const [uploading, setUploading] = useState(false)
  const inputRef = useRef()

  async function handleFile(e) {
    const file = e.target.files[0]
    if (!file) return
    setUploading(true)
    const fd = new FormData()
    fd.append('image', file)
    const res = await fetch('/api/upload', { method: 'POST', headers: authHeaders(), body: fd })
    const data = await res.json()
    setUploading(false)
    if (data.url) onChange(data.url)
  }

  return (
    <div className={styles.imageUpload}>
      {value
        ? (
          <div className={styles.imagePreview}>
            <img src={value} alt="Question image" />
            <button className="btn-danger" onClick={() => onChange(null)} style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}>
              Remove
            </button>
          </div>
        )
        : (
          <button
            className="btn-ghost"
            onClick={() => inputRef.current.click()}
            disabled={uploading}
            style={{ fontSize: '0.8125rem' }}
          >
            {uploading ? 'Uploading...' : '+ Add Image'}
          </button>
        )
      }
      <input ref={inputRef} type="file" accept="image/*" onChange={handleFile} style={{ display: 'none' }} />
    </div>
  )
}

const DEFAULT_SETTINGS = { detect_navigation: true, track_copy_paste: true, log_keystrokes: false }

const RESTRICTIONS = [
  {
    key: 'detect_navigation',
    label: 'Detect navigation away',
    desc: 'Flag as a violation when student switches tabs, windows, or apps',
  },
  {
    key: 'track_copy_paste',
    label: 'Track copy & paste',
    desc: 'Log copy and paste actions as notes (not violations)',
  },
  {
    key: 'log_keystrokes',
    label: 'Keystroke logging',
    desc: 'Record all keystrokes students press during the exam',
  },
]

export default function TeacherExamBuilder() {
  const nav = useNavigate()
  const { id } = useParams()
  const { authHeaders } = useAuth()
  const isEdit = Boolean(id)

  const [title, setTitle] = useState('')
  const [timeLimit, setTimeLimit] = useState(0)
  const [questions, setQuestions] = useState([emptyQuestion()])
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  const [saving, setSaving] = useState(false)

  function toggleSetting(key) {
    setSettings(s => ({ ...s, [key]: !s[key] }))
  }

  useEffect(() => {
    if (!isEdit) return
    fetch(`/api/exams/${id}`, { headers: authHeaders() })
      .then(r => r.json())
      .then(data => {
        setTitle(data.title)
        setTimeLimit(data.time_limit)
        setQuestions(data.questions)
        if (data.settings) setSettings(data.settings)
      })
  }, [id])

  function updateQuestion(qid, patch) {
    setQuestions(qs => qs.map(q => q.id === qid ? { ...q, ...patch } : q))
  }

  function updateOption(qid, idx, value) {
    setQuestions(qs => qs.map(q => {
      if (q.id !== qid) return q
      const options = [...q.options]
      options[idx] = value
      return { ...q, options }
    }))
  }

  function addOption(qid) {
    setQuestions(qs => qs.map(q => q.id === qid ? { ...q, options: [...q.options, ''] } : q))
  }

  function removeOption(qid, idx) {
    setQuestions(qs => qs.map(q => {
      if (q.id !== qid) return q
      const options = q.options.filter((_, i) => i !== idx)
      return { ...q, options, correct: Math.min(q.correct, options.length - 1) }
    }))
  }

  function moveQuestion(idx, dir) {
    const next = [...questions]
    const swap = idx + dir
    ;[next[idx], next[swap]] = [next[swap], next[idx]]
    setQuestions(next)
  }

  function removeQuestion(qid) {
    setQuestions(qs => qs.filter(q => q.id !== qid))
  }

  async function save() {
    if (!title.trim()) { alert('Please add a title'); return }
    if (questions.some(q => !q.text.trim())) { alert('All questions need text'); return }
    setSaving(true)
    const body = { title, questions, time_limit: Number(timeLimit), settings }
    await fetch(isEdit ? `/api/exams/${id}` : '/api/exams', {
      method: isEdit ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body),
    })
    setSaving(false)
    nav('/teacher')
  }

  return (
    <div className={styles.wrap}>
      <header className={styles.header}>
        <button className="btn-ghost" onClick={() => nav('/teacher')}>← Back</button>
        <h1>{isEdit ? 'Edit Exam' : 'New Exam'}</h1>
        <button className="btn-primary" onClick={save} disabled={saving}>
          {saving ? 'Saving...' : 'Save Exam'}
        </button>
      </header>

      <main className={styles.main}>
        <div className="card">
          <div className={styles.row}>
            <div style={{ flex: 2 }}>
              <label>Exam Title</label>
              <input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Chapter 5 Quiz" />
            </div>
            <div style={{ flex: 1 }}>
              <label>Time Limit (minutes, 0 = none)</label>
              <input type="number" min="0" value={timeLimit} onChange={e => setTimeLimit(e.target.value)} />
            </div>
          </div>
        </div>

        <div className="card" style={{ marginTop: '1rem' }}>
          <p className={styles.sectionLabel}>Restrictions</p>
          <div className={styles.restrictions}>
            {RESTRICTIONS.map(r => (
              <label key={r.key} className={styles.restrictionRow}>
                <div className={styles.restrictionText}>
                  <span className={styles.restrictionLabel}>{r.label}</span>
                  <span className={styles.restrictionDesc}>{r.desc}</span>
                </div>
                <div
                  className={`${styles.toggle} ${settings[r.key] ? styles.toggleOn : ''}`}
                  onClick={() => toggleSetting(r.key)}
                  role="switch"
                  aria-checked={settings[r.key]}
                >
                  <div className={styles.toggleThumb} />
                </div>
              </label>
            ))}
          </div>
        </div>

        {questions.map((q, idx) => (
          <div key={q.id} className="card" style={{ marginTop: '1rem' }}>
            <div className={styles.qHeader}>
              <span className={styles.qNum}>Q{idx + 1}</span>
              <select value={q.type} onChange={e => updateQuestion(q.id, { type: e.target.value })} style={{ width: 'auto' }}>
                {QUESTION_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
              <div className={styles.qActions}>
                <button className="btn-ghost" disabled={idx === 0} onClick={() => moveQuestion(idx, -1)}>↑</button>
                <button className="btn-ghost" disabled={idx === questions.length - 1} onClick={() => moveQuestion(idx, 1)}>↓</button>
                <button className="btn-danger" onClick={() => removeQuestion(q.id)} disabled={questions.length === 1}>✕</button>
              </div>
            </div>

            <div style={{ marginTop: '0.75rem' }}>
              <label>Question</label>
              <textarea rows={2} value={q.text} onChange={e => updateQuestion(q.id, { text: e.target.value })} placeholder="Enter your question..." />
            </div>

            <ImageUpload
              value={q.image}
              onChange={url => updateQuestion(q.id, { image: url })}
              authHeaders={authHeaders}
            />

            {q.type === 'multiple_choice' && (
              <div className={styles.options}>
                <label>Answer Options</label>
                {q.options.map((opt, i) => (
                  <div key={i} className={styles.optionRow}>
                    <input type="radio" name={`correct-${q.id}`} checked={q.correct === i} onChange={() => updateQuestion(q.id, { correct: i })} title="Mark as correct" />
                    <input value={opt} onChange={e => updateOption(q.id, i, e.target.value)} placeholder={`Option ${i + 1}`} />
                    <button className="btn-ghost" onClick={() => removeOption(q.id, i)} disabled={q.options.length <= 2}>✕</button>
                  </div>
                ))}
                <button className="btn-ghost" onClick={() => addOption(q.id)} style={{ marginTop: '0.25rem' }}>+ Add Option</button>
                <p className={styles.hint}>Select the radio button next to the correct answer</p>
              </div>
            )}

            {q.type === 'drawing' && (
              <p className={styles.hint} style={{ marginTop: '0.75rem' }}>
                Students will draw their answer on a canvas.
              </p>
            )}
          </div>
        ))}

        <button
          className="btn-ghost"
          style={{ marginTop: '1rem', width: '100%', padding: '0.75rem' }}
          onClick={() => setQuestions([...questions, emptyQuestion()])}
        >
          + Add Question
        </button>
      </main>
    </div>
  )
}
