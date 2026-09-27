// HTTP-level checks: student payload shape, session ownership, CSV export.
import { startServer, checker, api, registerTeacher, createOpenExam, MC, SHORT } from './lib.mjs'

const srv = await startServer()
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
} finally {
  await srv.stop()
}
process.exit(t.done('http') ? 1 : 0)
