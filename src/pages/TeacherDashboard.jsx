import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import QRCode from 'qrcode'
import { useAuth } from '../context/AuthContext'
import { useExamMonitor } from '../hooks/useExamMonitor'
import SubmissionDetail, { calcScore } from '../components/SubmissionDetail'
import styles from './TeacherDashboard.module.css'

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'live', label: 'Live' },
  { key: 'submissions', label: 'Submissions' },
  { key: 'sittings', label: 'Sittings' },
  { key: 'settings', label: 'Settings' },
]
const MAX_QUESTION_COLUMNS = 6

const letter = i => String.fromCharCode(65 + i)
const wordCount = text => String(text || '').trim().split(/\s+/).filter(Boolean).length
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
const clock = ms => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const when = ms => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
// Stored submissions carry unix seconds; live ones carry milliseconds.
const submittedMs = sub => (sub.submitted_at > 1e12 ? sub.submitted_at : sub.submitted_at * 1000)
const joinUrl = code => `${window.location.origin}/student?code=${code}`

function attachmentCount(exam) {
  return exam.questions.reduce((n, q) => n + (q.image ? 1 : 0) + (q.pdf ? 1 : 0), 0)
}

function metaLine(exam) {
  const s = exam.settings || {}
  const parts = [
    plural(exam.questions.length, 'question'),
    exam.time_limit > 0 ? `${exam.time_limit} min` : 'No time limit',
    `Navigation: ${s.navigation || 'track'}`,
    `Copy/paste: ${s.copy_paste || 'track'}`,
    `Keystrokes: ${s.log_keystrokes ? 'on' : 'off'}`,
  ]
  const att = attachmentCount(exam)
  if (att) parts.push(plural(att, 'attachment'))
  return parts.join(' · ')
}

// Inline stroke icons. Sized by their box, coloured by the surrounding text.
const svg = paths => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths}</svg>
)
const Icon = {
  copy: () => svg(<><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>),
  qr: () => svg(<><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><path d="M14 14h3v3h-3z" /><path d="M18 18h3v3h-3z" /></>),
  more: () => svg(<><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></>),
  search: () => svg(<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>),
  download: () => svg(<><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></>),
  refresh: () => svg(<><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></>),
  archive: () => svg(<><rect x="3" y="4" width="18" height="4" /><path d="M5 8v12h14V8" /><path d="M10 12h4" /></>),
  trash: () => svg(<><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M6 6l1 14h10l1-14" /></>),
  layers: () => svg(<><path d="m12 2 10 5-10 5L2 7z" /><path d="m2 12 10 5 10-5" /><path d="m2 17 10 5 10-5" /></>),
}

export default function TeacherDashboard() {
  const nav = useNavigate()
  const { id: selectedId } = useParams()
  const [params, setParams] = useSearchParams()
  const { teacher, logout, authHeaders } = useAuth()

  const [exams, setExams] = useState(null)   // null while loading
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [showArchived, setShowArchived] = useState(false)
  const [live, setLive] = useState({})       // exam id -> counts from the open detail

  const refreshExams = useCallback(() => (
    fetch('/api/exams', { headers: authHeaders() })
      .then(r => (r.ok ? r.json() : []))
      .then(list => { setExams(list); return list })
  ), [])
  useEffect(() => { refreshExams() }, [refreshExams])

  const tab = TABS.some(t => t.key === params.get('tab')) ? params.get('tab') : 'overview'
  const rawSession = params.get('session')
  const sessionParam = rawSession && rawSession !== 'null' ? rawSession : null
  const setParam = useCallback(changes => {
    setParams(prev => {
      const p = new URLSearchParams(prev)
      for (const [k, v] of Object.entries(changes)) (v == null ? p.delete(k) : p.set(k, v))
      return p
    }, { replace: true })
  }, [setParams])

  const selected = exams?.find(e => e.id === selectedId) || null

  // Nothing selected: land on the first exam. A stale id (deleted): go home.
  useEffect(() => {
    if (!exams) return
    if (!selectedId) {
      const first = exams.find(e => !e.is_archived) || exams[0]
      if (first) nav(`/teacher/exam/${first.id}`, { replace: true })
    } else if (!selected) {
      nav('/teacher', { replace: true })
    }
  }, [exams, selectedId, selected, nav])

  // Keep the list in step with the archive toggle when the selection changes.
  useEffect(() => { if (selected?.is_archived) setShowArchived(true) }, [selected])

  const onLive = useCallback((id, counts) => setLive(l => ({ ...l, [id]: counts })), [])

  const pool = useMemo(() => (exams || []).filter(e => !!e.is_archived === showArchived), [exams, showArchived])
  const archivedCount = (exams || []).filter(e => e.is_archived).length
  const visible = useMemo(() => pool.filter(e => {
    if (filter === 'open' && !e.is_active) return false
    if (filter === 'closed' && e.is_active) return false
    const q = search.trim().toLowerCase()
    return !q || e.title.toLowerCase().includes(q) || e.code.toLowerCase().includes(q)
  }), [pool, filter, search])
  const counts = {
    all: pool.length,
    open: pool.filter(e => e.is_active).length,
    closed: pool.filter(e => !e.is_active).length,
  }

  function rowSummary(e) {
    const s = { ...(e.summary || {}), ...(live[e.id] || {}) }
    if (e.is_active) {
      const bits = [`${s.joined || 0} in`, `${s.submitted || 0} submitted`]
      if (s.violators) bits.push(`${plural(s.violators, 'student')} with violations`)
      return `${e.code} · ${bits.join(' · ')}`
    }
    return `${e.code} · ${s.submitted || 0} submitted · ${plural(s.sittings || 1, 'sitting')}`
  }

  return (
    <div className={styles.wrap}>
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <span className={styles.logo} onClick={() => nav('/')}>ExamLock</span>
          <span className={styles.role}>Teacher</span>
          <span className={styles.teacherName}>{teacher?.name}</span>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button className="btn-primary" onClick={() => nav('/teacher/exam/new')}>+ New Exam</button>
          <button className="btn-ghost" onClick={() => { logout(); nav('/') }}>Log out</button>
        </div>
      </header>

      <div className={styles.split}>
        <aside className={styles.list} aria-label="Exams">
          <div className={styles.listTools}>
            <label className={styles.search}>
              <Icon.search />
              <input
                type="search"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search exams"
                aria-label="Search exams"
              />
            </label>
            <div className={styles.chips}>
              {[['all', 'All'], ['open', 'Open'], ['closed', 'Closed']].map(([key, label]) => (
                <button
                  key={key}
                  className={`${styles.chip} ${filter === key ? styles.chipActive : ''}`}
                  onClick={() => setFilter(key)}
                >
                  {label} {counts[key]}
                </button>
              ))}
            </div>
          </div>

          <div className={styles.rows}>
            {exams === null && <p className={styles.listEmpty}>Loading...</p>}
            {exams !== null && visible.length === 0 && (
              <p className={styles.listEmpty}>
                {pool.length === 0 ? (showArchived ? 'No archived exams.' : 'No exams yet.') : 'No exams match.'}
              </p>
            )}
            {visible.map(e => (
              <Link
                key={e.id}
                to={`/teacher/exam/${e.id}`}
                className={`${styles.row} ${e.id === selectedId ? styles.rowActive : ''}`}
                aria-current={e.id === selectedId ? 'true' : undefined}
              >
                <div className={styles.rowTop}>
                  <span className={styles.rowTitle}>{e.title}</span>
                  {e.is_active
                    ? <span className={styles.rowOpen}><span className={styles.dot} />Open</span>
                    : <span className={styles.rowClosed}>Closed</span>}
                </div>
                <span className={styles.rowMeta}>{rowSummary(e)}</span>
              </Link>
            ))}
          </div>

          <div className={styles.listFoot}>
            {showArchived
              ? <button className={styles.linkBtn} onClick={() => setShowArchived(false)}>Back to current exams</button>
              : <span>{plural(archivedCount, 'archived exam')} · <button className={styles.linkBtn} onClick={() => setShowArchived(true)} disabled={!archivedCount}>Show</button></span>}
          </div>
        </aside>

        <section className={styles.detail}>
          {exams !== null && exams.length === 0 && (
            <div className={`card ${styles.emptyCard}`}>
              <p>No exams yet. Create your first one!</p>
              <button className="btn-primary" onClick={() => nav('/teacher/exam/new')}>Create Exam</button>
            </div>
          )}
          {selected && (
            <ExamDetail
              key={selected.id}
              exam={selected}
              tab={tab}
              sessionParam={sessionParam}
              setParam={setParam}
              refreshExams={refreshExams}
              onLive={onLive}
            />
          )}
        </section>
      </div>
    </div>
  )
}

function ExamDetail({ exam, tab, sessionParam, setParam, refreshExams, onLive }) {
  const nav = useNavigate()
  const { authHeaders } = useAuth()
  const mon = useExamMonitor({ exam, sessionParam })
  const [menuOpen, setMenuOpen] = useState(false)
  const [qrOpen, setQrOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(''), 3000)
    return () => clearTimeout(t)
  }, [notice])

  // Feed live counts to the list row while the current sitting is showing.
  useEffect(() => {
    if (!mon.isCurrentSitting) return
    onLive(exam.id, {
      joined: mon.students.length,
      submitted: mon.submissions.length,
      violators: mon.students.filter(s => s.violations > 0).length,
    })
  }, [exam.id, mon.isCurrentSitting, mon.students, mon.submissions, onLive])

  async function call(method, path, body) {
    setBusy(true)
    try {
      const res = await fetch(path, {
        method,
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: body ? JSON.stringify(body) : undefined,
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      return data
    } catch (e) {
      setNotice(e.message)
      return null
    } finally {
      setBusy(false)
    }
  }

  async function toggleActive() {
    const data = await call('PATCH', `/api/exams/${exam.id}/active`, { is_active: !exam.is_active })
    if (!data) return
    setParam({ session: null })
    await refreshExams()
    setNotice(exam.is_active ? 'Exam closed. No one else can join.' : 'Exam open. Students can join with the code.')
  }
  async function copyText(text, what) {
    try { await navigator.clipboard.writeText(text); setNotice(`${what} copied`) } catch { setNotice('Could not copy') }
  }
  async function duplicate() {
    setMenuOpen(false)
    const d = await call('POST', `/api/exams/${exam.id}/duplicate`)
    if (!d) return
    await refreshExams()
    nav(`/teacher/exam/${d.id}`)
  }
  async function newCode() {
    setMenuOpen(false)
    const d = await call('POST', `/api/exams/${exam.id}/code`)
    if (!d) return
    await refreshExams()
    setNotice(`New join code: ${d.code}`)
  }
  async function setArchived(is_archived) {
    setMenuOpen(false)
    const d = await call('PATCH', `/api/exams/${exam.id}/archive`, { is_archived })
    if (!d) return
    await refreshExams()
    setNotice(is_archived ? 'Exam archived' : 'Exam restored')
  }
  async function remove() {
    setMenuOpen(false)
    if (!confirm(`Delete "${exam.title}" and all of its results? This cannot be undone.`)) return
    const d = await call('DELETE', `/api/exams/${exam.id}`)
    if (!d) return
    await refreshExams()
    nav('/teacher')
  }

  const setTab = key => setParam({ tab: key === 'overview' ? null : key })
  const inProgress = mon.students.filter(s => !s.submitted).length
  const tabCount = { live: exam.is_active && mon.isCurrentSitting ? inProgress : null, submissions: mon.submissions.length, sittings: mon.sessions.length }
  const currentSittingNo = mon.sessions.length ? mon.sessions.length - mon.sessions.findIndex(s => s.id === mon.sid) : null

  return (
    <div className={styles.detailInner}>
      {notice && <div className={styles.notice} role="status">{notice}</div>}

      <div className={styles.detailHead}>
        <div className={styles.detailTitle}>
          <div className={styles.titleRow}>
            <h1>{exam.title}</h1>
            {exam.is_archived
              ? <span className="badge badge-yellow">Archived</span>
              : exam.is_active
                ? <span className={styles.badgeOpen}><span className={styles.dot} />Open{currentSittingNo && mon.isCurrentSitting ? ` · sitting ${currentSittingNo}` : ''}</span>
                : <span className={styles.badgeClosed}>Closed</span>}
            {!mon.isCurrentSitting && <span className={styles.badgeClosed}>Past sitting</span>}
          </div>
          <span className={styles.meta}>{metaLine(exam)}</span>
        </div>

        <div className={styles.detailActions}>
          <span className={styles.codeChip}>{exam.code}</span>
          <button className={styles.iconBtn} aria-label="Copy join code" title="Copy join code" onClick={() => copyText(exam.code, 'Code')}><Icon.copy /></button>
          <button className={styles.iconBtn} aria-label="Show QR code for students" title="Show QR code" onClick={() => setQrOpen(true)}><Icon.qr /></button>
          <span className={styles.vr} />
          <button className="btn-ghost" onClick={() => nav(`/teacher/exam/${exam.id}/preview`)}>Preview</button>
          <button className="btn-ghost" onClick={() => nav(`/teacher/exam/${exam.id}/edit`)}>Edit</button>
          {exam.is_archived
            ? <button className="btn-ghost" onClick={() => setArchived(false)} disabled={busy}>Unarchive</button>
            : exam.is_active
              ? <button className={styles.closeBtn} onClick={toggleActive} disabled={busy}>Close Exam</button>
              : <button className="btn-primary" onClick={toggleActive} disabled={busy}>Open Exam</button>}
          <div className={styles.menuWrap}>
            <button className={styles.iconBtn} aria-label="More actions" aria-expanded={menuOpen} onClick={() => setMenuOpen(o => !o)}><Icon.more /></button>
            {menuOpen && (
              <>
                <div className={styles.menuBackdrop} onClick={() => setMenuOpen(false)} />
                <div className={styles.menu} role="menu">
                  <button role="menuitem" onClick={duplicate}><Icon.copy />Duplicate exam</button>
                  <button role="menuitem" onClick={() => { setMenuOpen(false); mon.exportCsv() }} disabled={!mon.submissions.length}><Icon.download />Export CSV</button>
                  <button role="menuitem" onClick={newCode}><Icon.refresh />New join code</button>
                  <button role="menuitem" onClick={() => { setMenuOpen(false); setTab('sittings') }}><Icon.layers />Sittings ({mon.sessions.length})</button>
                  {exam.is_archived
                    ? <button role="menuitem" onClick={() => setArchived(false)}><Icon.archive />Unarchive</button>
                    : <button role="menuitem" onClick={() => setArchived(true)}><Icon.archive />Archive</button>}
                  <div className={styles.menuRule} />
                  <button role="menuitem" className={styles.menuDanger} onClick={remove}><Icon.trash />Delete</button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <div className={styles.tabs} role="tablist" aria-label="Exam sections">
        {TABS.map(t => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={`${styles.tab} ${tab === t.key ? styles.tabActive : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            {t.key === 'live' && exam.is_active && mon.isCurrentSitting && <span className={styles.tabLive}><span className={styles.dot} />{tabCount.live}</span>}
            {t.key === 'submissions' && <span className={styles.tabCount}>{tabCount.submissions}</span>}
            {t.key === 'sittings' && mon.sessions.length > 1 && <span className={styles.tabCount}>{tabCount.sittings}</span>}
          </button>
        ))}
      </div>

      <div role="tabpanel" className={styles.panel}>
        {tab === 'overview' && <OverviewPanel exam={exam} mon={mon} onQr={() => setQrOpen(true)} onCopy={copyText} onPreview={() => nav(`/teacher/exam/${exam.id}/preview`)} setTab={setTab} currentSittingNo={currentSittingNo} />}
        {tab === 'live' && <LivePanel exam={exam} mon={mon} setParam={setParam} />}
        {tab === 'submissions' && <SubmissionsPanel exam={exam} mon={mon} setParam={setParam} setTab={setTab} />}
        {tab === 'sittings' && <SittingsPanel mon={mon} setParam={setParam} />}
        {tab === 'settings' && <SettingsPanel exam={exam} busy={busy} onEdit={() => nav(`/teacher/exam/${exam.id}/edit`)} onNewCode={newCode} onDuplicate={duplicate} onArchive={setArchived} onDelete={remove} />}
      </div>

      {qrOpen && <QrDialog exam={exam} onClose={() => setQrOpen(false)} />}
    </div>
  )
}

function Tile({ value, label, tone }) {
  return (
    <div className={`${styles.tile} ${tone ? styles[`tile_${tone}`] : ''}`}>
      <span className={styles.tileValue}>{value}</span>
      <span className={styles.tileLabel}>{label}</span>
    </div>
  )
}

function averageScore(exam, submissions) {
  let correct = 0, total = 0
  for (const sub of submissions) {
    const s = calcScore(exam.questions, sub.answers || {})
    if (s) { correct += s.correct; total += s.total }
  }
  return total ? `${Math.round((correct / total) * 100)}%` : 'n/a'
}

function SittingPicker({ mon, setParam }) {
  if (mon.sessions.length < 2) return null
  return (
    <select
      aria-label="Sitting"
      className={styles.sittingPicker}
      value={mon.sid || ''}
      onChange={e => setParam({ session: e.target.value === (mon.sessions.find(s => s.is_current)?.id) ? null : e.target.value })}
    >
      {mon.sessions.map((s, i) => (
        <option key={s.id} value={s.id}>
          Sitting {mon.sessions.length - i} · {when(s.started_at)} · {plural(s.submission_count, 'submission')}{s.is_current ? ' · current' : ''}
        </option>
      ))}
    </select>
  )
}

function OverviewPanel({ exam, mon, onQr, onCopy, onPreview, setTab, currentSittingNo }) {
  const s = exam.settings || {}
  const byType = exam.questions.reduce((m, q) => ({ ...m, [q.type]: (m[q.type] || 0) + 1 }), {})
  const typeLabel = { multiple_choice: 'multiple choice', short_answer: 'short answer', essay: 'essay', drawing: 'drawing' }
  const calculators = exam.questions.filter(q => q.calculator && q.calculator !== 'none').length
  const violators = mon.students.filter(x => x.violations > 0).length
  const flags = mon.students.reduce((n, x) => n + (x.envFlags || 0), 0)
  const sitting = mon.sessions.find(x => x.id === mon.sid)
  return (
    <div className={styles.stack}>
      <div className={styles.twoCol}>
        <section className={`card ${styles.joinCard}`}>
          <p className={styles.cardLabel}>Students join with</p>
          <div className={styles.joinCode}>{exam.code}</div>
          <p className={styles.joinUrl}>{joinUrl(exam.code)}</p>
          <div className={styles.rowGap}>
            <button className="btn-primary" onClick={onQr}>Show QR code</button>
            <button className="btn-ghost" onClick={() => onCopy(joinUrl(exam.code), 'Join link')}>Copy link</button>
            <button className="btn-ghost" onClick={() => onCopy(exam.code, 'Code')}>Copy code</button>
          </div>
          {!exam.is_active && <p className={styles.hint}>The exam is closed. Students can join once you open it.</p>}
        </section>

        <section className="card">
          <p className={styles.cardLabel}>{mon.isCurrentSitting ? 'This sitting' : 'Selected sitting'}</p>
          <div className={styles.tiles}>
            <Tile value={mon.students.length} label="Students in" />
            <Tile value={mon.submissions.length} label="Submitted" />
            <Tile value={averageScore(exam, mon.submissions)} label="Avg score (MC)" />
            <Tile value={violators} label="With violations" tone={violators ? 'warn' : ''} />
            <Tile value={flags} label="Environment flags" tone={flags ? 'warn' : ''} />
          </div>
          <p className={styles.hint}>
            {sitting
              ? `Sitting ${currentSittingNo} of ${mon.sessions.length} · started ${when(sitting.started_at)}${sitting.ended_at ? ` · ended ${clock(sitting.ended_at)}` : ''}`
              : 'No sitting yet.'}
            {' '}<button className={styles.linkBtn} onClick={() => setTab('live')}>Watch live</button>
          </p>
        </section>
      </div>

      <div className={styles.twoCol}>
        <section className="card">
          <p className={styles.cardLabel}>Restrictions</p>
          <dl className={styles.kv}>
            <dt>Navigation away</dt><dd>{s.navigation || 'track'}</dd>
            <dt>Copy and paste</dt><dd>{s.copy_paste || 'track'}</dd>
            <dt>Keystroke logging</dt><dd>{s.log_keystrokes ? 'on' : 'off'}</dd>
          </dl>
          <button className="btn-ghost" onClick={() => setTab('settings')}>Settings</button>
        </section>
        <section className="card">
          <p className={styles.cardLabel}>Questions</p>
          <p className={styles.bodyText}>
            {plural(exam.questions.length, 'question')}: {Object.entries(byType).map(([t, n]) => `${n} ${typeLabel[t] || t}`).join(', ')}.
            {attachmentCount(exam) ? ` ${plural(attachmentCount(exam), 'attachment')}.` : ''}
            {calculators ? ` Calculator on ${plural(calculators, 'question')}.` : ''}
            {exam.time_limit > 0 ? ` ${exam.time_limit} minutes.` : ' No time limit.'}
          </p>
          <button className="btn-ghost" onClick={onPreview}>Preview as a student</button>
        </section>
      </div>
    </div>
  )
}

function LivePanel({ exam, mon, setParam }) {
  return (
    <div className={styles.stack}>
      <div className={styles.joinBox}>
        <p>Students go to <strong>{window.location.origin}/student</strong> and enter code <strong>{exam.code}</strong></p>
        <SittingPicker mon={mon} setParam={setParam} />
      </div>
      <div className={styles.liveGrid}>
        <section>
          <h2 className={styles.h2}>Live Students ({mon.students.length})</h2>
          <div className={styles.studentList}>
            {mon.students.length === 0 && <p className={styles.empty}>Waiting for students to join...</p>}
            {mon.students.map(s => (
              <div key={s.name} className={styles.studentRow}>
                <span className={styles.studentName}>
                  {s.name}
                  {s.ip && <span className={styles.studentIp}>{s.ip}</span>}
                </span>
                <div className={styles.studentBadges}>
                  {s.violations > 0 && <span className="badge badge-yellow">⚠️ {plural(s.violations, 'violation')}</span>}
                  {s.notes > 0 && <span className="badge badge-blue">📋 {s.notes} copy/paste</span>}
                  {s.briefExits > 0 && <span className="badge badge-blue">↩ {plural(s.briefExits, 'brief exit')}</span>}
                  {s.envFlags > 0 && <span className="badge badge-yellow">🖥 {plural(s.envFlags, 'environment flag')}</span>}
                  {s.paused && !s.submitted && <span className="badge badge-yellow">⏸️ On break</span>}
                  {s.submitted
                    ? <span className="badge badge-green">Submitted</span>
                    : <span className="badge badge-blue">In Progress</span>}
                  {!s.submitted && mon.isCurrentSitting && (
                    <button className="btn-ghost" style={{ padding: '0.2rem 0.6rem', fontSize: '0.8125rem' }} onClick={() => mon.togglePause(s.name, !s.paused)}>
                      {s.paused ? 'Resume' : 'Pause'}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
        <section>
          <h2 className={styles.h2}>Activity Log</h2>
          <div className={styles.logBox}>
            {mon.log.length === 0 && <p className={styles.empty}>No activity yet</p>}
            {mon.log.map((l, i) => (
              <div key={i} className={`${styles.logRow} ${styles[`log_${l.type}`] || ''}`}>
                <span className={styles.logTime}>{l.time}</span>
                <span>
                  {l.type === 'warn' && '⚠️ '}
                  {l.type === 'note' && '📋 '}
                  {l.type === 'ok' && '✅ '}
                  {l.type === 'keystroke' && '⌨️ '}
                  {l.type === 'env' && '🖥 '}
                  {l.msg}
                </span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}

function answerCell(q, ans) {
  if (ans === undefined || ans === null || ans === '') return <span className={styles.cellMuted}>none</span>
  if (q.type === 'multiple_choice') {
    const ok = ans === q.correct
    return <span className={ok ? styles.cellRight : styles.cellWrong}>{letter(ans)}</span>
  }
  if (q.type === 'drawing') return <span className={styles.cellMuted}>drawing</span>
  if (q.type === 'essay') return <span className={styles.cellMuted}>{plural(wordCount(ans), 'word')}</span>
  const text = String(ans)
  return text.length > 28 ? `${text.slice(0, 28)}…` : text
}

function SubmissionsPanel({ exam, mon, setParam, setTab }) {
  const [attentionOnly, setAttentionOnly] = useState(false)
  const [open, setOpen] = useState(null)
  const cols = exam.questions.slice(0, MAX_QUESTION_COLUMNS)

  const rows = useMemo(() => {
    const perStudent = {}
    for (const e of mon.events) {
      const s = perStudent[e.student_name] || (perStudent[e.student_name] = { briefExits: 0, env: 0, duplicate: false })
      if (e.type === 'brief_exit') s.briefExits += 1
      if (e.type === 'env') s.env += 1
      if (e.type === 'duplicate_submission') s.duplicate = true
    }
    return [...mon.submissions]
      .sort((a, b) => submittedMs(b) - submittedMs(a))
      .map(sub => {
        const extra = perStudent[sub.student_name] || { briefExits: 0, env: 0, duplicate: false }
        const attention = sub.violations > 0 || extra.env > 0 || extra.duplicate
        return { sub, ...extra, attention, score: calcScore(exam.questions, sub.answers || {}) }
      })
      .filter(r => !attentionOnly || r.attention)
  }, [mon.submissions, mon.events, exam.questions, attentionOnly])

  const violators = mon.students.filter(x => x.violations > 0).length
  const flags = mon.students.reduce((n, x) => n + (x.envFlags || 0), 0)
  const stillWriting = mon.students.filter(x => !x.submitted).length

  return (
    <div className={styles.stack}>
      <div className={styles.tiles}>
        <Tile value={<>{mon.submissions.length} <small>of {mon.students.length}</small></>} label={mon.isCurrentSitting ? 'Submitted this sitting' : 'Submitted in this sitting'} />
        <Tile value={averageScore(exam, mon.submissions)} label="Average multiple choice" />
        <Tile value={violators} label="Students with violations" tone={violators ? 'warn' : ''} />
        <Tile value={flags} label="Environment flags" tone={flags ? 'warn' : ''} />
      </div>

      <div className={styles.rowGap}>
        <SittingPicker mon={mon} setParam={setParam} />
        <label className={styles.checkLabel}>
          <input type="checkbox" checked={attentionOnly} onChange={e => setAttentionOnly(e.target.checked)} />
          Needs attention only
        </label>
        <span style={{ flexGrow: 1 }} />
        <button className="btn-ghost" onClick={mon.exportCsv} disabled={mon.exporting || !mon.submissions.length}>
          <Icon.download />{mon.exporting ? ' Exporting…' : ' Export CSV'}
        </button>
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Student</th>
              <th>Score</th>
              {cols.map((q, i) => <th key={q.id} title={q.text}>Q{i + 1}</th>)}
              <th>Attention</th>
              <th>Submitted</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={cols.length + 5} className={styles.empty}>{mon.submissions.length ? 'No submissions need attention.' : 'No submissions yet.'}</td></tr>
            )}
            {rows.map(r => (
              <React.Fragment key={r.sub.student_name}>
                <tr className={r.attention ? styles.trAttention : ''}>
                  <td>
                    <div className={styles.cellName}>{r.sub.student_name}</div>
                    {r.sub.ip && <div className={styles.cellIp}>{r.sub.ip}</div>}
                  </td>
                  <td>
                    {r.score
                      ? <span className={`badge ${r.score.correct === r.score.total ? 'badge-green' : r.score.correct >= r.score.total / 2 ? 'badge-blue' : 'badge-red'}`}>{r.score.correct}/{r.score.total}</span>
                      : <span className={styles.cellMuted}>no MC</span>}
                  </td>
                  {cols.map(q => <td key={q.id}>{answerCell(q, r.sub.answers?.[q.id])}</td>)}
                  <td>
                    <div className={styles.badgeRow}>
                      {r.sub.violations > 0 && <span className="badge badge-yellow">{plural(r.sub.violations, 'violation')}</span>}
                      {r.briefExits > 0 && <span className="badge badge-blue">{plural(r.briefExits, 'brief exit')}</span>}
                      {r.env > 0 && <span className="badge badge-yellow">{plural(r.env, 'environment flag')}</span>}
                      {r.duplicate && <span className="badge badge-yellow">duplicate attempt</span>}
                      {!r.attention && r.briefExits === 0 && <span className={styles.cellMuted}>Nothing</span>}
                    </div>
                  </td>
                  <td className={styles.cellMuted}>{clock(submittedMs(r.sub))}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button className={styles.linkBtn} onClick={() => setOpen(o => (o === r.sub.student_name ? null : r.sub.student_name))}>
                      {open === r.sub.student_name ? 'Close' : 'Open'}
                    </button>
                  </td>
                </tr>
                {open === r.sub.student_name && (
                  <tr className={styles.trDetail}>
                    <td colSpan={cols.length + 5} style={{ padding: 0 }}>
                      <SubmissionDetail sub={r.sub} exam={exam} events={mon.events} />
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {exam.questions.length > MAX_QUESTION_COLUMNS && (
        <p className={styles.hint}>Showing the first {MAX_QUESTION_COLUMNS} questions in the table. Open a row for all of them.</p>
      )}
      {mon.isCurrentSitting && exam.is_active && (
        <div className={styles.footNote}>
          <span>{stillWriting ? `${plural(stillWriting, 'student')} still writing. They appear here the moment they submit.` : 'Everyone who joined has submitted.'}</span>
          <button className={styles.linkBtn} onClick={() => setTab('live')}>Watch them in Live</button>
        </div>
      )}
    </div>
  )
}

function SittingsPanel({ mon, setParam }) {
  const total = mon.sessions.length
  return (
    <div className={styles.stack}>
      <p className={styles.bodyText}>
        Each time you open the exam after students have used it, a new sitting starts, so classes never merge into one result list.
      </p>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr><th>Sitting</th><th>Started</th><th>Ended</th><th>Students</th><th>Submissions</th><th></th></tr>
          </thead>
          <tbody>
            {mon.sessions.length === 0 && <tr><td colSpan={6} className={styles.empty}>No sittings yet.</td></tr>}
            {mon.sessions.map((s, i) => (
              <tr key={s.id} className={s.id === mon.sid ? styles.trSelected : ''}>
                <td><strong>Sitting {total - i}</strong>{s.is_current && <span className={styles.badgeOpenSmall}>current</span>}</td>
                <td className={styles.cellMuted}>{when(s.started_at)}</td>
                <td className={styles.cellMuted}>{s.ended_at ? when(s.ended_at) : (s.is_current ? 'still open' : 'not recorded')}</td>
                <td>{s.student_count}</td>
                <td>{s.submission_count}</td>
                <td style={{ textAlign: 'right' }}>
                  <button className={styles.linkBtn} onClick={() => setParam({ session: s.is_current ? null : s.id, tab: 'submissions' })}>
                    {s.id === mon.sid ? 'Viewing' : 'View'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function SettingsPanel({ exam, busy, onEdit, onNewCode, onDuplicate, onArchive, onDelete }) {
  const s = exam.settings || {}
  return (
    <div className={styles.stack}>
      <section className="card">
        <p className={styles.cardLabel}>Restrictions and questions</p>
        <dl className={styles.kv}>
          <dt>Navigation away</dt><dd>{s.navigation || 'track'}</dd>
          <dt>Copy and paste</dt><dd>{s.copy_paste || 'track'}</dd>
          <dt>Keystroke logging</dt><dd>{s.log_keystrokes ? 'on' : 'off'}</dd>
          <dt>Time limit</dt><dd>{exam.time_limit > 0 ? `${exam.time_limit} min` : 'none'}</dd>
        </dl>
        <button className="btn-ghost" onClick={onEdit}>Edit exam</button>
      </section>

      <section className="card">
        <p className={styles.cardLabel}>Join code</p>
        <div className={styles.rowGap}>
          <span className={styles.codeChip}>{exam.code}</span>
          <button className="btn-ghost" onClick={onNewCode} disabled={busy}>Generate a new code</button>
        </div>
        <p className={styles.hint}>Students already in the exam keep working. Anyone joining after this needs the new code.</p>
      </section>

      <section className="card">
        <p className={styles.cardLabel}>Copy, archive, delete</p>
        <div className={styles.rowGap}>
          <button className="btn-ghost" onClick={onDuplicate} disabled={busy}>Duplicate exam</button>
          {exam.is_archived
            ? <button className="btn-ghost" onClick={() => onArchive(false)} disabled={busy}>Unarchive</button>
            : <button className="btn-ghost" onClick={() => onArchive(true)} disabled={busy}>Archive</button>}
          <button className="btn-danger" onClick={onDelete} disabled={busy}>Delete exam</button>
        </div>
        <p className={styles.hint}>Archiving closes the exam and moves it out of the list. Results stay. Deleting removes the exam and every result.</p>
      </section>
    </div>
  )
}

function QrDialog({ exam, onClose }) {
  const [src, setSrc] = useState('')
  const url = joinUrl(exam.code)
  useEffect(() => {
    let alive = true
    QRCode.toDataURL(url, { width: 400, margin: 1, color: { dark: '#1a1a1a', light: '#ffffff' } })
      .then(d => { if (alive) setSrc(d) })
      .catch(() => { if (alive) setSrc('') })
    return () => { alive = false }
  }, [url])
  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.dialog} role="dialog" aria-label="Join by QR code" onClick={e => e.stopPropagation()}>
        {src ? <img src={src} alt={`QR code for ${url}`} className={styles.qr} /> : <div className={styles.qr} />}
        <div className={styles.qrCode}>{exam.code}</div>
        <p className={styles.qrUrl}>{url}</p>
        <button className="btn-primary" onClick={onClose}>Close</button>
      </div>
    </div>
  )
}
