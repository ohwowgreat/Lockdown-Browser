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
const db = new Database(path.join(__dirname, 'examlock.db'))
db.exec(`
  CREATE TABLE IF NOT EXISTS exams (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    questions TEXT NOT NULL,
    time_limit INTEGER DEFAULT 0,
    code TEXT UNIQUE NOT NULL,
    created_at INTEGER DEFAULT (unixepoch())
  );
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
`)

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
  // ensure unique
  while (db.prepare('SELECT id FROM exams WHERE code = ?').get(code)) {
    code = generateCode()
  }
  db.prepare('INSERT INTO exams (id, title, questions, time_limit, code) VALUES (?, ?, ?, ?, ?)')
    .run(id, title, JSON.stringify(questions), time_limit || 0, code)
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

// Lookup exam by code (student join)
app.get('/api/exams/code/:code', (req, res) => {
  const exam = db.prepare('SELECT * FROM exams WHERE code = ?').get(req.params.code.toUpperCase())
  if (!exam) return res.status(404).json({ error: 'Invalid code' })
  res.json({ ...exam, questions: JSON.parse(exam.questions) })
})

// Sessions
app.post('/api/sessions', (req, res) => {
  const { exam_id } = req.body
  const id = uuid()
  db.prepare('INSERT INTO sessions (id, exam_id, started_at) VALUES (?, ?, ?)')
    .run(id, exam_id, Date.now())
  res.json({ id })
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
  // notify teacher room
  io.to(`session:${session_id}`).emit('submission', {
    id, student_name, violations, submitted_at: Date.now()
  })
  res.json({ id })
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
    io.to(`session:${session_id}`).emit('student_joined', {
      id: socket.id,
      student_name,
      joined_at: Date.now()
    })
  })

  socket.on('violation', ({ session_id, student_name, count }) => {
    io.to(`session:${session_id}`).emit('student_violation', {
      student_name,
      count,
      at: Date.now()
    })
  })

  socket.on('disconnect', () => {
    const { session_id, student_name } = socket.data
    if (session_id && student_name) {
      io.to(`session:${session_id}`).emit('student_left', {
        student_name,
        at: Date.now()
      })
    }
  })
})

const PORT = process.env.PORT || 3001
httpServer.listen(PORT, () => {
  console.log(`ExamLock server running on http://localhost:${PORT}`)
})
