import fp from 'fastify-plugin'
import { hashPassword, verifyPassword, requireAuth } from '../../core/auth.js'

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
}

export default fp(usersPlugin, { name: 'users' })
