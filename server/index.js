import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import Database from 'better-sqlite3'
import { v4 as uuid } from 'uuid'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const httpServer = createServer(app)
const io = new Server(httpServer, { cors: { origin: '*' } })

app.use(express.json())

// --- DB setup ---
// In production Railway mounts a volume at /data — use that path so
// the database survives redeploys. Fall back to local for dev.
const dbPath = process.env.DB_PATH || path.join(__dirname, 'examlock.db')
const db = new Database(dbPath)
db.exec(`
  CREATE TABLE IF NOT EXISTS exams (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    questions TEXT NOT NULL,
    time_limit INTEGER DEFAULT 0,
    code TEXT UNIQUE NOT NULL,
    active_session_id TEXT,
    is_active INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY);

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    exam_id TEXT NOT NULL,
    started_at INTEGER,
    ended_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS submissions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    student_name TEXT NOT NULL,
    answers TEXT NOT NULL,
    violations INTEGER DEFAULT 0,
    submitted_at INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    student_name TEXT NOT NULL,
    type TEXT NOT NULL,
    detail TEXT,
    at INTEGER NOT NULL
  );
`)

// Safe migrations for existing DBs
try { db.exec(`ALTER TABLE exams ADD COLUMN active_session_id TEXT`) } catch (_) {}
try { db.exec(`ALTER TABLE exams ADD COLUMN is_active INTEGER DEFAULT 0`) } catch (_) {}

const insertEvent = db.prepare(
  'INSERT INTO events (id, session_id, student_name, type, detail, at) VALUES (?, ?, ?, ?, ?, ?)'
)
function logEvent(session_id, student_name, type, detail = null) {
  insertEvent.run(uuid(), session_id, student_name, type, detail, Date.now())
}

function generateCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase()
}

// --- REST API ---

// Exams
app.get('/api/exams', (req, res) => {
  const exams = db.prepare('SELECT * FROM exams ORDER BY created_at DESC').all()
  res.json(exams.map(e => ({ ...e, questions: JSON.parse(e.questions) })))
})

app.post('/api/exams', (req, res) => {
  const { title, questions, time_limit } = req.body
  const id = uuid()
  let code = generateCode()
  while (db.prepare('SELECT id FROM exams WHERE code = ?').get(code)) {
    code = generateCode()
  }
  // Auto-create a persistent session for this exam
  const sessionId = uuid()
  db.prepare('INSERT INTO sessions (id, exam_id, started_at) VALUES (?, ?, ?)').run(sessionId, id, Date.now())
  db.prepare('INSERT INTO exams (id, title, questions, time_limit, code, active_session_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, title, JSON.stringify(questions), time_limit || 0, code, sessionId)
  res.json({ id, code })
})

app.get('/api/exams/:id', (req, res) => {
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(req.params.id)
  if (!exam) return res.status(404).json({ error: 'Not found' })
  res.json({ ...exam, questions: JSON.parse(exam.questions) })
})

app.put('/api/exams/:id', (req, res) => {
  const { title, questions, time_limit } = req.body
  db.prepare('UPDATE exams SET title = ?, questions = ?, time_limit = ? WHERE id = ?')
    .run(title, JSON.stringify(questions), time_limit || 0, req.params.id)
  res.json({ ok: true })
})

app.delete('/api/exams/:id', (req, res) => {
  db.prepare('DELETE FROM exams WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
})

// Toggle exam open/closed — also ensures a session exists for legacy exams
app.patch('/api/exams/:id/active', (req, res) => {
  const { is_active } = req.body
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(req.params.id)
  if (!exam) return res.status(404).json({ error: 'Not found' })

  let sessionId = exam.active_session_id
  if (!sessionId) {
    // Legacy exam created before auto-session — create one now
    sessionId = uuid()
    db.prepare('INSERT INTO sessions (id, exam_id, started_at) VALUES (?, ?, ?)').run(sessionId, req.params.id, Date.now())
    db.prepare('UPDATE exams SET active_session_id = ? WHERE id = ?').run(sessionId, req.params.id)
  }

  db.prepare('UPDATE exams SET is_active = ? WHERE id = ?').run(is_active ? 1 : 0, req.params.id)
  res.json({ ok: true, session_id: sessionId })
})

// Lookup exam by code (student join)
app.get('/api/exams/code/:code', (req, res) => {
  const exam = db.prepare('SELECT * FROM exams WHERE code = ?').get(req.params.code.toUpperCase())
  if (!exam) return res.status(404).json({ error: 'Invalid code' })
  if (!exam.is_active) return res.status(400).json({ error: 'This exam is not open yet. Wait for your teacher to open it.' })
  res.json({ ...exam, questions: JSON.parse(exam.questions) })
})

// Sessions (kept for direct lookups; sessions are now auto-created with exams)
app.get('/api/sessions/:id', (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id)
  if (!session) return res.status(404).json({ error: 'Not found' })
  res.json(session)
})

app.get('/api/sessions/:id/submissions', (req, res) => {
  const subs = db.prepare('SELECT * FROM submissions WHERE session_id = ? ORDER BY submitted_at DESC')
    .all(req.params.id)
  res.json(subs.map(s => ({ ...s, answers: JSON.parse(s.answers) })))
})

// Submissions
app.post('/api/submissions', (req, res) => {
  const { session_id, student_name, answers, violations } = req.body
  const id = uuid()
  db.prepare('INSERT INTO submissions (id, session_id, student_name, answers, violations) VALUES (?, ?, ?, ?, ?)')
    .run(id, session_id, student_name, JSON.stringify(answers), violations || 0)
  logEvent(session_id, student_name, 'submitted')
  // notify teacher room — include answers so monitor doesn't need a page refresh
  io.to(`session:${session_id}`).emit('submission', {
    id, student_name, violations, answers, submitted_at: Date.now()
  })
  res.json({ id })
})

// Events log for a session
app.get('/api/sessions/:id/events', (req, res) => {
  const events = db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY at ASC')
    .all(req.params.id)
  res.json(events)
})

// CSV export for a session
app.get('/api/sessions/:id/export.csv', (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id)
  if (!session) return res.status(404).send('Not found')
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(session.exam_id)
  const questions = JSON.parse(exam.questions)
  const subs = db.prepare('SELECT * FROM submissions WHERE session_id = ? ORDER BY submitted_at ASC')
    .all(req.params.id)
  const events = db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY at ASC')
    .all(req.params.id)

  // Build per-student event summary
  const eventsByStudent = {}
  for (const e of events) {
    if (!eventsByStudent[e.student_name]) eventsByStudent[e.student_name] = []
    eventsByStudent[e.student_name].push(e)
  }

  const mcQuestions = questions.filter(q => q.type === 'multiple_choice')

  // Header row
  const headers = [
    'Student Name',
    'Submitted At',
    `Score (MC ${mcQuestions.length} questions)`,
    'Violations',
    'Copy/Paste Events',
    ...questions.map((q, i) => `Q${i + 1}: ${q.text.replace(/"/g, '""')}`),
    'Action Log'
  ]

  const rows = subs.map(s => {
    const answers = JSON.parse(s.answers)
    const mcCorrect = mcQuestions.filter(q => answers[q.id] === q.correct).length
    const studentEvents = eventsByStudent[s.student_name] || []
    const copyPasteCount = studentEvents.filter(e => e.type === 'note').length
    const actionLog = studentEvents
      .map(e => `[${new Date(e.at).toLocaleTimeString()}] ${e.type}${e.detail ? ': ' + e.detail : ''}`)
      .join(' | ')

    return [
      s.student_name,
      new Date(s.submitted_at * 1000).toLocaleString(),
      mcQuestions.length > 0 ? `${mcCorrect}/${mcQuestions.length}` : 'N/A',
      s.violations,
      copyPasteCount,
      ...questions.map(q => {
        const ans = answers[q.id]
        if (q.type === 'multiple_choice') {
          if (ans === undefined) return '(no answer)'
          return `${q.options[ans]} ${ans === q.correct ? '[CORRECT]' : '[WRONG]'}`
        }
        return ans || '(no answer)'
      }),
      actionLog
    ]
  })

  const escape = v => `"${String(v ?? '').replace(/"/g, '""')}"`
  const csv = [headers, ...rows].map(row => row.map(escape).join(',')).join('\n')

  res.setHeader('Content-Type', 'text/csv')
  res.setHeader('Content-Disposition', `attachment; filename="${exam.title.replace(/[^a-z0-9]/gi, '_')}_results.csv"`)
  res.send(csv)
})

// --- Socket.IO ---
// Teachers join session rooms to get live updates
// Students emit 'violation' events when they leave the tab

io.on('connection', (socket) => {
  socket.on('join_session', ({ session_id }) => {
    socket.join(`session:${session_id}`)
  })

  socket.on('student_join', ({ session_id, student_name }) => {
    socket.join(`session:${session_id}`)
    socket.data.session_id = session_id
    socket.data.student_name = student_name
    logEvent(session_id, student_name, 'joined')
    io.to(`session:${session_id}`).emit('student_joined', {
      id: socket.id,
      student_name,
      joined_at: Date.now()
    })
  })

  socket.on('violation', ({ session_id, student_name, count }) => {
    logEvent(session_id, student_name, 'violation', `#${count} – switched away from exam`)
    io.to(`session:${session_id}`).emit('student_violation', {
      student_name,
      count,
      at: Date.now()
    })
  })

  socket.on('note', ({ session_id, student_name, action }) => {
    logEvent(session_id, student_name, 'note', action)
    io.to(`session:${session_id}`).emit('student_note', {
      student_name,
      action,
      at: Date.now()
    })
  })

  socket.on('disconnect', () => {
    const { session_id, student_name } = socket.data
    if (session_id && student_name) {
      logEvent(session_id, student_name, 'disconnected')
      io.to(`session:${session_id}`).emit('student_left', {
        student_name,
        at: Date.now()
      })
    }
  })
})

// Serve built frontend in production
// API and socket routes are already registered above — this catch-all
// only fires for unmatched paths (React client-side routes).
// Uses app.use (not app.get('*')) — Express 5 removed wildcard syntax.
const distPath = path.join(__dirname, '../dist')
app.use(express.static(distPath))
app.use((req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) return next()
  res.sendFile(path.join(distPath, 'index.html'), err => {
    if (err) next(err)
  })
})

const PORT = process.env.PORT || 3001
httpServer.listen(PORT, () => {
  console.log(`ExamLock server running on http://localhost:${PORT}`)
})
