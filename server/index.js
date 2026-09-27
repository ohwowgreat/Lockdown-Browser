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
import { signToken, configureAuth, teacherFromToken, requireAuth, requireAdmin } from './auth.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
app.set('trust proxy', true)  // so req.ip reflects X-Forwarded-For behind a proxy
const httpServer = createServer(app)
const io = new Server(httpServer, { cors: { origin: '*' } })

// Socket rooms. Students share one room per session and only ever receive
// pause_state from it. Everything the monitor shows (joins, violations, notes,
// keystrokes, submissions) goes to a teacher-only room, which a socket may
// join only with a valid teacher token for an exam that teacher owns.
const studentRoom = id => `session:${id}`
const teacherRoom = id => `session:${id}:teachers`

app.use(express.json({ limit: '10mb' }))

// Best-effort client IP from a socket handshake (honours X-Forwarded-For).
function socketIp(socket) {
  const fwd = socket.handshake.headers['x-forwarded-for']
  return (fwd ? fwd.split(',')[0].trim() : socket.handshake.address) || null
}

// --- Uploads ---
const uploadsDir = process.env.UPLOADS_PATH || path.join(__dirname, '../uploads')
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true })
// Files a teacher may attach to a question. The stored extension comes from
// the declared type, never from the uploaded filename, so nothing uploaded can
// be served back from this origin as HTML or script.
const ALLOWED_UPLOADS = {
  'image/jpeg':      { kind: 'image', ext: '.jpg' },
  'image/png':       { kind: 'image', ext: '.png' },
  'image/gif':       { kind: 'image', ext: '.gif' },
  'image/webp':      { kind: 'image', ext: '.webp' },
  'application/pdf': { kind: 'pdf',   ext: '.pdf' },
}
const MAX_UPLOAD_MB = 20
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => cb(null, `${uuid()}${ALLOWED_UPLOADS[file.mimetype]?.ext || ''}`)
})
const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_UPLOADS[file.mimetype]) return cb(null, true)
    cb(new Error('Only images (JPEG, PNG, GIF, WebP) and PDF files can be attached'))
  },
})
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
try { db.exec(`ALTER TABLE submissions ADD COLUMN ip TEXT`) } catch (_) {}
try { db.exec(`ALTER TABLE exams ADD COLUMN is_archived INTEGER DEFAULT 0`) } catch (_) {}
// One submission per student per session. Best effort: on a legacy database
// that already holds duplicates the index cannot be built, and the submission
// handler below still refuses new duplicates.
try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS submissions_one_per_student ON submissions (session_id, student_name)`) } catch (_) {}

// Let auth refuse tokens for teachers who were suspended or deleted after login.
const selectTeacherStatus = db.prepare('SELECT is_suspended FROM teachers WHERE id = ?')
configureAuth({
  isBlocked: id => {
    const t = selectTeacherStatus.get(id)
    if (!t) return 'deleted'
    return t.is_suspended ? 'suspended' : false
  },
})

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

const DEFAULT_SETTINGS = JSON.stringify({ navigation: 'track', copy_paste: 'track', log_keystrokes: false })

const insertEvent = db.prepare(
  'INSERT INTO events (id, session_id, student_name, type, detail, at) VALUES (?, ?, ?, ?, ?, ?)'
)
function logEvent(session_id, student_name, type, detail = null) {
  insertEvent.run(uuid(), session_id, student_name, type, detail, Date.now())
}

// Server-side observation about a student that the monitor should show.
// Logged under its own type and forwarded to the session's teachers.
function flagStudent(session_id, student_name, type, detail) {
  logEvent(session_id, student_name, type, detail)
  io.to(teacherRoom(session_id)).emit('student_flag', { student_name, type, detail, at: Date.now() })
}

function generateCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase()
}

function uniqueCode() {
  let code = generateCode()
  while (db.prepare('SELECT id FROM exams WHERE code = ?').get(code)) code = generateCode()
  return code
}

// Headline counts for the exam list: the current sitting's activity and how
// many sittings the exam has had.
const countJoined = db.prepare("SELECT COUNT(DISTINCT student_name) AS n FROM events WHERE session_id = ? AND type = 'joined'")
const countSubmitted = db.prepare('SELECT COUNT(*) AS n FROM submissions WHERE session_id = ?')
const countViolators = db.prepare("SELECT COUNT(DISTINCT student_name) AS n FROM events WHERE session_id = ? AND type = 'violation'")
const countSittings = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE exam_id = ?')
function examSummary(e) {
  const s = e.active_session_id
  return {
    joined: s ? countJoined.get(s).n : 0,
    submitted: s ? countSubmitted.get(s).n : 0,
    violators: s ? countViolators.get(s).n : 0,
    sittings: countSittings.get(e.id).n,
  }
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

app.post('/api/upload', requireAuth, (req, res) => {
  upload.single('file')(req, res, err => {
    if (err) {
      const message = err.code === 'LIMIT_FILE_SIZE' ? `File is too large (max ${MAX_UPLOAD_MB} MB)` : err.message
      return res.status(400).json({ error: message })
    }
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
    res.json({ url: `/uploads/${req.file.filename}`, kind: ALLOWED_UPLOADS[req.file.mimetype].kind, name: req.file.originalname })
  })
})

// ── Exam routes (teacher-scoped) ─────────────────────────────────────────────

function parseExam(e) {
  return { ...e, questions: JSON.parse(e.questions), settings: JSON.parse(e.settings || DEFAULT_SETTINGS) }
}

// Student-facing view of an exam: same shape as parseExam, minus everything a
// student must never receive (the answer key and the owning teacher's id).
function studentExam(e) {
  const { teacher_id, ...exam } = parseExam(e)
  return { ...exam, questions: exam.questions.map(({ correct, ...q }) => q) }
}

app.get('/api/exams', requireAuth, (req, res) => {
  const exams = db.prepare('SELECT * FROM exams WHERE teacher_id = ? ORDER BY created_at DESC').all(req.teacher.id)
  res.json(exams.map(e => ({ ...parseExam(e), summary: examSummary(e) })))
})

app.post('/api/exams', requireAuth, (req, res) => {
  const { title, questions, time_limit, settings } = req.body
  const id = uuid()
  const code = uniqueCode()
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

// True once anyone has joined or submitted in this sitting.
const sessionHasActivity = db.prepare(`
  SELECT (SELECT COUNT(*) FROM submissions WHERE session_id = ?) +
         (SELECT COUNT(*) FROM events WHERE session_id = ?) AS n
`)

app.patch('/api/exams/:id/active', requireAuth, (req, res) => {
  const { is_active } = req.body
  const exam = db.prepare('SELECT * FROM exams WHERE id = ? AND teacher_id = ?').get(req.params.id, req.teacher.id)
  if (!exam) return res.status(404).json({ error: 'Not found' })
  if (is_active && exam.is_archived) return res.status(400).json({ error: 'Unarchive the exam before opening it' })
  let sessionId = exam.active_session_id
  const opening = is_active && !exam.is_active
  const closing = !is_active && exam.is_active
  if (opening) {
    // Each opening is a sitting. If the current sitting already saw activity,
    // start a fresh one so two sittings never merge into one result set. An
    // unused sitting is simply reused.
    const used = sessionId ? sessionHasActivity.get(sessionId, sessionId).n > 0 : false
    if (!sessionId || used) {
      sessionId = uuid()
      db.prepare('INSERT INTO sessions (id, exam_id, started_at) VALUES (?, ?, ?)').run(sessionId, exam.id, Date.now())
      db.prepare('UPDATE exams SET active_session_id = ? WHERE id = ?').run(sessionId, exam.id)
    } else {
      db.prepare('UPDATE sessions SET ended_at = NULL WHERE id = ?').run(sessionId)
    }
  } else if (closing && sessionId) {
    db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL').run(Date.now(), sessionId)
  }
  db.prepare('UPDATE exams SET is_active = ? WHERE id = ?').run(is_active ? 1 : 0, exam.id)
  res.json({ ok: true, session_id: sessionId })
})

// A closed copy of the exam with its own code and fresh question ids.
app.post('/api/exams/:id/duplicate', requireAuth, (req, res) => {
  const exam = db.prepare('SELECT * FROM exams WHERE id = ? AND teacher_id = ?').get(req.params.id, req.teacher.id)
  if (!exam) return res.status(404).json({ error: 'Not found' })
  const id = uuid()
  const code = uniqueCode()
  const sessionId = uuid()
  const questions = JSON.parse(exam.questions).map(q => ({ ...q, id: uuid() }))
  db.prepare('INSERT INTO sessions (id, exam_id, started_at) VALUES (?, ?, ?)').run(sessionId, id, Date.now())
  db.prepare('INSERT INTO exams (id, teacher_id, title, questions, time_limit, code, active_session_id, settings) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, req.teacher.id, `${exam.title} (copy)`, JSON.stringify(questions), exam.time_limit, code, sessionId, exam.settings || DEFAULT_SETTINGS)
  res.json({ id, code })
})

// A new join code. Students already in keep working; new joins need it.
app.post('/api/exams/:id/code', requireAuth, (req, res) => {
  const exam = db.prepare('SELECT id FROM exams WHERE id = ? AND teacher_id = ?').get(req.params.id, req.teacher.id)
  if (!exam) return res.status(404).json({ error: 'Not found' })
  const code = uniqueCode()
  db.prepare('UPDATE exams SET code = ? WHERE id = ?').run(code, exam.id)
  res.json({ code })
})

// Archiving closes the exam and hides it from the main list; results stay.
app.patch('/api/exams/:id/archive', requireAuth, (req, res) => {
  const exam = db.prepare('SELECT * FROM exams WHERE id = ? AND teacher_id = ?').get(req.params.id, req.teacher.id)
  if (!exam) return res.status(404).json({ error: 'Not found' })
  const archiving = !!req.body.is_archived
  if (archiving && exam.is_active) {
    if (exam.active_session_id) db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL').run(Date.now(), exam.active_session_id)
    db.prepare('UPDATE exams SET is_active = 0 WHERE id = ?').run(exam.id)
  }
  db.prepare('UPDATE exams SET is_archived = ? WHERE id = ?').run(archiving ? 1 : 0, exam.id)
  res.json({ ok: true, is_archived: archiving })
})

// Every sitting of an exam, newest first, with headline counts.
app.get('/api/exams/:id/sessions', requireAuth, (req, res) => {
  const exam = db.prepare('SELECT id, active_session_id FROM exams WHERE id = ? AND teacher_id = ?').get(req.params.id, req.teacher.id)
  if (!exam) return res.status(404).json({ error: 'Not found' })
  const rows = db.prepare(`
    SELECT s.id, s.started_at, s.ended_at,
      (SELECT COUNT(*) FROM submissions WHERE session_id = s.id) AS submission_count,
      (SELECT COUNT(DISTINCT student_name) FROM events WHERE session_id = s.id AND type = 'joined') AS student_count
    FROM sessions s
    WHERE s.exam_id = ?
    ORDER BY s.started_at DESC
  `).all(exam.id)
  res.json(rows.map(r => ({ ...r, is_current: r.id === exam.active_session_id })))
})

// ── Student-facing routes (no auth) ──────────────────────────────────────────

app.get('/api/exams/code/:code', (req, res) => {
  const exam = db.prepare('SELECT * FROM exams WHERE code = ?').get(req.params.code.toUpperCase())
  if (!exam) return res.status(404).json({ error: 'Invalid code' })
  if (!exam.is_active) return res.status(400).json({ error: 'This exam is not open yet. Wait for your teacher to open it.' })
  res.json(studentExam(exam))
})

app.post('/api/submissions', (req, res) => {
  const { session_id, student_name, answers, violations } = req.body
  if (!session_id || !student_name) return res.status(400).json({ error: 'session_id and student_name are required' })
  // First submission stands. The client retries until it gets a success, so a
  // repeat after a lost response must succeed with the original id. A second
  // attempt after a refresh is worth the teacher's attention, so it is logged.
  const existing = db.prepare('SELECT id FROM submissions WHERE session_id = ? AND student_name = ?').get(session_id, student_name)
  if (existing) {
    flagStudent(session_id, student_name, 'duplicate_submission', 'Second submission ignored; first one kept')
    return res.json({ id: existing.id, duplicate: true })
  }
  const id = uuid()
  const ip = req.ip || null
  db.prepare('INSERT INTO submissions (id, session_id, student_name, answers, violations, ip) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, session_id, student_name, JSON.stringify(answers || {}), violations || 0, ip)
  logEvent(session_id, student_name, 'submitted')
  io.to(teacherRoom(session_id)).emit('submission', { id, student_name, violations, answers, ip, submitted_at: Date.now() })
  res.json({ id })
})

// ── Session / results routes (teacher-scoped via session→exam→teacher) ────────

// The session row for a session id, but only if its exam belongs to the given
// teacher. Shared by the HTTP middleware below and the socket monitor join.
const selectOwnedSession = db.prepare(`
  SELECT s.* FROM sessions s
  JOIN exams e ON e.id = s.exam_id
  WHERE s.id = ? AND e.teacher_id = ?
`)

// Resolves :id to a session and checks it belongs to an exam owned by the
// requesting teacher. A missing session, another teacher's exam, or an exam
// with no owner all answer 404, so the id's existence is never confirmed.
function requireSessionOwner(req, res, next) {
  const session = selectOwnedSession.get(req.params.id, req.teacher.id)
  if (!session) return res.status(404).json({ error: 'Not found' })
  req.examSession = session
  next()
}

app.get('/api/sessions/:id', requireAuth, requireSessionOwner, (req, res) => {
  res.json(req.examSession)
})

app.get('/api/sessions/:id/submissions', requireAuth, requireSessionOwner, (req, res) => {
  const subs = db.prepare('SELECT * FROM submissions WHERE session_id = ? ORDER BY submitted_at DESC').all(req.params.id)
  res.json(subs.map(s => ({ ...s, answers: JSON.parse(s.answers) })))
})

app.get('/api/sessions/:id/events', requireAuth, requireSessionOwner, (req, res) => {
  const events = db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY at ASC').all(req.params.id)
  res.json(events)
})

app.get('/api/sessions/:id/export.csv', requireAuth, requireSessionOwner, (req, res) => {
  const session = req.examSession
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
    'Student Name', 'IP Address', 'Submitted At',
    `Score (MC ${mcQuestions.length} questions)`,
    'Violations', 'Copy/Paste Events', 'Brief Exits', 'Environment Flags',
    ...questions.map((q, i) => `Q${i + 1}: ${q.text.replace(/"/g, '""')}`),
    'Action Log'
  ]

  const rows = subs.map(s => {
    const answers = JSON.parse(s.answers)
    const mcCorrect = mcQuestions.filter(q => answers[q.id] === q.correct).length
    const studentEvents = eventsByStudent[s.student_name] || []
    const copyPasteCount = studentEvents.filter(e => e.type === 'note').length
    const briefExitCount = studentEvents.filter(e => e.type === 'brief_exit').length
    const envCount = studentEvents.filter(e => e.type === 'env').length
    // Prefer the IP saved with the submission; fall back to the join event.
    const joinIp = studentEvents.find(e => e.type === 'joined' && e.detail?.startsWith('IP '))?.detail?.slice(3)
    const actionLog = studentEvents
      .map(e => `[${new Date(e.at).toLocaleTimeString()}] ${e.type}${e.detail ? ': ' + e.detail : ''}`)
      .join(' | ')
    return [
      s.student_name,
      s.ip || joinIp || '',
      new Date(s.submitted_at * 1000).toLocaleString(),
      mcQuestions.length > 0 ? `${mcCorrect}/${mcQuestions.length}` : 'N/A',
      s.violations, copyPasteCount, briefExitCount, envCount,
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
  // Teacher monitor joining a session's live feed. Needs the teacher's JWT and
  // ownership of the session's exam; otherwise the socket joins nothing.
  socket.on('join_session', ({ session_id, token } = {}) => {
    const teacher = teacherFromToken(token)
    const session = teacher && session_id ? selectOwnedSession.get(session_id, teacher.id) : null
    if (!session) {
      socket.emit('join_denied', { session_id })
      return
    }
    socket.join(teacherRoom(session_id))
  })

  // Students identify themselves in the connection handshake, so the identity
  // is fixed before any event arrives (including events buffered while
  // offline) and nothing in an event payload can name another student.
  // Unknown sessions are ignored.
  const auth = socket.handshake.auth || {}
  if (auth.role === 'student') {
    const session_id = String(auth.session_id || '')
    const student_name = String(auth.student_name || '').trim().slice(0, 80)
    const known = session_id && db.prepare('SELECT id FROM sessions WHERE id = ?').get(session_id)
    if (known && student_name) {
      socket.join(studentRoom(session_id))
      socket.data.session_id = session_id
      socket.data.student_name = student_name
      const ip = socketIp(socket)
      logEvent(session_id, student_name, 'joined', ip ? `IP ${ip}` : null)
      io.to(teacherRoom(session_id)).emit('student_joined', { id: socket.id, student_name, ip, joined_at: Date.now() })
    }
  }
  // The identity the handshake established, or null for a socket that is not
  // a joined student. Student events are dropped without it.
  const student = () => (socket.data.session_id && socket.data.student_name ? socket.data : null)

  socket.on('violation', ({ count, reason } = {}) => {
    const s = student(); if (!s) return
    const why = String(reason || 'switched away from exam')
    logEvent(s.session_id, s.student_name, 'violation', `#${count} – ${why}`)
    io.to(teacherRoom(s.session_id)).emit('student_violation', { student_name: s.student_name, count, reason: why, at: Date.now() })
  })

  // Something about the student's setup worth a look: a small window beside
  // something else, a second display. Informational, never a violation.
  socket.on('env', ({ detail } = {}) => {
    const s = student(); if (!s) return
    logEvent(s.session_id, s.student_name, 'env', String(detail || ''))
    io.to(teacherRoom(s.session_id)).emit('student_env', { student_name: s.student_name, detail, at: Date.now() })
  })

  socket.on('note', ({ action } = {}) => {
    const s = student(); if (!s) return
    logEvent(s.session_id, s.student_name, 'note', String(action || ''))
    io.to(teacherRoom(s.session_id)).emit('student_note', { student_name: s.student_name, action, at: Date.now() })
  })

  // Left and came back inside the grace window. Not a violation by itself;
  // the client escalates a burst of these into one.
  socket.on('brief_exit', ({ reason } = {}) => {
    const s = student(); if (!s) return
    logEvent(s.session_id, s.student_name, 'brief_exit', String(reason || ''))
    io.to(teacherRoom(s.session_id)).emit('student_brief_exit', { student_name: s.student_name, reason, at: Date.now() })
  })

  // Teacher pauses/resumes a specific student (e.g. bathroom break). Honoured
  // only from a socket that has joined this session's teacher room. Sent to
  // both rooms: the matching student suppresses violations, and the monitor
  // reflects the paused state.
  socket.on('set_pause', ({ session_id, student_name, paused }) => {
    if (!socket.rooms.has(teacherRoom(session_id))) return
    logEvent(session_id, student_name, paused ? 'paused' : 'resumed')
    io.to(studentRoom(session_id)).to(teacherRoom(session_id))
      .emit('pause_state', { student_name, paused: !!paused, at: Date.now() })
  })

  socket.on('keystrokes', ({ keys } = {}) => {
    const s = student(); if (!s) return
    if (!Array.isArray(keys) || !keys.length) return
    const detail = keys.map(k => k.key).join(', ')
    logEvent(s.session_id, s.student_name, 'keystrokes', detail)
    io.to(teacherRoom(s.session_id)).emit('student_keystrokes', { student_name: s.student_name, keys, at: Date.now() })
  })

  socket.on('disconnect', () => {
    const { session_id, student_name } = socket.data
    if (session_id && student_name) {
      logEvent(session_id, student_name, 'disconnected')
      io.to(teacherRoom(session_id)).emit('student_left', { student_name, at: Date.now() })
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
