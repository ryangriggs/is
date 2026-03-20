import fp from 'fastify-plugin'
import { createHash } from 'crypto'
import { hashPassword, verifyPassword, requireAuth, generateToken } from '../../core/auth.js'
import config from '../../config.js'

function sha256(s) {
  return createHash('sha256').update(s).digest('hex')
}

function usernameFromEmail(email) {
  return email.split('@')[0]
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 20) || 'user'
}

function setSessionFromUser(req, user) {
  req.session.userId = user.id
  req.session.username = user.username
  req.session.role = user.role
  req.session.displayName = user.display_name || null
  req.session.email = user.email || null
  req.session.subscriptionTier = user.subscription_tier || 'free'
}

function claimPendingLink(db, req) {
  const code = req.session.pendingClaimCode
  if (code && req.session.userId) {
    try {
      db.run(
        'UPDATE links SET owner_id = ? WHERE code = ? AND owner_id IS NULL',
        req.session.userId, code
      )
    } catch (_) {}
    delete req.session.pendingClaimCode
  }
}

async function sendResetEmail(email, token) {
  const resetUrl = `https://${config.BASE_DOMAIN}/reset-password?token=${token}`

  console.log(`[resend] Attempting password reset email to: ${email}`)
  console.log(`[resend] Reset URL: ${resetUrl}`)

  if (!config.RESEND_API_KEY) {
    console.log('[resend] RESEND_API_KEY not set — skipping send (link logged above)')
    return
  }

  const from = config.RESEND_FROM_EMAIL || `noreply@${config.BASE_DOMAIN}`
  console.log(`[resend] Sending via Resend API from: ${from}`)

  let res, body
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: email,
        subject: `Reset your ${config.SITE_NAME} password`,
        html: `<p>Click the link below to reset your password. This link expires in 1 hour.</p>
               <p><a href="${resetUrl}">${resetUrl}</a></p>
               <p>If you did not request a password reset, you can ignore this email.</p>`,
      }),
    })
    body = await res.json()
  } catch (err) {
    console.error('[resend] Network error calling Resend API:', err.message)
    throw err
  }

  if (!res.ok) {
    console.error(`[resend] API error ${res.status}:`, JSON.stringify(body))
    throw new Error(`Resend API returned ${res.status}: ${body?.message || JSON.stringify(body)}`)
  }

  console.log(`[resend] Email sent successfully. id=${body?.id}`)
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

    const { email = '', display_name = '', password = '', password2 = '' } = req.body || {}
    const emailLc = email.trim().toLowerCase()

    if (!emailLc || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailLc)) {
      return reply.view('register.njk', {
        error: 'Please enter a valid email address.',
        prefill: { email, display_name },
      })
    }
    if (!password || password.length < 8) {
      return reply.view('register.njk', {
        error: 'Password must be at least 8 characters.',
        prefill: { email, display_name },
      })
    }
    if (password !== password2) {
      return reply.view('register.njk', {
        error: 'Passwords do not match.',
        prefill: { email, display_name },
      })
    }

    const existing = db.get(
      `SELECT id FROM users WHERE email = ?`,
      emailLc
    )
    if (existing) {
      return reply.view('register.njk', {
        error: 'An account with that email already exists.',
        prefill: { email, display_name },
      })
    }

    // Auto-generate unique username from email
    let baseUsername = usernameFromEmail(emailLc)
    let username = baseUsername
    let suffix = 1
    while (db.get('SELECT id FROM users WHERE username = ?', username)) {
      username = baseUsername + suffix++
    }

    const passwordHash = await hashPassword(password)
    const info = db.run(
      `INSERT INTO users(username, email, display_name, password_hash, role, created_at) VALUES(?,?,?,?,?,?)`,
      username, emailLc, display_name.trim() || null, passwordHash, 'user', Date.now()
    )
    const user = db.get('SELECT * FROM users WHERE id = ?', info.lastInsertRowid)

    setSessionFromUser(req, user)
    claimPendingLink(db, req)

    req.session.flash = { type: 'success', message: `Welcome! Your account is ready.` }
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
    const { login = '', password = '', next } = req.body || {}
    const loginLc = login.trim().toLowerCase()

    if (!loginLc || !password) {
      return reply.view('login.njk', { error: 'Please enter your email and password.', prefill: login })
    }

    const user = db.get(
      `SELECT * FROM users WHERE email = ? OR username = ?`,
      loginLc, loginLc
    )

    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return reply.view('login.njk', { error: 'Invalid email or password.', prefill: login })
    }
    if (user.is_blocked) {
      return reply.view('login.njk', { error: 'Your account has been suspended.', prefill: login })
    }

    db.run('UPDATE users SET last_login = ? WHERE id = ?', Date.now(), user.id)

    setSessionFromUser(req, user)
    claimPendingLink(db, req)

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
  // GET /forgot-password
  // ----------------------------------------------------------------
  fastify.get('/forgot-password', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    if (req.session.userId) return reply.redirect('/dashboard')
    return reply.view('forgot-password.njk', {})
  })

  // ----------------------------------------------------------------
  // POST /forgot-password
  // ----------------------------------------------------------------
  fastify.post('/forgot-password', {
    config: {
      rateLimit: { max: 5, timeWindow: 600000, keyGenerator: req => req.ip }
    }
  }, async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const { email = '' } = req.body || {}
    const emailLc = email.trim().toLowerCase()

    // Always show success to prevent email enumeration
    const successView = () => reply.view('forgot-password.njk', {
      success: 'If an account with that email exists, a reset link has been sent.'
    })

    if (!emailLc) return successView()

    const user = db.get('SELECT * FROM users WHERE email = ?', emailLc)
    if (!user) return successView()

    const token = generateToken(40)
    const tokenHash = sha256(token)
    const expires = Date.now() + 60 * 60 * 1000 // 1 hour

    db.run(
      'UPDATE users SET reset_token_hash = ?, reset_token_expires = ? WHERE id = ?',
      tokenHash, expires, user.id
    )

    try {
      await sendResetEmail(emailLc, token)
    } catch (err) {
      console.error('[forgot-password] Failed to send email:', err.message)
    }

    return successView()
  })

  // ----------------------------------------------------------------
  // GET /reset-password
  // ----------------------------------------------------------------
  fastify.get('/reset-password', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const { token } = req.query
    if (!token) return reply.redirect('/forgot-password')
    const tokenHash = sha256(token)
    const user = db.get(
      'SELECT * FROM users WHERE reset_token_hash = ? AND reset_token_expires > ?',
      tokenHash, Date.now()
    )
    if (!user) {
      return reply.view('reset-password.njk', { error: 'This reset link is invalid or has expired.' })
    }
    return reply.view('reset-password.njk', { token })
  })

  // ----------------------------------------------------------------
  // POST /reset-password
  // ----------------------------------------------------------------
  fastify.post('/reset-password', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const { token = '', password = '', password2 = '' } = req.body || {}

    const tokenHash = sha256(token)
    const user = db.get(
      'SELECT * FROM users WHERE reset_token_hash = ? AND reset_token_expires > ?',
      tokenHash, Date.now()
    )
    if (!user) {
      return reply.view('reset-password.njk', { error: 'This reset link is invalid or has expired.' })
    }
    if (!password || password.length < 8) {
      return reply.view('reset-password.njk', { token, error: 'Password must be at least 8 characters.' })
    }
    if (password !== password2) {
      return reply.view('reset-password.njk', { token, error: 'Passwords do not match.' })
    }

    const hash = await hashPassword(password)
    db.run(
      'UPDATE users SET password_hash = ?, reset_token_hash = NULL, reset_token_expires = NULL WHERE id = ?',
      hash, user.id
    )

    setSessionFromUser(req, user)
    req.session.flash = { type: 'success', message: 'Password updated. You are now logged in.' }
    return reply.redirect('/dashboard')
  })

  // ----------------------------------------------------------------
  // GET /profile
  // ----------------------------------------------------------------
  fastify.get('/profile', { preHandler: requireAuth }, async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const user = db.get('SELECT * FROM users WHERE id = ?', req.session.userId)
    return reply.view('profile.njk', { profileUser: user })
  })

  // ----------------------------------------------------------------
  // POST /profile
  // ----------------------------------------------------------------
  fastify.post('/profile', { preHandler: requireAuth }, async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const user = db.get('SELECT * FROM users WHERE id = ?', req.session.userId)
    const { display_name = '', email = '', current_password = '', new_password = '', new_password2 = '' } = req.body || {}

    const emailLc = email.trim().toLowerCase()
    let error = null

    // Validate email if changed
    if (emailLc && emailLc !== (user.email || '')) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailLc)) {
        error = 'Invalid email address.'
      } else {
        const taken = db.get('SELECT id FROM users WHERE email = ? AND id != ?', emailLc, user.id)
        if (taken) error = 'That email is already in use.'
      }
    }

    // Validate new password if provided
    if (!error && new_password) {
      if (!current_password) {
        error = 'Enter your current password to set a new one.'
      } else if (!(await verifyPassword(current_password, user.password_hash))) {
        error = 'Current password is incorrect.'
      } else if (new_password.length < 8) {
        error = 'New password must be at least 8 characters.'
      } else if (new_password !== new_password2) {
        error = 'New passwords do not match.'
      }
    }

    if (error) {
      return reply.view('profile.njk', { profileUser: user, error })
    }

    // Apply changes
    const newDisplayName = display_name.trim() || null
    const newEmail = emailLc || user.email || null

    if (new_password) {
      const newHash = await hashPassword(new_password)
      db.run(
        'UPDATE users SET display_name = ?, email = ?, password_hash = ? WHERE id = ?',
        newDisplayName, newEmail, newHash, user.id
      )
    } else {
      db.run(
        'UPDATE users SET display_name = ?, email = ? WHERE id = ?',
        newDisplayName, newEmail, user.id
      )
    }

    // Update session
    req.session.displayName = newDisplayName
    req.session.email = newEmail

    req.session.flash = { type: 'success', message: 'Profile updated.' }
    return reply.redirect('/profile')
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
  // GET /tokens — manage API tokens
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

  // ----------------------------------------------------------------
  // POST /return-to-admin
  // ----------------------------------------------------------------
  fastify.post('/return-to-admin', { preHandler: requireAuth }, async (req, reply) => {
    if (!req.session.impersonatingAdminId) return reply.redirect('/dashboard')
    req.session.userId = req.session.impersonatingAdminId
    req.session.username = req.session.impersonatingAdminUsername
    req.session.role = req.session.impersonatingAdminRole
    req.session.displayName = req.session.impersonatingAdminDisplayName || null
    req.session.email = req.session.impersonatingAdminEmail || null
    delete req.session.impersonatingAdminId
    delete req.session.impersonatingAdminUsername
    delete req.session.impersonatingAdminRole
    delete req.session.impersonatingAdminDisplayName
    delete req.session.impersonatingAdminEmail
    req.session.flash = { type: 'success', message: 'Returned to admin account.' }
    return reply.redirect('/admin/users')
  })
}

export default fp(usersPlugin, { name: 'users' })
