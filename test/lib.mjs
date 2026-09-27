// Shared helpers for the ExamLock test suite. Each test file starts its own
// server on a free port against a throwaway SQLite file, so tests never touch
// a real database and can run in any order.
import { spawn } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const sleep = ms => new Promise(r => setTimeout(r, ms))

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

// Starts server/index.js on a free port with a fresh DB and uploads folder.
// Resolves once the API answers. `stop()` kills it and removes the scratch dir.
export async function startServer() {
  const port = await freePort()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'examlock-test-'))
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: path.join(dir, 'test.db'),
      UPLOADS_PATH: path.join(dir, 'uploads'),
      JWT_SECRET: 'examlock-test-secret',
      ADMIN_EMAIL: '',
      ADMIN_PASSWORD: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', d => { output += d })
  child.stderr.on('data', d => { output += d })

  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 15000
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${output}`)
    try { await fetch(`${base}/api/auth/me`); break } catch {}
    if (Date.now() > deadline) throw new Error(`server did not start in time:\n${output}`)
    await sleep(100)
  }

  return {
    base,
    dir,
    log: () => output,
    async stop() {
      if (child.exitCode === null) {
        child.kill()
        await new Promise(r => child.once('exit', r))
      }
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

// Tiny pass/fail tally. `done()` prints the summary and returns the fail count.
export function checker() {
  let pass = 0, fail = 0
  return {
    check(name, ok, extra = '') {
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra ? `   [${extra}]` : ''}`)
      ok ? pass++ : fail++
    },
    section(title) { console.log(`\n=== ${title} ===`) },
    done(label) {
      console.log(`\n${label}: ${pass} passed, ${fail} failed`)
      return fail
    },
  }
}

// JSON API helpers bound to a base URL. Every call returns { status, body }.
export function api(base) {
  const hdr = tok => (tok ? { Authorization: `Bearer ${tok}` } : {})
  async function send(method, p, body, tok, extraHeaders = {}) {
    const res = await fetch(base + p, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...hdr(tok), ...extraHeaders },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch {}
    return { status: res.status, body: json, text, headers: res.headers }
  }
  return {
    get: (p, tok) => send('GET', p, undefined, tok),
    post: (p, body, tok) => send('POST', p, body, tok),
    put: (p, body, tok) => send('PUT', p, body, tok),
    patch: (p, body, tok) => send('PATCH', p, body, tok),
    del: (p, tok) => send('DELETE', p, undefined, tok),
    // Raw fetch for non-JSON bodies such as file uploads.
    raw: (p, init = {}, tok) => fetch(base + p, { ...init, headers: { ...hdr(tok), ...(init.headers || {}) } }),
  }
}

export const MC = (id, text, options, correct) => ({ id, type: 'multiple_choice', text, options, correct })
export const SHORT = (id, text) => ({ id, type: 'short_answer', text })

export async function registerTeacher(a, email, name = email.split('@')[0]) {
  const { body } = await a.post('/api/auth/register', { email, name, password: 'pw' })
  if (!body?.token) throw new Error(`register failed: ${JSON.stringify(body)}`)
  return body.token
}

// Creates an exam, opens it, and returns ids plus the teacher's view of it.
export async function createOpenExam(a, token, opts = {}) {
  const {
    title = 'Test Exam',
    questions = [MC('q1', '2+2?', ['3', '4'], 1)],
    time_limit = 0,
    settings,
  } = opts
  const { body: created } = await a.post('/api/exams', { title, questions, time_limit, settings }, token)
  if (!created?.id) throw new Error(`create exam failed: ${JSON.stringify(created)}`)
  await a.patch(`/api/exams/${created.id}/active`, { is_active: true }, token)
  const { body: exam } = await a.get(`/api/exams/${created.id}`, token)
  return { id: created.id, code: created.code, session_id: exam.active_session_id, exam }
}

// Loads Playwright from the project (if installed as a dev dependency) or from
// PLAYWRIGHT_PATH. Returns null when neither works so callers can skip.
export function loadPlaywright() {
  const req = createRequire(import.meta.url)
  for (const candidate of ['playwright', process.env.PLAYWRIGHT_PATH].filter(Boolean)) {
    try { return req(candidate) } catch {}
  }
  return null
}
