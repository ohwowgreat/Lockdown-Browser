// HTTP-level checks: student payload shape, session ownership, CSV export.
import { startServer, checker, api, registerTeacher, createOpenExam, loginAdmin, MC, SHORT } from './lib.mjs'

const srv = await startServer({ admin: true })
const a = api(srv.base)
const t = checker()
try {
  const T1 = await registerTeacher(a, 't1@x.com')
  const T2 = await registerTeacher(a, 't2@x.com')
  const { id, code, session_id: SID } = await createOpenExam(a, T1, {
    title: 'Smoke Exam',
    questions: [MC('q1', '2+2?', ['3', '4'], 1), SHORT('q2', 'Name a colour')],
  })

  t.section('Student payload (join by code)')
  const joined = await a.get(`/api/exams/code/${code}`)
  t.check('join by code succeeds', joined.status === 200, String(joined.status))
  t.check('payload has no answer key', !joined.text.includes('"correct"'))
  t.check('payload has no teacher id', !joined.text.includes('"teacher_id"'))
  t.check('payload keeps options', joined.body?.questions?.[0]?.options?.length === 2)
  t.check('payload keeps settings', typeof joined.body?.settings === 'object')
  t.check('payload keeps active session id', joined.body?.active_session_id === SID)
  const teacherView = await a.get(`/api/exams/${id}`, T1)
  t.check('teacher view still has the answer key', teacherView.text.includes('"correct"'))
  const { body: closed } = await a.post('/api/exams', { title: 'Closed', questions: [MC('c1', '?', ['a', 'b'], 0)], time_limit: 0 }, T1)
  t.check('closed exam refuses join', (await a.get(`/api/exams/code/${closed.code}`)).status === 400)
  t.check('unknown code is 404', (await a.get('/api/exams/code/NOPE00')).status === 404)

  t.section('Session ownership')
  for (const r of ['', '/submissions', '/events', '/export.csv']) {
    t.check(`other teacher on session${r} gets 404`, (await a.get(`/api/sessions/${SID}${r}`, T2)).status === 404)
    t.check(`owner on session${r} gets 200`, (await a.get(`/api/sessions/${SID}${r}`, T1)).status === 200)
  }
  t.check('bogus session id gets 404', (await a.get('/api/sessions/nope/events', T1)).status === 404)
  t.check('no token gets 401', (await a.get(`/api/sessions/${SID}/export.csv`)).status === 401)
  t.check('other teacher cannot read the exam', (await a.get(`/api/exams/${id}`, T2)).status === 404)

  t.section('Submission and CSV export')
  const sub = await a.post('/api/submissions', { session_id: SID, student_name: 'Ada', answers: { q1: 1, q2: 'blue' }, violations: 0 })
  t.check('submission accepted', sub.status === 200 && Boolean(sub.body?.id), JSON.stringify(sub.body))
  const csv = await a.get(`/api/sessions/${SID}/export.csv`, T1)
  t.check('CSV grades multiple choice server-side', csv.text.includes('4 [CORRECT]'))
  t.check('CSV has the score column', csv.text.includes('"1/1"'))
  t.check('CSV filename comes from the exam title', /filename="Smoke_Exam_results\.csv"/.test(csv.headers.get('content-disposition') || ''))
  t.check('CSV includes the short answer', csv.text.includes('"blue"'))

  t.section('Submissions are idempotent per student')
  const again = await a.post('/api/submissions', { session_id: SID, student_name: 'Ada', answers: { q1: 0 }, violations: 3 })
  t.check('repeat returns the original id', again.status === 200 && again.body?.id === sub.body.id, JSON.stringify(again.body))
  t.check('repeat is marked duplicate', again.body?.duplicate === true)
  const { body: subs } = await a.get(`/api/sessions/${SID}/submissions`, T1)
  t.check('only one row stored', subs.length === 1, String(subs.length))
  t.check('first answers kept', subs[0].answers.q1 === 1)
  const { body: events } = await a.get(`/api/sessions/${SID}/events`, T1)
  t.check('duplicate attempt is logged for the teacher', events.some(e => e.type === 'duplicate_submission' && e.student_name === 'Ada'))
  t.check('missing fields rejected', (await a.post('/api/submissions', { answers: {} })).status === 400)

  t.section('Question attachments')
  const upload = async (bytes, type, name, tok = T1) => {
    const fd = new FormData()
    fd.append('file', new Blob([bytes], { type }), name)
    const r = await a.raw('/api/upload', { method: 'POST', body: fd }, tok)
    return { status: r.status, body: await r.json().catch(() => null) }
  }
  const img = await upload(Buffer.from('89504e470d0a1a0a', 'hex'), 'image/png', 'evil.html')
  t.check('image upload accepted', img.status === 200 && img.body?.kind === 'image', JSON.stringify(img.body))
  t.check('stored extension follows the type, not the filename', /\.png$/.test(img.body?.url || ''), img.body?.url)
  const pdf = await upload(Buffer.from('%PDF-1.4\n%%EOF'), 'application/pdf', 'reading.pdf')
  t.check('pdf upload accepted as kind pdf', pdf.status === 200 && pdf.body?.kind === 'pdf' && /\.pdf$/.test(pdf.body.url), JSON.stringify(pdf.body))
  t.check('original name returned for display', pdf.body?.name === 'reading.pdf')
  const served = await fetch(srv.base + pdf.body.url)
  t.check('pdf served with a pdf content type', served.status === 200 && (served.headers.get('content-type') || '').includes('application/pdf'), served.headers.get('content-type'))
  const txt = await upload(Buffer.from('hello'), 'text/plain', 'notes.txt')
  t.check('other types rejected with a JSON 400', txt.status === 400 && /PDF/.test(txt.body?.error || ''), JSON.stringify(txt.body))
  t.check('upload requires auth', (await a.raw('/api/upload', { method: 'POST', body: new FormData() })).status === 401)

  t.section('Suspension takes effect immediately')
  const ADMIN_TOKEN = await loginAdmin(a)
  const { body: teachers } = await a.get('/api/admin/teachers', ADMIN_TOKEN)
  const t2 = teachers.find(x => x.email === 't2@x.com')
  t.check('T2 works before suspension', (await a.get('/api/exams', T2)).status === 200)
  await a.patch(`/api/admin/teachers/${t2.id}/suspend`, { is_suspended: true }, ADMIN_TOKEN)
  const suspended = await a.get('/api/exams', T2)
  t.check('suspended teacher gets 403 with existing token', suspended.status === 403, String(suspended.status))
  t.check('suspended teacher fails /me, so the client logs out', (await a.get('/api/auth/me', T2)).status === 403)
  t.check('suspended teacher cannot log in', (await a.post('/api/auth/login', { email: 't2@x.com', password: 'pw' })).status === 403)
  await a.patch(`/api/admin/teachers/${t2.id}/suspend`, { is_suspended: false }, ADMIN_TOKEN)
  t.check('unsuspend restores access', (await a.get('/api/exams', T2)).status === 200)
  await a.del(`/api/admin/teachers/${t2.id}`, ADMIN_TOKEN)
  t.check('deleted teacher token gets 401', (await a.get('/api/exams', T2)).status === 401)
  t.check('owner unaffected', (await a.get('/api/exams', T1)).status === 200)
} finally {
  await srv.stop()
}
process.exit(t.done('http') ? 1 : 0)
