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

const CALC_OPTIONS = [
  { value: 'none',       label: '🚫 No calculator' },
  { value: 'scientific', label: '🧮 Scientific' },
  { value: 'graphing',   label: '🧮 Graphing' },
]

function emptyQuestion() {
  return { id: uuid(), type: 'multiple_choice', text: '', options: ['', '', '', ''], correct: 0, image: null, pdf: null, calculator: 'none' }
}

// One attachment per question: an image shown inline, or a PDF the student
// reads in a frame. Uploading a new file replaces whatever was there.
function AttachmentUpload({ image, pdf, onChange, authHeaders }) {
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef()

  async function handleFile(e) {
    const file = e.target.files[0]
    e.target.value = ''
    if (!file) return
    setUploading(true)
    setError('')
    const fd = new FormData()
    fd.append('file', file)
    try {
      const res = await fetch('/api/upload', { method: 'POST', headers: authHeaders(), body: fd })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Upload failed')
      if (data.kind === 'pdf') onChange({ image: null, pdf: { url: data.url, name: data.name } })
      else onChange({ image: data.url, pdf: null })
    } catch (err) {
      setError(err.message)
    } finally {
      setUploading(false)
    }
  }

  const small = { padding: '0.25rem 0.5rem', fontSize: '0.75rem' }
  return (
    <div className={styles.imageUpload}>
      {image && (
        <div className={styles.imagePreview}>
          <img src={image} alt="Question image" />
          <button className="btn-danger" onClick={() => onChange({ image: null, pdf: null })} style={small}>Remove</button>
        </div>
      )}
      {pdf && (
        <div className={styles.pdfChip}>
          <span>📄 {pdf.name || 'Attached PDF'}</span>
          <a href={pdf.url} target="_blank" rel="noreferrer" className="btn-ghost" style={{ ...small, textDecoration: 'none' }}>Open</a>
          <button className="btn-danger" onClick={() => onChange({ image: null, pdf: null })} style={small}>Remove</button>
        </div>
      )}
      {!image && !pdf && (
        <button
          className="btn-ghost"
          onClick={() => inputRef.current.click()}
          disabled={uploading}
          style={{ fontSize: '0.8125rem' }}
        >
          {uploading ? 'Uploading...' : '+ Add Image or PDF'}
        </button>
      )}
      {error && <p className={styles.hint} style={{ color: 'var(--danger)' }}>{error}</p>}
      <input ref={inputRef} type="file" accept="image/*,application/pdf" onChange={handleFile} style={{ display: 'none' }} />
    </div>
  )
}

const DEFAULT_SETTINGS = { navigation: 'track', copy_paste: 'track', log_keystrokes: false }

const NAV_OPTIONS = [
  { value: 'off',   label: 'Off',    desc: 'No detection' },
  { value: 'track', label: 'Track',  desc: 'Flag as violation' },
  { value: 'block', label: 'Block',  desc: 'Show return overlay + flag' },
]

const CP_OPTIONS = [
  { value: 'off',   label: 'Off',    desc: 'Allow freely' },
  { value: 'track', label: 'Track',  desc: 'Log as note' },
  { value: 'block', label: 'Block',  desc: 'Prevent entirely' },
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

  function setSetting(key, value) {
    setSettings(s => ({ ...s, [key]: value }))
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

            <div className={styles.restrictionRow}>
              <div className={styles.restrictionText}>
                <span className={styles.restrictionLabel}>Navigation away</span>
                <span className={styles.restrictionDesc}>
                  What happens when a student switches tabs, windows or apps
                </span>
              </div>
              <div className={styles.segmented}>
                {NAV_OPTIONS.map(o => (
                  <button
                    key={o.value}
                    className={`${styles.seg} ${settings.navigation === o.value ? styles.segActive : ''}`}
                    onClick={() => setSetting('navigation', o.value)}
                    title={o.desc}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>

            <div className={styles.restrictionRow}>
              <div className={styles.restrictionText}>
                <span className={styles.restrictionLabel}>Copy &amp; Paste</span>
                <span className={styles.restrictionDesc}>
                  Whether students can copy or paste text during the exam
                </span>
              </div>
              <div className={styles.segmented}>
                {CP_OPTIONS.map(o => (
                  <button
                    key={o.value}
                    className={`${styles.seg} ${settings.copy_paste === o.value ? styles.segActive : ''}`}
                    onClick={() => setSetting('copy_paste', o.value)}
                    title={o.desc}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>

            <div className={`${styles.restrictionRow}`} style={{ borderBottom: 'none' }}>
              <div className={styles.restrictionText}>
                <span className={styles.restrictionLabel}>Keystroke logging</span>
                <span className={styles.restrictionDesc}>Record all keys pressed during the exam</span>
              </div>
              <div
                className={`${styles.toggle} ${settings.log_keystrokes ? styles.toggleOn : ''}`}
                onClick={() => setSetting('log_keystrokes', !settings.log_keystrokes)}
                role="switch"
              >
                <div className={styles.toggleThumb} />
              </div>
            </div>

          </div>
        </div>

        <div className={`card ${styles.disclosure}`} style={{ marginTop: '1rem' }}>
          <p className={styles.sectionLabel}>What ExamLock can and cannot detect</p>
          <div className={styles.disclosureCols}>
            <div>
              <p className={styles.disclosureHead}>Detected and shown in the monitor</p>
              <ul className={styles.disclosureList}>
                <li>Switching to another tab, window or app, after a short grace period</li>
                <li>Leaving fullscreen, and repeated brief exits</li>
                <li>Copy and paste, and keystrokes if logging is on</li>
                <li>A browser window much smaller than the screen, or a second display</li>
                <li>Connection drops, reconnects, and duplicate submissions</li>
              </ul>
            </div>
            <div>
              <p className={styles.disclosureHead}>Not detectable from a web page</p>
              <ul className={styles.disclosureList}>
                <li>Apps or overlays that float over the browser without taking focus</li>
                <li>A phone or any second device</li>
                <li>What is shown on a second display</li>
                <li>Browser extensions that stay away from the answer fields</li>
              </ul>
              <p className={styles.disclosureNote}>Use the environment flags as a prompt to look, and walk the room.</p>
            </div>
          </div>
        </div>

        {questions.map((q, idx) => (
          <div key={q.id} className="card" style={{ marginTop: '1rem' }}>
            <div className={styles.qHeader}>
              <span className={styles.qNum}>Q{idx + 1}</span>
              <select value={q.type} onChange={e => updateQuestion(q.id, { type: e.target.value })} style={{ width: 'auto' }}>
                {QUESTION_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
              <select
                value={q.calculator || 'none'}
                onChange={e => updateQuestion(q.id, { calculator: e.target.value })}
                style={{ width: 'auto' }}
                title="Calculator available to students for this question"
              >
                {CALC_OPTIONS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
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

            <AttachmentUpload
              image={q.image}
              pdf={q.pdf}
              onChange={patch => updateQuestion(q.id, patch)}
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
