// Socket.IO access checks: who may join the live monitor feed, what students
// can and cannot receive, and who may pause a student.
import { io } from 'socket.io-client'
import { startServer, checker, api, registerTeacher, createOpenExam, loginAdmin, sleep } from './lib.mjs'

const MONITOR_EVENTS = ['student_joined', 'student_violation', 'student_note', 'student_brief_exit', 'student_env', 'student_keystrokes', 'submission', 'student_left']

const srv = await startServer({ admin: true })
const a = api(srv.base)
const t = checker()
const sockets = []

// A socket that records everything it receives.
function sock(label, opts = {}) {
  const s = io(srv.base, { transports: ['websocket'], ...opts })
  s.label = label
  s.received = []
  s.onAny((ev, payload) => s.received.push({ ev, payload }))
  s.got = ev => s.received.filter(r => r.ev === ev)
  sockets.push(s)
  return s
}
const connected = s => new Promise(r => (s.connected ? r() : s.once('connect', r)))

try {
  const T1 = await registerTeacher(a, 's1@x.com')
  const T2 = await registerTeacher(a, 's2@x.com')
  const { session_id: SID } = await createOpenExam(a, T1, { title: 'Sock' })

  const owner = sock('owner')
  const noTok = sock('no token')
  const other = sock('other teacher')
  const badTok = sock('garbage token')
  await Promise.all(sockets.map(connected))

  owner.emit('join_session', { session_id: SID, token: T1 })
  noTok.emit('join_session', { session_id: SID })
  other.emit('join_session', { session_id: SID, token: T2 })
  badTok.emit('join_session', { session_id: SID, token: 'not.a.jwt' })
  await sleep(300)

  // Students identify themselves in the handshake, not in events. They connect
  // after the owner is in the teacher room so the owner sees the joins.
  const asStudent = (session_id, student_name) => ({ auth: { role: 'student', session_id, student_name } })
  const ada = sock('student Ada', asStudent(SID, 'Ada'))
  const bob = sock('student Bob', asStudent(SID, 'Bob'))
  const ghost = sock('student in unknown session', asStudent('no-such-session', 'Ghost'))
  const legacy = sock('legacy student_join emitter')
  await Promise.all([ada, bob, ghost, legacy].map(connected))
  legacy.emit('student_join', { session_id: SID, student_name: 'Legacy' })
  await sleep(300)

  // Bob's events. The payload names Ada on purpose: the server must ignore it.
  bob.emit('violation', { session_id: SID, student_name: 'Ada', count: 1, reason: 'Exited fullscreen' })
  bob.emit('env', { detail: 'More than one display connected' })
  bob.emit('note', { action: 'copied text' })
  bob.emit('brief_exit', { reason: 'Exited fullscreen' })
  bob.emit('keystrokes', { keys: [{ key: 'h' }, { key: 'i' }] })
  // Sockets with no student identity: nothing should come of these.
  ghost.emit('violation', { count: 9 })
  noTok.emit('violation', { session_id: SID, student_name: 'Ada', count: 9 })
  legacy.emit('violation', { session_id: SID, student_name: 'Legacy', count: 9 })
  await a.post('/api/submissions', { session_id: SID, student_name: 'Bob', answers: { q1: 1 }, violations: 1 })
  await sleep(300)

  // Unauthorized pause attempts, then the owner's real one.
  noTok.emit('set_pause', { session_id: SID, student_name: 'Ada', paused: true })
  other.emit('set_pause', { session_id: SID, student_name: 'Ada', paused: true })
  ada.emit('set_pause', { session_id: SID, student_name: 'Bob', paused: true })
  await sleep(300)
  const pausesBeforeOwner = ada.got('pause_state').length
  owner.emit('set_pause', { session_id: SID, student_name: 'Ada', paused: true })
  await sleep(300)
  bob.disconnect()
  await sleep(300)

  t.section('Owner monitor socket')
  t.check('owner is not denied', owner.got('join_denied').length === 0)
  t.check('owner sees exactly the two real joins', owner.got('student_joined').map(r => r.payload.student_name).sort().join() === 'Ada,Bob', owner.got('student_joined').map(r => r.payload.student_name).join())
  t.check('owner sees one violation', owner.got('student_violation').length === 1, String(owner.got('student_violation').length))
  t.check('violation is attributed to Bob, not the spoofed name', owner.got('student_violation')[0]?.payload?.student_name === 'Bob')
  t.check('violation carries its reason', owner.got('student_violation')[0]?.payload?.reason === 'Exited fullscreen')
  t.check('owner sees the environment flag', owner.got('student_env')[0]?.payload?.detail === 'More than one display connected')
  t.check('owner sees the note', owner.got('student_note').length === 1)
  t.check('owner sees the brief exit', owner.got('student_brief_exit')[0]?.payload?.reason === 'Exited fullscreen')
  t.check('owner sees keystrokes', owner.got('student_keystrokes').length === 1)
  t.check('owner sees the submission with answers', owner.got('submission')[0]?.payload?.answers?.q1 === 1)
  t.check('owner sees pause_state', owner.got('pause_state').length === 1)
  t.check('owner sees Bob leave', owner.got('student_left')[0]?.payload?.student_name === 'Bob')

  for (const s of [noTok, other, badTok]) {
    t.section(s.label)
    t.check(`${s.label}: told join_denied`, s.got('join_denied').length === 1)
    t.check(`${s.label}: receives no monitor events`, MONITOR_EVENTS.every(ev => s.got(ev).length === 0), s.received.map(r => r.ev).join())
    t.check(`${s.label}: receives no pause_state`, s.got('pause_state').length === 0)
  }

  t.section('Student Ada')
  t.check('Ada receives no monitor events', MONITOR_EVENTS.every(ev => ada.got(ev).length === 0), ada.received.map(r => r.ev).join())
  t.check('Ada never saw Bob\'s answers', !JSON.stringify(ada.received).includes('"answers"'))
  t.check('unauthorized set_pause attempts were ignored', pausesBeforeOwner === 0, `${pausesBeforeOwner} early pause_state`)
  t.check('Ada receives the owner\'s pause_state', ada.got('pause_state').length === 1 && ada.got('pause_state')[0].payload.paused === true)

  const { body: events } = await a.get(`/api/sessions/${SID}/events`, T1)
  t.check('exactly one paused event was logged', events.filter(e => e.type === 'paused').length === 1)

  t.section('Brief exits in the export')
  t.check('brief exit logged under its own type', events.some(e => e.type === 'brief_exit' && e.student_name === 'Bob'))
  const { text: csv } = await a.get(`/api/sessions/${SID}/export.csv`, T1)
  const header = csv.split('\n')[0].split(',')
  const bobRow = csv.split('\n').find(l => l.startsWith('"Bob"'))?.split(',') || []
  t.check('CSV has a Brief Exits column', header.includes('"Brief Exits"'))
  t.check('CSV counts Bob\'s brief exit', bobRow[header.indexOf('"Brief Exits"')] === '"1"', bobRow[header.indexOf('"Brief Exits"')])
  t.check('CSV counts Bob\'s environment flag', bobRow[header.indexOf('"Environment Flags"')] === '"1"', bobRow[header.indexOf('"Environment Flags"')])
  t.check('violation detail includes the reason', events.some(e => e.type === 'violation' && e.detail.includes('Exited fullscreen')))
  t.check('env event logged under its own type', events.some(e => e.type === 'env' && e.student_name === 'Bob'))

  t.section('Unidentified sockets')
  t.check('unknown-session student was never logged as joined', !events.some(e => e.student_name === 'Ghost'))
  t.check('legacy student_join emitter was ignored', !events.some(e => e.student_name === 'Legacy'))
  t.check('no violation logged under a spoofed or foreign name', events.filter(e => e.type === 'violation').length === 1 && events.find(e => e.type === 'violation').student_name === 'Bob')

  t.section('Suspended teacher cannot join the live feed')
  const ADMIN_TOKEN = await loginAdmin(a)
  const { body: teachers } = await a.get('/api/admin/teachers', ADMIN_TOKEN)
  const t1 = teachers.find(x => x.email === 's1@x.com')
  await a.patch(`/api/admin/teachers/${t1.id}/suspend`, { is_suspended: true }, ADMIN_TOKEN)
  const late = sock('owner after suspension')
  await connected(late)
  late.emit('join_session', { session_id: SID, token: T1 })
  await sleep(300)
  t.check('suspended owner is denied', late.got('join_denied').length === 1)
} finally {
  sockets.forEach(s => s.disconnect())
  await srv.stop()
}
process.exit(t.done('socket') ? 1 : 0)
