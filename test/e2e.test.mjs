// Browser-level checks in headless Chromium: the split-view dashboard, CSV
// export, student join without the answer key, the live feed, pause and
// resume, brief exits, environment flags, the focus heartbeat, the countdown
// across a reload, sittings, and the quick actions.
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
  await a.post('/api/submissions', { session_id: SID, student_name: 'Grace', answers: { q1: 1, q2: 'It was short.' }, violations: 0 })

  // Teacher and student get separate browser contexts, like two machines. The
  // student context pretends to have a second display, and lets the test fake
  // a wider screen (Playwright resizes the emulated screen with the viewport).
  const teacherCtx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1400, height: 900 } })
  const studentCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  await studentCtx.addInitScript(() => {
    try {
      const realWidth = window.screen.width
      Object.defineProperty(window.screen, 'isExtended', { get: () => true, configurable: true })
      Object.defineProperty(window.screen, 'width', { get: () => window.__fakeScreenWidth || realWidth, configurable: true })
    } catch {}
  })
  const dash = await teacherCtx.newPage()
  const apiFailures = []
  dash.on('response', r => { if (r.url().includes('/api/') && r.status() >= 400) apiFailures.push(`${r.status()} ${r.url()}`) })
  const tabBtn = name => dash.getByRole('tab', { name })
  const codeChip = () => dash.locator('[class*="codeChip"]').first()

  t.section('Dashboard: split view with the exam selected')
  await dash.goto(B + '/')
  await dash.evaluate(tok => localStorage.setItem('token', tok), token)
  await dash.goto(`${B}/teacher/exam/${id}`)
  t.check('exam title in the detail panel', await visible(dash.getByRole('heading', { level: 1, name: 'Browser Exam' })))
  t.check('exam row selected in the list', await visible(dash.locator('aside a[aria-current="true"]', { hasText: 'Browser Exam' })))
  t.check('join code shown', (await codeChip().innerText()).trim() === code)
  t.check('overview shows join card', await visible(dash.getByText('Students join with')))
  t.check('overview tab selected by default', (await tabBtn(/^Overview/).getAttribute('aria-selected')) === 'true')

  t.section('Submissions tab: CSV export')
  await tabBtn(/^Submissions/).click()
  const exportBtn = dash.getByRole('button', { name: /Export CSV/ })
  await exportBtn.waitFor({ timeout: 10000 })
  t.check('Grace listed in submissions', await visible(dash.getByText('Grace')))
  {
    const [download] = await Promise.all([dash.waitForEvent('download', { timeout: 10000 }), exportBtn.click()])
    const file = await download.path()
    const csv = fs.readFileSync(file, 'utf8')
    t.check('export button triggers a download', Boolean(file))
    t.check('downloaded filename comes from the server', download.suggestedFilename() === 'Browser_Exam_results.csv', download.suggestedFilename())
    t.check('CSV has header and graded row', csv.includes('"Student Name"') && csv.includes('"Grace"') && csv.includes('[CORRECT]'))
    t.check('no failed API calls so far', apiFailures.length === 0, apiFailures.join(', '))
  }
  await dash.getByRole('button', { name: 'Open', exact: true }).first().click()
  t.check('opening a row shows the graded answers', await visible(dash.getByText('✓ Correct')))

  t.section('Student: join by link without the answer key')
  const student = await studentCtx.newPage()
  await student.goto(`${B}/student?code=${code}`)
  t.check('join link prefills the code', (await student.getByPlaceholder(/e\.g\./).inputValue()) === code)
  await student.getByPlaceholder('First and Last Name').fill('Linus')
  await student.getByRole('button', { name: /Join Exam/ }).click()
  await student.waitForURL(/\/student\/exam/, { timeout: 10000 })
  {
    const stored = await student.evaluate(() => sessionStorage.getItem('exam'))
    t.check('stored exam has no "correct"', Boolean(stored) && !stored.includes('"correct"'))
    t.check('stored exam has no "teacher_id"', Boolean(stored) && !stored.includes('"teacher_id"'))
    t.check('exam renders for the student', await visible(student.getByText('2+2?'), 5000))
  }

  t.section('Live tab: join, pause, resume')
  await tabBtn(/^Live/).click()
  const linusRow = dash.locator('[class*="studentRow"]', { hasText: 'Linus' })
  t.check('monitor shows Linus joining live', await visible(dash.locator('[class*="studentName"]', { hasText: 'Linus' })))
  t.check('activity log records the join', await visible(dash.getByText('Linus joined')))
  t.check('monitor was not denied', (await dash.getByText('not authorized').count()) === 0)
  t.check('list row shows the live counts', await visible(dash.locator('aside a[aria-current="true"]', { hasText: '2 in · 1 submitted' })))
  const pauseBtn = dash.getByRole('button', { name: 'Pause' })
  t.check('exactly one Pause button', (await pauseBtn.count()) === 1)
  await pauseBtn.click()
  t.check('student sees the break overlay', await visible(student.getByText(/paused by your teacher/)))
  t.check('monitor shows the On break badge', await visible(dash.getByText('On break')))
  await dash.getByRole('button', { name: 'Resume' }).click()
  t.check('student overlay clears on resume', await hidden(student.getByText(/paused by your teacher/)))

  t.section('PDF attachment')
  t.check('student sees the attached document', await visible(student.getByText(/reading\.pdf/)))
  const frame = student.locator('iframe[title="reading.pdf"]')
  t.check('document frame present with the viewer toolbar hidden', /toolbar=0/.test((await frame.getAttribute('src')) || ''))
  await student.evaluate(() => {
    document.querySelector('iframe[title="reading.pdf"]').focus()
    window.dispatchEvent(new Event('blur'))
  })
  await student.waitForTimeout(3200)
  t.check('focusing the document is not an exit', (await dash.getByText(/Linus briefly left/).count()) === 0 && (await linusRow.getByText(/violation/).count()) === 0)
  await student.evaluate(() => { document.activeElement?.blur?.(); window.dispatchEvent(new Event('focus')) })

  t.section('Brief exits: logged, and a burst becomes one violation')
  const flicker = () => student.evaluate(async () => {
    window.dispatchEvent(new Event('blur'))
    await new Promise(r => setTimeout(r, 150))
    window.dispatchEvent(new Event('focus'))
  })
  await flicker()
  t.check('first brief exit reaches the monitor log', await visible(dash.getByText(/Linus briefly left the exam/).first()))
  t.check('one brief exit, no violation yet', await visible(linusRow.getByText(/1 brief exit/)) && (await linusRow.getByText(/violation/).count()) === 0)
  await flicker()
  await flicker()
  t.check('three brief exits shown', await visible(linusRow.getByText(/3 brief exits/)))
  t.check('burst counted as one violation', await visible(linusRow.getByText(/1 violation/)))
  t.check('student saw the violation warning', await visible(student.getByText(/Violation #1/)))

  t.section('Environment flags')
  t.check('second display flagged at start', await visible(dash.getByText(/Linus: More than one display connected/)))
  await student.evaluate(() => { window.__fakeScreenWidth = 2560; window.dispatchEvent(new Event('resize')) })
  t.check('small window flagged with its size', await visible(dash.getByText(/Linus: Exam window is 1280×720 on a 2560×720 screen/)))
  t.check('badge counts both flags', await visible(linusRow.getByText(/2 environment flags/)))
  await student.evaluate(() => { window.__fakeScreenWidth = 0; window.dispatchEvent(new Event('resize')) })
  await student.waitForTimeout(800)
  t.check('flags are not violations', (await linusRow.getByText(/2 violations/).count()) === 0)
  t.check('returning to normal size adds no flag', (await linusRow.getByText(/3 environment flags/).count()) === 0)

  t.section('Focus heartbeat')
  await student.evaluate(() => { document.hasFocus = () => false })
  t.check('heartbeat records a single violation with its reason', await visible(dash.getByText(/Linus: violation #2 \(Exam window lost focus\)/), 15000))
  await student.waitForTimeout(8000)
  t.check('no repeat violation while still unfocused', (await dash.getByText(/violation #3/).count()) === 0)
  await student.evaluate(() => { delete document.hasFocus })
  await student.waitForTimeout(6000)
  t.check('violations stayed at 2 after focus returned', await visible(linusRow.getByText(/2 violations/)) && (await dash.getByText(/violation #3/).count()) === 0)

  t.section('Countdown survives a reload')
  const timed = await createOpenExam(a, token, { title: 'Timed Exam', time_limit: 10 })
  const timedCtx = await browser.newContext()
  const tp = await timedCtx.newPage()
  tp.on('dialog', d => d.accept())
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

  t.section('Old monitor URL redirects into the Live tab')
  await dash.goto(`${B}/teacher/exam/${id}/monitor`)
  await dash.waitForURL(/tab=live/, { timeout: 10000 })
  t.check('URL carries tab=live', dash.url().includes(`/teacher/exam/${id}?tab=live`))
  t.check('Live tab is selected', (await tabBtn(/^Live/).getAttribute('aria-selected')) === 'true')

  t.section('Sittings')
  await a.patch(`/api/exams/${id}/active`, { is_active: false }, token)
  await a.patch(`/api/exams/${id}/active`, { is_active: true }, token)
  const { body: sittings } = await a.get(`/api/exams/${id}/sessions`, token)
  t.check('reopening after activity started a second sitting', sittings.length === 2 && sittings[0].is_current && sittings[0].id !== SID)
  await dash.goto(`${B}/teacher/exam/${id}?tab=submissions`)
  const picker = dash.locator('select[aria-label="Sitting"]')
  t.check('sitting picker shown with two sittings', await visible(picker) && (await picker.locator('option').count()) === 2)
  t.check('current sitting starts empty', await visible(dash.getByText('No submissions yet.')))
  t.check('no past-sitting label on the current sitting', (await dash.getByText('Past sitting').count()) === 0)
  await picker.selectOption(SID)
  t.check('past sitting shows its submissions', await visible(dash.getByText('Grace')))
  t.check('past sitting is labelled', await visible(dash.getByText('Past sitting')))
  t.check('URL carries the selected sitting', dash.url().includes(`session=${SID}`))
  await tabBtn(/^Live/).click()
  t.check('past sitting still lists its students', await visible(dash.locator('[class*="studentName"]', { hasText: 'Linus' })))
  t.check('past sitting has no pause controls', (await dash.getByRole('button', { name: 'Pause' }).count()) === 0)
  await tabBtn(/^Sittings/).click()
  t.check('sittings tab lists both sittings', await visible(dash.getByText('Sitting 2')) && (await dash.locator('table tbody tr').count()) === 2)
  t.check('activity log is rebuilt from stored events after a reload', (await tabBtn(/^Live/).click(), await visible(dash.getByText('Linus joined'))))

  t.section('Quick actions: QR, new code, duplicate, archive')
  await dash.goto(`${B}/teacher/exam/${id}`)
  await dash.getByRole('button', { name: 'Show QR code for students' }).click()
  t.check('QR dialog shows a code image', await visible(dash.getByRole('img', { name: /QR code for .*\/student\?code=/ })))
  t.check('QR dialog shows the join code', await visible(dash.getByRole('dialog').getByText(code, { exact: true })))
  await dash.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
  t.check('QR dialog closes', await hidden(dash.getByRole('dialog')))

  const oldCode = (await codeChip().innerText()).trim()
  await dash.getByRole('button', { name: 'More actions' }).click()
  await dash.getByRole('menuitem', { name: 'New join code' }).click()
  t.check('new code confirmed', await visible(dash.getByText(/New join code: [A-Z0-9]{6}/)))
  await dash.waitForFunction(old => document.querySelector('[class*="codeChip"]')?.innerText.trim() !== old, oldCode, { timeout: 5000 }).catch(() => {})
  const newCode = (await codeChip().innerText()).trim()
  t.check('code chip updated', newCode !== oldCode && /^[A-Z0-9]{6}$/.test(newCode), `${oldCode} -> ${newCode}`)
  t.check('old code no longer joins', (await a.get(`/api/exams/code/${oldCode}`)).status === 404)

  const rowsBefore = await dash.locator('aside a[href^="/teacher/exam/"]').count()
  await dash.getByRole('button', { name: 'More actions' }).click()
  await dash.getByRole('menuitem', { name: 'Duplicate exam' }).click()
  t.check('duplicate opens as a closed copy', await visible(dash.getByRole('heading', { level: 1, name: 'Browser Exam (copy)' })) && await visible(dash.getByRole('button', { name: 'Open Exam' })))
  t.check('list gained a row', (await dash.locator('aside a[href^="/teacher/exam/"]').count()) === rowsBefore + 1)

  await dash.getByRole('button', { name: 'More actions' }).click()
  await dash.getByRole('menuitem', { name: 'Archive' }).click()
  t.check('archive confirmed', await visible(dash.getByText('Exam archived')))
  t.check('archived badge shown', await visible(dash.getByText('Archived', { exact: true })))
  t.check('list switches to the archive with the copy in it', await visible(dash.locator('aside a[aria-current="true"]', { hasText: 'Browser Exam (copy)' })))
  await dash.getByRole('button', { name: 'Unarchive' }).click()
  t.check('unarchive restores the exam', await visible(dash.getByText('Exam restored')) && await hidden(dash.getByText('Archived', { exact: true })))
  t.check('no failed API calls during quick actions', apiFailures.length === 0, apiFailures.join(', '))
} finally {
  await browser.close()
  await srv.stop()
}
process.exit(t.done('e2e') ? 1 : 0)
