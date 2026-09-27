import jwt from 'jsonwebtoken'

const SECRET = process.env.JWT_SECRET || 'examlock-dev-secret-change-in-prod'

export function signToken(payload) {
  return jwt.sign(payload, SECRET, { expiresIn: '30d' })
}

export function verifyToken(token) {
  return jwt.verify(token, SECRET)
}

// The server registers a lookup so a valid token is still refused once its
// teacher has been suspended or deleted, instead of working until it expires.
// Returns false, 'suspended' or 'deleted'.
let isBlocked = () => false
export function configureAuth(opts) {
  if (opts?.isBlocked) isBlocked = opts.isBlocked
}

// Resolves an Authorization header to a teacher payload, or to an error.
function authenticate(header) {
  if (!header?.startsWith('Bearer ')) return { status: 401, error: 'Not authenticated' }
  let teacher
  try { teacher = verifyToken(header.slice(7)) } catch { return { status: 401, error: 'Invalid or expired token' } }
  const blocked = isBlocked(teacher.id)
  if (blocked === 'suspended') return { status: 403, error: 'This account has been suspended. Contact your administrator.' }
  if (blocked) return { status: 401, error: 'This account no longer exists' }
  return { teacher }
}

export function requireAuth(req, res, next) {
  const r = authenticate(req.headers.authorization)
  if (r.error) return res.status(r.status).json({ error: r.error })
  req.teacher = r.teacher
  next()
}

export function requireAdmin(req, res, next) {
  const r = authenticate(req.headers.authorization)
  if (r.error) return res.status(r.status).json({ error: r.error })
  if (!r.teacher.is_admin) return res.status(403).json({ error: 'Admin access required' })
  req.teacher = r.teacher
  next()
}

// For transports without headers (Socket.IO). Teacher payload or null.
export function teacherFromToken(token) {
  return authenticate(token ? `Bearer ${token}` : '').teacher || null
}
