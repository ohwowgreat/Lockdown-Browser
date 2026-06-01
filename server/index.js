import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import Database from 'better-sqlite3'
import { v4 as uuid } from 'uuid'
import path from 'path'
import { fileURLToPath } from 'url'
import bcrypt from 'bcryptjs'
import multer from 'multer'
import fs from 'fs'
import { signToken, requireAuth, requireAdmin } from './auth.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const httpServer = createServer(app)
const io = new Server(httpServer, { cors: { origin: '*' } })

app.use(express.json({ limit: '10mb' }))

// --- Uploads ---
const uploadsDir = process.env.UPLOADS_PATH || path.join(__dirname, '../uploads')
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true })
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => cb(null, `${uuid()}${path.extname(file.originalname)}`)
})
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } })
app.use('/uploads', express.static(uploadsDir))

// --- DB ---
const dbPath = process.env.DB_PATH || path.join(__dirname, 'examlock.db')
const db = new Database(dbPath)
db.exec(`
  CREATE TABLE IF NOT EXISTS teachers (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin INTEGER DEFAULT 0,
    is_suspended INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS exams (
    id TEXT PRIMARY KEY,
    teacher_id TEXT,
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

// Safe migrations
try { db.exec(`ALTER TABLE exams ADD COLUMN active_session_id TEXT`) } catch (_) {}
try { db.exec(`ALTER TABLE exams ADD COLUMN is_active INTEGER DEFAULT 0`) } catch (_) {}
try { db.exec(`ALTER TABLE exams ADD COLUMN teacher_id TEXT`) } catch (_) {}
try { db.exec(`ALTER TABLE exams ADD COLUMN settings TEXT`) } catch (_) {}
try { db.exec(`ALTER TABLE teachers ADD COLUMN is_admin INTEGER DEFAULT 0`) } catch (_) {}
try { db.exec(`ALTER TABLE teachers ADD COLUMN is_suspended INTEGER DEFAULT 0`) } catch (_) {}

// ── Seed superadmin ───────────────────────────────────────────────────────────
async function seedAdmin() {
  const email = process.env.ADMIN_EMAIL
  const password = process.env.ADMIN_PASSWORD
  if (!email || !password) return
  const existing = db.prepare('SELECT id, is_admin FROM teachers WHERE email = ?').get(email.toLowerCase())
  if (existing) {
    // Ensure the existing account has admin flag
    if (!existing.is_admin) {
      db.prepare('UPDATE teachers SET is_admin = 1 WHERE id = ?').run(existing.id)
      console.log(`Granted admin to existing account: ${email}`)
    }
    return
  }
  const hash = await bcrypt.hash(password, 10)
  db.prepare('INSERT INTO teachers (id, email, name, password_hash, is_admin) VALUES (?, ?, ?, ?, 1)')
    .run(uuid(), email.toLowerCase(), 'Admin', hash)
  console.log(`Superadmin created: ${email}`)
}
seedAdmin()

const DEFAULT_SETTINGS = JSON.stringify({ detect_navigation: true, track_copy_paste: true, log_keystrokes: false })

const insertEvent = db.prepare(
  'INSERT INTO events (id, session_id, student_name, type, detail, at) VALUES (?, ?, ?, ?, ?, ?)'
)
function logEvent(session_id, student_name, type, detail = null) {
  insertEvent.run(uuid(), session_id, student_name, type, detail, Date.now())
}

function generateCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase()
}

// ── Auth routes ──────────────────────────────────────────────────────────────

app.post('/api/auth/register', async (req, res) => {
  const { email, name, password } = req.body
  if (!email || !name || !password) return res.status(400).json({ error: 'All fields required' })
  if (db.prepare('SELECT id FROM teachers WHERE email = ?').get(email.toLowerCase())) {
    return res.status(409).json({ error: 'Email already registered' })
  }
  const hash = await bcrypt.hash(password, 10)
  const id = uuid()
  db.prepare('INSERT INTO teachers (id, email, name, password_hash) VALUES (?, ?, ?, ?)')
    .run(id, email.toLowerCase(), name, hash)
  const token = signToken({ id, email: email.toLowerCase(), name, is_admin: false })
  res.json({ token, teacher: { id, email, name, is_admin: false } })
})

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body
  const teacher = db.prepare('SELECT * FROM teachers WHERE email = ?').get(email?.toLowerCase())
  if (!teacher) return res.status(401).json({ error: 'Invalid email or password' })
  if (teacher.is_suspended) return res.status(403).json({ error: 'This account has been suspended. Contact your administrator.' })
  const ok = await bcrypt.compare(password, teacher.password_hash)
  if (!ok) return res.status(401).json({ error: 'Invalid email or password' })
  const payload = { id: teacher.id, email: teacher.email, name: teacher.name, is_admin: !!teacher.is_admin }
  const token = signToken(payload)
  res.json({ token, teacher: { id: teacher.id, email: teacher.email, name: teacher.name, is_admin: !!teacher.is_admin } })
})

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ teacher: req.teacher })
})

// ── Image upload ─────────────────────────────────────────────────────────────

app.post('/api/upload', requireAuth, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
  res.json({ url: `/uploads/${req.file.filename}` })
})

// ── Exam routes (teacher-scoped) ─────────────────────────────────────────────

function parseExam(e) {
  return { ...e, questions: JSON.parse(e.questions), settings: JSON.parse(e.settings || DEFAULT_SETTINGS) }
}

app.get('/api/exams', requireAuth, (req, res) => {
  const exams = db.prepare('SELECT * FROM exams WHERE teacher_id = ? ORDER BY created_at DESC').all(req.teacher.id)
  res.json(exams.map(parseExam))
})

app.post('/api/exams', requireAuth, (req, res) => {
  const { title, questions, time_limit, settings } = req.body
  const id = uuid()
  let code = generateCode()
  while (db.prepare('SELECT id FROM exams WHERE code = ?').get(code)) code = generateCode()
  const sessionId = uuid()
  db.prepare('INSERT INTO sessions (id, exam_id, started_at) VALUES (?, ?, ?)').run(sessionId, id, Date.now())
  db.prepare('INSERT INTO exams (id, teacher_id, title, questions, time_limit, code, active_session_id, settings) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, req.teacher.id, title, JSON.stringify(questions), time_limit || 0, code, sessionId, JSON.stringify(settings || JSON.parse(DEFAULT_SETTINGS)))
  res.json({ id, code })
})

app.get('/api/exams/:id', requireAuth, (req, res) => {
  const exam = db.prepare('SELECT * FROM exams WHERE id = ? AND teacher_id = ?').get(req.params.id, req.teacher.id)
  if (!exam) return res.status(404).json({ error: 'Not found' })
  res.json(parseExam(exam))
})

app.put('/api/exams/:id', requireAuth, (req, res) => {
  const { title, questions, time_limit, settings } = req.body
  db.prepare('UPDATE exams SET title = ?, questions = ?, time_limit = ?, settings = ? WHERE id = ? AND teacher_id = ?')
    .run(title, JSON.stringify(questions), time_limit || 0, JSON.stringify(settings || JSON.parse(DEFAULT_SETTINGS)), req.params.id, req.teacher.id)
  res.json({ ok: true })
})

app.delete('/api/exams/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM exams WHERE id = ? AND teacher_id = ?').run(req.params.id, req.teacher.id)
  res.json({ ok: true })
})

app.patch('/api/exams/:id/active', requireAuth, (req, res) => {
  const { is_active } = req.body
  const exam = db.prepare('SELECT * FROM exams WHERE id = ? AND teacher_id = ?').get(req.params.id, req.teacher.id)
  if (!exam) return res.status(404).json({ error: 'Not found' })
  let sessionId = exam.active_session_id
  if (!sessionId) {
    sessionId = uuid()
    db.prepare('INSERT INTO sessions (id, exam_id, started_at) VALUES (?, ?, ?)').run(sessionId, req.params.id, Date.now())
    db.prepare('UPDATE exams SET active_session_id = ? WHERE id = ?').run(sessionId, req.params.id)
  }
  db.prepare('UPDATE exams SET is_active = ? WHERE id = ?').run(is_active ? 1 : 0, req.params.id)
  res.json({ ok: true, session_id: sessionId })
})

// ── Student-facing routes (no auth) ──────────────────────────────────────────

app.get('/api/exams/code/:code', (req, res) => {
  const exam = db.prepare('SELECT * FROM exams WHERE code = ?').get(req.params.code.toUpperCase())
  if (!exam) return res.status(404).json({ error: 'Invalid code' })
  if (!exam.is_active) return res.status(400).json({ error: 'This exam is not open yet. Wait for your teacher to open it.' })
  res.json(parseExam(exam))
})

app.post('/api/submissions', (req, res) => {
  const { session_id, student_name, answers, violations } = req.body
  const id = uuid()
  db.prepare('INSERT INTO submissions (id, session_id, student_name, answers, violations) VALUES (?, ?, ?, ?, ?)')
    .run(id, session_id, student_name, JSON.stringify(answers), violations || 0)
  logEvent(session_id, student_name, 'submitted')
  io.to(`session:${session_id}`).emit('submission', { id, student_name, violations, answers, submitted_at: Date.now() })
  res.json({ id })
})

// ── Session / results routes (teacher-scoped via session→exam→teacher) ────────

app.get('/api/sessions/:id', requireAuth, (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id)
  if (!session) return res.status(404).json({ error: 'Not found' })
  res.json(session)
})

app.get('/api/sessions/:id/submissions', requireAuth, (req, res) => {
  const subs = db.prepare('SELECT * FROM submissions WHERE session_id = ? ORDER BY submitted_at DESC').all(req.params.id)
  res.json(subs.map(s => ({ ...s, answers: JSON.parse(s.answers) })))
})

app.get('/api/sessions/:id/events', requireAuth, (req, res) => {
  const events = db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY at ASC').all(req.params.id)
  res.json(events)
})

app.get('/api/sessions/:id/export.csv', requireAuth, (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id)
  if (!session) return res.status(404).send('Not found')
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(session.exam_id)
  const questions = JSON.parse(exam.questions)
  const subs = db.prepare('SELECT * FROM submissions WHERE session_id = ? ORDER BY submitted_at ASC').all(req.params.id)
  const events = db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY at ASC').all(req.params.id)

  const eventsByStudent = {}
  for (const e of events) {
    if (!eventsByStudent[e.student_name]) eventsByStudent[e.student_name] = []
    eventsByStudent[e.student_name].push(e)
  }

  const mcQuestions = questions.filter(q => q.type === 'multiple_choice')
  const headers = [
    'Student Name', 'Submitted At',
    `Score (MC ${mcQuestions.length} questions)`,
    'Violations', 'Copy/Paste Events',
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
      s.violations, copyPasteCount,
      ...questions.map(q => {
        const ans = answers[q.id]
        if (q.type === 'multiple_choice') {
          if (ans === undefined) return '(no answer)'
          return `${q.options[ans]} ${ans === q.correct ? '[CORRECT]' : '[WRONG]'}`
        }
        if (q.type === 'drawing') return ans ? '[drawing submitted]' : '(no drawing)'
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

// ── Admin routes ──────────────────────────────────────────────────────────────

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const teachers   = db.prepare('SELECT COUNT(*) as n FROM teachers WHERE is_admin = 0').get().n
  const exams      = db.prepare('SELECT COUNT(*) as n FROM exams').get().n
  const sessions   = db.prepare('SELECT COUNT(*) as n FROM sessions').get().n
  const submissions = db.prepare('SELECT COUNT(*) as n FROM submissions').get().n
  res.json({ teachers, exams, sessions, submissions })
})

app.get('/api/admin/teachers', requireAdmin, (req, res) => {
  const teachers = db.prepare(`
    SELECT t.id, t.email, t.name, t.is_suspended, t.created_at,
           COUNT(e.id) as exam_count
    FROM teachers t
    LEFT JOIN exams e ON e.teacher_id = t.id
    WHERE t.is_admin = 0
    GROUP BY t.id
    ORDER BY t.created_at DESC
  `).all()
  res.json(teachers)
})

app.patch('/api/admin/teachers/:id/suspend', requireAdmin, (req, res) => {
  const { is_suspended } = req.body
  db.prepare('UPDATE teachers SET is_suspended = ? WHERE id = ? AND is_admin = 0')
    .run(is_suspended ? 1 : 0, req.params.id)
  res.json({ ok: true })
})

app.delete('/api/admin/teachers/:id', requireAdmin, (req, res) => {
  // Delete teacher's exams, sessions, submissions, events, then the teacher
  const exams = db.prepare('SELECT id FROM exams WHERE teacher_id = ?').all(req.params.id)
  for (const exam of exams) {
    const sessions = db.prepare('SELECT id FROM sessions WHERE exam_id = ?').all(exam.id)
    for (const s of sessions) {
      db.prepare('DELETE FROM submissions WHERE session_id = ?').run(s.id)
      db.prepare('DELETE FROM events WHERE session_id = ?').run(s.id)
    }
    db.prepare('DELETE FROM sessions WHERE exam_id = ?').run(exam.id)
  }
  db.prepare('DELETE FROM exams WHERE teacher_id = ?').run(req.params.id)
  db.prepare('DELETE FROM teachers WHERE id = ? AND is_admin = 0').run(req.params.id)
  res.json({ ok: true })
})

app.get('/api/admin/teachers/:id/exams', requireAdmin, (req, res) => {
  const exams = db.prepare(`
    SELECT e.*, COUNT(s.id) as submission_count
    FROM exams e
    LEFT JOIN sessions ss ON ss.exam_id = e.id
    LEFT JOIN submissions s ON s.session_id = ss.id
    WHERE e.teacher_id = ?
    GROUP BY e.id
    ORDER BY e.created_at DESC
  `).all(req.params.id)
  res.json(exams.map(e => ({ ...e, questions: JSON.parse(e.questions), settings: JSON.parse(e.settings || '{}') })))
})

// ── Socket.IO ─────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  socket.on('join_session', ({ session_id }) => socket.join(`session:${session_id}`))

  socket.on('student_join', ({ session_id, student_name }) => {
    socket.join(`session:${session_id}`)
    socket.data.session_id = session_id
    socket.data.student_name = student_name
    logEvent(session_id, student_name, 'joined')
    io.to(`session:${session_id}`).emit('student_joined', { id: socket.id, student_name, joined_at: Date.now() })
  })

  socket.on('violation', ({ session_id, student_name, count }) => {
    logEvent(session_id, student_name, 'violation', `#${count} – switched away from exam`)
    io.to(`session:${session_id}`).emit('student_violation', { student_name, count, at: Date.now() })
  })

  socket.on('note', ({ session_id, student_name, action }) => {
    logEvent(session_id, student_name, 'note', action)
    io.to(`session:${session_id}`).emit('student_note', { student_name, action, at: Date.now() })
  })

  socket.on('keystrokes', ({ session_id, student_name, keys }) => {
    if (!keys?.length) return
    const detail = keys.map(k => k.key).join(', ')
    logEvent(session_id, student_name, 'keystrokes', detail)
    io.to(`session:${session_id}`).emit('student_keystrokes', { student_name, keys, at: Date.now() })
  })

  socket.on('disconnect', () => {
    const { session_id, student_name } = socket.data
    if (session_id && student_name) {
      logEvent(session_id, student_name, 'disconnected')
      io.to(`session:${session_id}`).emit('student_left', { student_name, at: Date.now() })
    }
  })
})

// ── Static frontend ───────────────────────────────────────────────────────────

const distPath = path.join(__dirname, '../dist')
app.use(express.static(distPath))
app.use((req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) return next()
  res.sendFile(path.join(distPath, 'index.html'), err => { if (err) next(err) })
})

const PORT = process.env.PORT || 3001
httpServer.listen(PORT, () => console.log(`ExamLock server running on http://localhost:${PORT}`))
