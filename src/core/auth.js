import bcrypt from 'bcryptjs'
import { createHmac } from 'crypto'
import { nanoid } from 'nanoid'
import config from '../config.js'

// --- Password / token helpers ---

export async function hashPassword(plain) {
  return bcrypt.hash(plain, config.BCRYPT_ROUNDS)
}

export async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash)
}

export async function hashToken(plain) {
  return bcrypt.hash(plain, config.BCRYPT_ROUNDS)
}

export async function verifyToken(plain, hash) {
  return bcrypt.compare(plain, hash)
}

export function generateToken(size = 32) {
  return nanoid(size)
}

// Keyed HMAC hash — deterministic (allows DB lookup), but requires the server
// secret to compute, so a stolen DB alone cannot be used to forge tokens.
// Use this for API tokens and password-reset tokens (not for passwords — use hashPassword).
export function hashTokenFast(plain) {
  return createHmac('sha256', config.SESSION_SECRET).update(plain).digest('hex')
}

// --- Session helpers (shared across auth plugins) ---

export function setSessionFromUser(req, user) {
  req.session.userId = user.id
  req.session.username = user.username
  req.session.role = user.role
  req.session.displayName = user.display_name || null
  req.session.email = user.email || null
  req.session.subscriptionTier = user.subscription_tier || 'free'
}

export function claimPendingLink(db, req) {
  const code = req.session.pendingClaimCode
  if (code && req.session.userId) {
    try {
      db.run('UPDATE links SET owner_id = ? WHERE code = ? AND owner_id IS NULL', req.session.userId, code)
    } catch (_) {}
    delete req.session.pendingClaimCode
  }
}

// --- Route guards (used as preHandler in route options) ---

export async function requireAuth(req, reply) {
  if (!req.session.userId) {
    const next = encodeURIComponent(req.url)
    return reply.redirect(`/login?next=${next}`)
  }
}

export async function requireAdmin(req, reply) {
  if (!req.session.userId) {
    return reply.redirect('/login')
  }
  if (req.session.role !== 'admin') {
    reply.code(403)
    return reply.view('errors/403.njk', {})
  }
}

// --- SQLite-backed session store for @fastify/session ---
// Accepts the raw better-sqlite3 connection to avoid circular deps with Drizzle.

// Session store backed by the DB wrapper returned from db/index.js
export class SqliteSessionStore {
  #db

  constructor(db) {
    this.#db = db
    // Clean up expired sessions every 30 minutes
    setInterval(() => this.#cleanup(), 30 * 60 * 1000).unref()
  }

  get(sid, cb) {
    try {
      const row = this.#db.get('SELECT data, expires_at FROM sessions WHERE id = ?', sid)
      if (!row || row.expires_at < Date.now()) return cb(null, null)
      cb(null, JSON.parse(row.data))
    } catch (err) {
      cb(err)
    }
  }

  set(sid, session, cb) {
    try {
      const data = JSON.stringify(session)
      const expiresAt = session.cookie?.expires
        ? new Date(session.cookie.expires).getTime()
        : Date.now() + 7 * 24 * 60 * 60 * 1000
      this.#db.run(
        `INSERT INTO sessions(id, data, expires_at, created_at) VALUES(?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET data=excluded.data, expires_at=excluded.expires_at`,
        sid, data, expiresAt, Date.now()
      )
      cb(null)
    } catch (err) {
      cb(err)
    }
  }

  destroy(sid, cb) {
    try {
      this.#db.run('DELETE FROM sessions WHERE id = ?', sid)
      cb(null)
    } catch (err) {
      cb(err)
    }
  }

  #cleanup() {
    try {
      this.#db.run('DELETE FROM sessions WHERE expires_at < ?', Date.now())
    } catch (_) {}
  }
}
