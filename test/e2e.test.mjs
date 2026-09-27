// Browser-level checks in headless Chromium: export download, student join
// without the answer key, live monitor feed, pause and resume.
// Skips cleanly when Playwright is not available.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ROOT, startServer, checker, api, registerTeacher, createOpenExam, loadPlaywright } from './lib.mjs'

const pw = loadPlaywright()
if (!pw) {
  console.log('SKIP  browser tests: Playwright not found. Run `npm i -D playwright && npx playwright install chromium`, or set PLAYWRIGHT_PATH to an existing install.')
  process.exit(0)
}
if (!fs.existsSync(path.join(ROOT, 'dist/index.html'))) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: ROOT, stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status)
}

const srv = await startServer()
const a = api(srv.base)
const t = checker()
const B = srv.base
const visible = (loc, ms = 10000) => loc.waitFor({ state: 'visible', timeout: ms }).then(() => true, () => false)
const hidden  = (loc, ms = 10000) => loc.waitFor({ state: 'hidden',  timeout: ms }).then(() => true, () => false)

const browser = await pw.chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})
try {
  const token = await registerTeacher(a, 'e2e@x.com')
  const { id, code, session_id: SID } = await createOpenExam(a, token, { title: 'Browser Exam' })
  await a.post('/api/submissions', { session_id: SID, student_name: 'Grace', answers: { q1: 1 }, violations: 0 })

  // Teacher and student get separate browser contexts, like two machines.
  const teacherCtx = await browser.newContext({ acceptDownloads: true })
  const studentCtx = await browser.newContext()
  const monitor = await teacherCtx.newPage()
  const apiFailures = []
  monitor.on('response', r => { if (r.url().includes('/api/') && r.status() >= 400) apiFailures.push(`${r.status()} ${r.url()}`) })

  t.section('Monitor: CSV export')
  await monitor.goto(B + '/')
  await monitor.evaluate(tok => localStorage.setItem('token', tok), token)
  await monitor.goto(`${B}/teacher/exam/${id}/monitor`)
  {
    const btn = monitor.getByRole('button', { name: /Export All as CSV/ })
    await btn.waitFor({ timeout: 10000 })
    const [download] = await Promise.all([monitor.waitForEvent('download', { timeout: 10000 }), btn.click()])
    const file = await download.path()
    const csv = fs.readFileSync(file, 'utf8')
    t.check('export button triggers a download', Boolean(file))
    t.check('downloaded filename comes from the server', download.suggestedFilename() === 'Browser_Exam_results.csv', download.suggestedFilename())
    t.check('CSV has header and graded row', csv.includes('"Student Name"') && csv.includes('"Grace"') && csv.includes('[CORRECT]'))
    t.check('no failed API calls during export', apiFailures.length === 0, apiFailures.join(', '))
  }

  t.section('Student: join without the answer key')
  const student = await studentCtx.newPage()
  await student.goto(B + '/student')
  await student.getByPlaceholder('First and Last Name').fill('Linus')
  await student.getByPlaceholder(/e\.g\./).fill(code)
  await student.getByRole('button', { name: /Join Exam/ }).click()
  await student.waitForURL(/\/student\/exam/, { timeout: 10000 })
  {
    const stored = await student.evaluate(() => sessionStorage.getItem('exam'))
    t.check('stored exam has no "correct"', Boolean(stored) && !stored.includes('"correct"'))
    t.check('stored exam has no "teacher_id"', Boolean(stored) && !stored.includes('"teacher_id"'))
    t.check('exam renders for the student', await visible(student.getByText('2+2?'), 5000))
  }

  t.section('Live feed: join, pause, resume')
  t.check('monitor shows Linus joining live', await visible(monitor.locator('[class*="studentName"]', { hasText: 'Linus' })))
  t.check('activity log records the join', await visible(monitor.getByText('Linus joined')))
  t.check('monitor was not denied', (await monitor.getByText('not authorized').count()) === 0)
  const pauseBtn = monitor.getByRole('button', { name: 'Pause' })
  t.check('exactly one Pause button', (await pauseBtn.count()) === 1)
  await pauseBtn.click()
  t.check('student sees the break overlay', await visible(student.getByText(/paused by your teacher/)))
  t.check('monitor shows the On break badge', await visible(monitor.getByText('On break')))
  await monitor.getByRole('button', { name: 'Resume' }).click()
  t.check('student overlay clears on resume', await hidden(student.getByText(/paused by your teacher/)))

  t.section('Countdown survives a reload')
  const timed = await createOpenExam(a, token, { title: 'Timed Exam', time_limit: 10 })
  const timedCtx = await browser.newContext()
  const tp = await timedCtx.newPage()
  tp.on('dialog', d => d.accept())   // the leave-page prompt on reload
  await tp.goto(B + '/student')
  await tp.getByPlaceholder('First and Last Name').fill('Tim')
  await tp.getByPlaceholder(/e\.g\./).fill(timed.code)
  await tp.getByRole('button', { name: /Join Exam/ }).click()
  await tp.waitForURL(/\/student\/exam/, { timeout: 10000 })
  const readTimer = async () => {
    const txt = await tp.locator('[class*="timer"]').first().innerText()
    const m = txt.match(/(\d+):(\d\d)/)
    return m ? Number(m[1]) * 60 + Number(m[2]) : NaN
  }
  await tp.locator('[class*="timer"]').first().waitFor({ timeout: 5000 })
  await tp.waitForTimeout(2500)
  const before = await readTimer()
  await tp.reload()
  await tp.locator('[class*="timer"]').first().waitFor({ timeout: 10000 })
  const after = await readTimer()
  t.check('timer had started counting before reload', before < 600 && before > 590, String(before))
  t.check('timer did not reset on reload', after <= before && after > 580, `before=${before} after=${after}`)
  await timedCtx.close()
} finally {
  await browser.close()
  await srv.stop()
}
process.exit(t.done('e2e') ? 1 : 0)
