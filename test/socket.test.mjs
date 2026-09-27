// Socket.IO access checks: who may join the live monitor feed, what students
// can and cannot receive, and who may pause a student.
import { io } from 'socket.io-client'
import { startServer, checker, api, registerTeacher, createOpenExam, sleep } from './lib.mjs'

const MONITOR_EVENTS = ['student_joined', 'student_violation', 'student_note', 'student_keystrokes', 'submission', 'student_left']

const srv = await startServer()
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
  const ada = sock('student Ada')
  const bob = sock('student Bob')
  await Promise.all(sockets.map(connected))

  owner.emit('join_session', { session_id: SID, token: T1 })
  noTok.emit('join_session', { session_id: SID })
  other.emit('join_session', { session_id: SID, token: T2 })
  badTok.emit('join_session', { session_id: SID, token: 'not.a.jwt' })
  await sleep(300)
  ada.emit('student_join', { session_id: SID, student_name: 'Ada' })
  bob.emit('student_join', { session_id: SID, student_name: 'Bob' })
  await sleep(300)

  bob.emit('violation', { session_id: SID, student_name: 'Bob', count: 1 })
  bob.emit('note', { session_id: SID, student_name: 'Bob', action: 'copied text' })
  bob.emit('keystrokes', { session_id: SID, student_name: 'Bob', keys: [{ key: 'h' }, { key: 'i' }] })
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
  t.check('owner sees both joins', owner.got('student_joined').map(r => r.payload.student_name).sort().join() === 'Ada,Bob')
  t.check('owner sees the violation', owner.got('student_violation').length === 1)
  t.check('owner sees the note', owner.got('student_note').length === 1)
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
} finally {
  sockets.forEach(s => s.disconnect())
  await srv.stop()
}
process.exit(t.done('socket') ? 1 : 0)
