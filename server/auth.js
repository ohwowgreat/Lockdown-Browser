import jwt from 'jsonwebtoken'

const SECRET = process.env.JWT_SECRET || 'examlock-dev-secret-change-in-prod'

export function signToken(payload) {
  return jwt.sign(payload, SECRET, { expiresIn: '30d' })
}

export function verifyToken(token) {
  return jwt.verify(token, SECRET)
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Not authenticated' })
  try {
    req.teacher = verifyToken(header.slice(7))
    next()
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' })
  }
}

export function requireAdmin(req, res, next) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Not authenticated' })
  try {
    const payload = verifyToken(header.slice(7))
    if (!payload.is_admin) return res.status(403).json({ error: 'Admin access required' })
    req.teacher = payload
    next()
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' })
  }
}
