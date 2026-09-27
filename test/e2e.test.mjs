// Browser-level checks in headless Chromium: export download, student join
// without the answer key, live monitor feed, pause and resume.
// Skips cleanly when Playwright is not available.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ROOT, startServer, checker, api, registerTeacher, createOpenExam, loadPlaywright, MC, SHORT } from './lib.mjs'

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
  const fd = new FormData()
  fd.append('file', new Blob(['%PDF-1.4\n%%EOF'], { type: 'application/pdf' }), 'reading.pdf')
  const uploaded = await (await a.raw('/api/upload', { method: 'POST', body: fd }, token)).json()
  const { id, code, session_id: SID } = await createOpenExam(a, token, {
    title: 'Browser Exam',
    questions: [MC('q1', '2+2?', ['3', '4'], 1), { ...SHORT('q2', 'Summarize the reading'), pdf: { url: uploaded.url, name: uploaded.name } }],
  })
  await a.post('/api/submissions', { session_id: SID, student_name: 'Grace', answers: { q1: 1 }, violations: 0 })

  // Teacher and student get separate browser contexts, like two machines.
  const teacherCtx = await browser.newContext({ acceptDownloads: true })
  // The student context pretends to have a second display, and lets the test
  // fake a wider screen (Playwright resizes the emulated screen along with the
  // viewport, so a real viewport change never reads as a smaller window).
  const studentCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  await studentCtx.addInitScript(() => {
    try {
      const realWidth = window.screen.width
      Object.defineProperty(window.screen, 'isExtended', { get: () => true, configurable: true })
      Object.defineProperty(window.screen, 'width', { get: () => window.__fakeScreenWidth || realWidth, configurable: true })
    } catch {}
  })
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
  const linusRow = monitor.locator('[class*="studentRow"]', { hasText: 'Linus' })
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

  t.section('PDF attachment')
  t.check('student sees the attached document', await visible(student.getByText(/reading\.pdf/)))
  const frame = student.locator('iframe[title="reading.pdf"]')
  t.check('document frame present with the viewer toolbar hidden', /toolbar=0/.test((await frame.getAttribute('src')) || ''))
  // Focus moving into the frame blurs the window. That must not count as leaving.
  await student.evaluate(() => {
    document.querySelector('iframe[title="reading.pdf"]').focus()
    window.dispatchEvent(new Event('blur'))
  })
  await student.waitForTimeout(3200)
  t.check('focusing the document is not an exit', (await monitor.getByText(/Linus briefly left/).count()) === 0 && (await linusRow.getByText(/violation/).count()) === 0)
  await student.evaluate(() => { document.activeElement?.blur?.(); window.dispatchEvent(new Event('focus')) })

  t.section('Brief exits: logged, and a burst becomes one violation')
  // Leave and return inside the grace window, three times. Synthetic blur and
  // focus go through the same handlers as a real window switch.
  const flicker = () => student.evaluate(async () => {
    window.dispatchEvent(new Event('blur'))
    await new Promise(r => setTimeout(r, 150))
    window.dispatchEvent(new Event('focus'))
  })
  await flicker()
  t.check('first brief exit reaches the monitor log', await visible(monitor.getByText(/Linus briefly left the exam/).first()))
  t.check('one brief exit, no violation yet', await visible(linusRow.getByText(/1 brief exit/)) && (await linusRow.getByText(/violation/).count()) === 0)
  await flicker()
  await flicker()
  t.check('three brief exits shown', await visible(linusRow.getByText(/3 brief exits/)))
  t.check('burst counted as one violation', await visible(linusRow.getByText(/1 violation/)))
  t.check('student saw the violation warning', await visible(student.getByText(/Violation #1/)))

  t.section('Environment flags')
  t.check('second display flagged at start', await visible(monitor.getByText(/Linus: More than one display connected/)))
  await student.evaluate(() => { window.__fakeScreenWidth = 2560; window.dispatchEvent(new Event('resize')) })
  t.check('small window flagged with its size', await visible(monitor.getByText(/Linus: Exam window is 1280×720 on a 2560×720 screen/)))
  t.check('badge counts both flags', await visible(linusRow.getByText(/2 environment flags/)))
  await student.evaluate(() => { window.__fakeScreenWidth = 0; window.dispatchEvent(new Event('resize')) })
  await student.waitForTimeout(800)
  t.check('flags are not violations', (await linusRow.getByText(/2 violations/).count()) === 0)
  t.check('returning to normal size adds no flag', (await linusRow.getByText(/3 environment flags/).count()) === 0)

  t.section('Focus heartbeat')
  // Pretend focus was lost without any blur event. The heartbeat should open
  // one episode, which becomes one violation, and never repeat while unfocused.
  await student.evaluate(() => { document.hasFocus = () => false })
  t.check('heartbeat records a single violation with its reason', await visible(monitor.getByText(/Linus: violation #2 \(Exam window lost focus\)/), 15000))
  await student.waitForTimeout(8000)
  t.check('no repeat violation while still unfocused', (await monitor.getByText(/violation #3/).count()) === 0)
  await student.evaluate(() => { delete document.hasFocus })
  await student.waitForTimeout(6000)
  t.check('violations stayed at 2 after focus returned', await visible(linusRow.getByText(/2 violations/)) && (await monitor.getByText(/violation #3/).count()) === 0)

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

  t.section('Sitting picker')
  await a.patch(`/api/exams/${id}/active`, { is_active: false }, token)
  await a.patch(`/api/exams/${id}/active`, { is_active: true }, token)
  const { body: sittings } = await a.get(`/api/exams/${id}/sessions`, token)
  t.check('reopening after activity started a second sitting', sittings.length === 2 && sittings[0].is_current && sittings[0].id !== SID)
  await monitor.goto(`${B}/teacher/exam/${id}/monitor`)
  const picker = monitor.locator('select[aria-label="Sitting"]')
  t.check('picker shown with two sittings', await visible(picker) && (await picker.locator('option').count()) === 2)
  t.check('current sitting starts empty', await visible(monitor.getByText('Waiting for students to join...')))
  t.check('current sitting has no past-sitting label', (await monitor.getByText('Past sitting').count()) === 0)
  await picker.selectOption(SID)
  t.check('past sitting shows its students', await visible(monitor.locator('[class*="studentName"]', { hasText: 'Linus' })))
  t.check('past sitting shows its submissions', await visible(monitor.getByText('Submissions (1)')))
  t.check('past sitting is labelled', await visible(monitor.getByText('Past sitting')))
  t.check('URL carries the selected sitting', monitor.url().includes(`session=${SID}`))
  t.check('past sitting has no pause controls', (await monitor.getByRole('button', { name: 'Pause' }).count()) === 0)
} finally {
  await browser.close()
  await srv.stop()
}
process.exit(t.done('e2e') ? 1 : 0)
