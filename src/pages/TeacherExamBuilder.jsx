import React, { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { v4 as uuid } from 'uuid'
import styles from './TeacherExamBuilder.module.css'

const QUESTION_TYPES = [
  { value: 'multiple_choice', label: 'Multiple Choice' },
  { value: 'short_answer', label: 'Short Answer' },
  { value: 'essay', label: 'Essay' },
]

function emptyQuestion() {
  return {
    id: uuid(),
    type: 'multiple_choice',
    text: '',
    options: ['', '', '', ''],
    correct: 0,
  }
}

export default function TeacherExamBuilder() {
  const nav = useNavigate()
  const { id } = useParams()
  const isEdit = Boolean(id)

  const [title, setTitle] = useState('')
  const [timeLimit, setTimeLimit] = useState(0)
  const [questions, setQuestions] = useState([emptyQuestion()])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (isEdit) {
      fetch(`/api/exams/${id}`)
        .then(r => r.json())
        .then(data => {
          setTitle(data.title)
          setTimeLimit(data.time_limit)
          setQuestions(data.questions)
        })
    }
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
    setQuestions(qs => qs.map(q =>
      q.id === qid ? { ...q, options: [...q.options, ''] } : q
    ))
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
    const body = { title, questions, time_limit: Number(timeLimit) }
    const res = await fetch(isEdit ? `/api/exams/${id}` : '/api/exams', {
      method: isEdit ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    setSaving(false)
    if (!isEdit && data.code) {
      alert(`Exam saved! Code: ${data.code}`)
    }
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
              <textarea
                rows={2}
                value={q.text}
                onChange={e => updateQuestion(q.id, { text: e.target.value })}
                placeholder="Enter your question..."
              />
            </div>

            {q.type === 'multiple_choice' && (
              <div className={styles.options}>
                <label>Answer Options</label>
                {q.options.map((opt, i) => (
                  <div key={i} className={styles.optionRow}>
                    <input
                      type="radio"
                      name={`correct-${q.id}`}
                      checked={q.correct === i}
                      onChange={() => updateQuestion(q.id, { correct: i })}
                      title="Mark as correct answer"
                    />
                    <input
                      value={opt}
                      onChange={e => updateOption(q.id, i, e.target.value)}
                      placeholder={`Option ${i + 1}`}
                    />
                    <button className="btn-ghost" onClick={() => removeOption(q.id, i)} disabled={q.options.length <= 2}>✕</button>
                  </div>
                ))}
                <button className="btn-ghost" onClick={() => addOption(q.id)} style={{ marginTop: '0.25rem' }}>
                  + Add Option
                </button>
                <p className={styles.hint}>Select the radio button next to the correct answer</p>
              </div>
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
