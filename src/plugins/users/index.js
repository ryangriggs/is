import fp from 'fastify-plugin'
import { createHash } from 'crypto'
import { hashPassword, verifyPassword, requireAuth, generateToken } from '../../core/auth.js'
import config from '../../config.js'

function sha256(s) {
  return createHash('sha256').update(s).digest('hex')
}

async function usersPlugin(fastify) {
  const db = fastify.db

  // ----------------------------------------------------------------
  // GET /register
  // ----------------------------------------------------------------
  fastify.get('/register', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    if (req.session.userId) return reply.redirect('/dashboard')
    const setting = db.get(`SELECT value FROM settings WHERE key = 'registration_open'`)
    return reply.view('register.njk', { registrationClosed: setting?.value === 'false' })
  })

  // ----------------------------------------------------------------
  // POST /register
  // ----------------------------------------------------------------
  fastify.post('/register', {
    config: {
      rateLimit: {
        max: fastify.config.RATE_LIMIT_REGISTER_MAX,
        timeWindow: fastify.config.RATE_LIMIT_REGISTER_WINDOW_MS,
        keyGenerator: req => req.ip,
      }
    }
  }, async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    if (req.session.userId) return reply.redirect('/dashboard')

    const setting = db.get(`SELECT value FROM settings WHERE key = 'registration_open'`)
    if (setting?.value === 'false') {
      return reply.view('register.njk', { registrationClosed: true })
    }

    const { username, email, password, password2 } = req.body

    if (!username || !/^[a-zA-Z0-9_-]{3,20}$/.test(username)) {
      return reply.view('register.njk', {
        error: 'Username must be 3–20 characters (letters, numbers, _ and - only).',
        prefill: { username, email },
      })
    }
    if (!password || password.length < 8) {
      return reply.view('register.njk', {
        error: 'Password must be at least 8 characters.',
        prefill: { username, email },
      })
    }
    if (password !== password2) {
      return reply.view('register.njk', {
        error: 'Passwords do not match.',
        prefill: { username, email },
      })
    }

    const existing = db.get(
      `SELECT id FROM users WHERE username = ? OR (email IS NOT NULL AND email = ?)`,
      username.toLowerCase(), email ? email.toLowerCase() : '__NO_MATCH__'
    )
    if (existing) {
      return reply.view('register.njk', {
        error: 'Username or email already taken.',
        prefill: { username, email },
      })
    }

    const passwordHash = await hashPassword(password)
    const info = db.run(
      `INSERT INTO users(username, email, password_hash, role, created_at) VALUES(?,?,?,?,?)`,
      username.toLowerCase(), email ? email.toLowerCase() : null, passwordHash, 'user', Date.now()
    )
    const user = db.get('SELECT * FROM users WHERE id = ?', info.lastInsertRowid)

    req.session.userId = user.id
    req.session.username = user.username
    req.session.role = user.role
    req.session.flash = { type: 'success', message: `Welcome, ${user.username}! Your account is ready.` }
    return reply.redirect('/dashboard')
  })

  // ----------------------------------------------------------------
  // GET /login
  // ----------------------------------------------------------------
  fastify.get('/login', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    if (req.session.userId) return reply.redirect('/dashboard')
    return reply.view('login.njk', { next: req.query.next })
  })

  // ----------------------------------------------------------------
  // POST /login
  // ----------------------------------------------------------------
  fastify.post('/login', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const { login, password, next } = req.body

    if (!login || !password) {
      return reply.view('login.njk', { error: 'Please enter your username and password.', prefill: login })
    }

    const user = db.get(
      `SELECT * FROM users WHERE username = ? OR (email IS NOT NULL AND email = ?)`,
      login.toLowerCase(), login.toLowerCase()
    )

    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return reply.view('login.njk', { error: 'Invalid username or password.', prefill: login })
    }
    if (user.is_blocked) {
      return reply.view('login.njk', { error: 'Your account has been suspended.', prefill: login })
    }

    db.run('UPDATE users SET last_login = ? WHERE id = ?', Date.now(), user.id)

    req.session.userId = user.id
    req.session.username = user.username
    req.session.role = user.role

    return reply.redirect((next && next.startsWith('/')) ? next : '/dashboard')
  })

  // ----------------------------------------------------------------
  // POST /logout
  // ----------------------------------------------------------------
  fastify.post('/logout', async (req, reply) => {
    req.session.destroy()
    return reply.redirect('/')
  })

  // ----------------------------------------------------------------
  // GET /dashboard
  // ----------------------------------------------------------------
  fastify.get('/dashboard', { preHandler: requireAuth }, async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()

    const page = Math.max(1, Number(req.query.page) || 1)
    const perPage = 20
    const offset = (page - 1) * perPage

    const userLinks = db.all(`
      SELECT l.*, COUNT(t.id) as visit_count
      FROM links l
      LEFT JOIN tracking t ON t.link_id = l.id
      WHERE l.owner_id = ?
      GROUP BY l.id
      ORDER BY l.created_at DESC
      LIMIT ? OFFSET ?
    `, req.session.userId, perPage, offset)

    const total = db.get('SELECT COUNT(*) as n FROM links WHERE owner_id = ?', req.session.userId).n

    const todayStart = new Date().setHours(0, 0, 0, 0)
    const stats = db.get(`
      SELECT
        COUNT(DISTINCT l.id) as totalLinks,
        COUNT(t.id) as totalVisits,
        SUM(CASE WHEN t.visited_at >= ? THEN 1 ELSE 0 END) as visitsToday
      FROM links l
      LEFT JOIN tracking t ON t.link_id = l.id
      WHERE l.owner_id = ?
    `, todayStart, req.session.userId)

    const dnsRecords = db.all(
      'SELECT * FROM dns_records WHERE user_id = ? ORDER BY subdomain',
      req.session.userId
    )

    return reply.view('dashboard.njk', {
      links: userLinks.map(l => ({
        ...l,
        isActive: Boolean(l.is_active),
        createdAt: l.created_at,
        visitCount: l.visit_count,
      })),
      stats: {
        totalLinks: stats.totalLinks || 0,
        totalVisits: stats.totalVisits || 0,
        visitsToday: stats.visitsToday || 0,
      },
      pagination: {
        page,
        totalPages: Math.ceil(total / perPage),
        total,
      },
      dnsRecords,
      dynApex: `${config.DYN_SUBDOMAIN}.${config.BASE_DOMAIN}`,
    })
  })

  // ----------------------------------------------------------------
  // POST /dashboard/delete/:id
  // ----------------------------------------------------------------
  fastify.post('/dashboard/delete/:id', { preHandler: requireAuth }, async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    db.run('DELETE FROM links WHERE id = ? AND owner_id = ?',
      Number(req.params.id), req.session.userId)
    req.session.flash = { type: 'success', message: 'Link deleted.' }
    return reply.redirect('/dashboard')
  })

  // ----------------------------------------------------------------
  // GET /dashboard/edit/:id
  // ----------------------------------------------------------------
  fastify.get('/dashboard/edit/:id', { preHandler: requireAuth }, async (req, reply) => {
    const link = db.get('SELECT * FROM links WHERE id = ? AND owner_id = ?', req.params.id, req.session.userId)
    if (!link) { reply.code(404); return reply.view('errors/404.njk', {}) }
    if (link.type === 'bookmark') return reply.redirect(`/b/${link.code}`)
    return reply.view('dashboard-edit.njk', { link })
  })

  fastify.post('/dashboard/edit/:id', { preHandler: requireAuth }, async (req, reply) => {
    const link = db.get('SELECT * FROM links WHERE id = ? AND owner_id = ?', req.params.id, req.session.userId)
    if (!link) { reply.code(404); return reply.view('errors/404.njk', {}) }

    const { destination, title, content } = req.body || {}

    if (link.type === 'url') {
      const dest = (destination || '').trim()
      if (!dest.startsWith('http://') && !dest.startsWith('https://')) {
        req.session.flash = { type: 'error', message: 'Invalid URL.' }
        return reply.redirect(`/dashboard/edit/${link.id}`)
      }
      db.run('UPDATE links SET destination = ?, title = ? WHERE id = ?', dest, title || null, link.id)
    } else if (link.type === 'text' || link.type === 'html') {
      if (!content?.trim()) {
        req.session.flash = { type: 'error', message: 'Content cannot be empty.' }
        return reply.redirect(`/dashboard/edit/${link.id}`)
      }
      db.run('UPDATE links SET destination = ?, title = ? WHERE id = ?', content, title || null, link.id)
    } else {
      db.run('UPDATE links SET title = ? WHERE id = ?', title || null, link.id)
    }

    req.session.flash = { type: 'success', message: 'Updated.' }
    return reply.redirect('/dashboard')
  })

  // ----------------------------------------------------------------
  // GET /tokens — manage API tokens (web UI)
  // ----------------------------------------------------------------
  fastify.get('/tokens', { preHandler: requireAuth }, async (req, reply) => {
    const tokens = db.all(
      'SELECT id, label, last_used, created_at FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC',
      req.session.userId
    )
    return reply.view('tokens.njk', { tokens })
  })

  fastify.post('/tokens', { preHandler: requireAuth }, async (req, reply) => {
    const { label = '' } = req.body || {}
    const plain = generateToken(32)
    const hash = sha256(plain)
    db.run(
      'INSERT INTO api_tokens(user_id, token_hash, label, created_at) VALUES(?,?,?,?)',
      req.session.userId, hash, label.trim() || null, Date.now()
    )
    req.session.flash = {
      type: 'key',
      label: 'API Token',
      sublabel: label.trim() ? `"${label.trim()}" — shown once, save it now` : 'Shown once, save it now',
      key: plain,
    }
    return reply.redirect('/tokens')
  })

  fastify.post('/tokens/delete/:id', { preHandler: requireAuth }, async (req, reply) => {
    db.run('DELETE FROM api_tokens WHERE id = ? AND user_id = ?', req.params.id, req.session.userId)
    req.session.flash = { type: 'success', message: 'Token revoked.' }
    return reply.redirect('/tokens')
  })

  fastify.post('/return-to-admin', { preHandler: requireAuth }, async (req, reply) => {
    if (!req.session.impersonatingAdminId) return reply.redirect('/dashboard')
    req.session.userId = req.session.impersonatingAdminId
    req.session.username = req.session.impersonatingAdminUsername
    req.session.role = req.session.impersonatingAdminRole
    delete req.session.impersonatingAdminId
    delete req.session.impersonatingAdminUsername
    delete req.session.impersonatingAdminRole
    req.session.flash = { type: 'success', message: 'Returned to admin account.' }
    return reply.redirect('/admin/users')
  })
}

export default fp(usersPlugin, { name: 'users' })
