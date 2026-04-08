import fp from 'fastify-plugin'
import path from 'path'
import { readFile, writeFile, unlink } from 'fs/promises'
import { hashPassword, verifyPassword, requireAuth, generateToken, hashTokenFast, setSessionFromUser, claimPendingLink } from '../../core/auth.js'
import config from '../../config.js'
import { getAdForOwner } from '../../core/ads.js'

const PASTE_DIR = path.join(process.cwd(), 'data', 'pastes')

function usernameFromEmail(email) {
  return email.split('@')[0]
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 20) || 'user'
}


async function sendEmail({ to, subject, html }) {
  console.log(`[resend] ---- sendEmail ----`)
  console.log(`[resend]   to:      ${to}`)
  console.log(`[resend]   subject: ${subject}`)
  console.log(`[resend]   RESEND_API_KEY set: ${!!config.RESEND_API_KEY} (length: ${config.RESEND_API_KEY?.length ?? 0})`)

  if (!config.RESEND_API_KEY) {
    console.log(`[resend]   No API key — email not sent (dev mode)`)
    return { ok: false, devMode: true }
  }

  const from = config.RESEND_FROM_EMAIL || `noreply@${config.BASE_DOMAIN}`
  console.log(`[resend]   from: ${from}`)

  const payload = { from, to, subject, html }
  console.log(`[resend]   payload: ${JSON.stringify({ from, to, subject })}`)

  let res, body, rawText
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
    rawText = await res.text()
    try { body = JSON.parse(rawText) } catch { body = rawText }
  } catch (err) {
    console.error(`[resend]   Network error: ${err.message}`)
    throw err
  }

  console.log(`[resend]   HTTP status: ${res.status}`)
  console.log(`[resend]   Response: ${JSON.stringify(body)}`)

  if (!res.ok) {
    const msg = body?.message || body?.error || rawText
    console.error(`[resend]   FAILED — ${res.status}: ${msg}`)
    throw new Error(`Resend API ${res.status}: ${msg}`)
  }

  console.log(`[resend]   OK — email id: ${body?.id}`)
  return { ok: true, id: body?.id }
}

async function sendVerificationEmail(email, token) {
  const verifyUrl = `https://${config.BASE_DOMAIN}/verify-email?token=${token}`
  console.log(`[resend] sendVerificationEmail → ${email}`)

  if (!config.RESEND_API_KEY) {
    console.log(`[resend] RESEND_API_KEY not set — verify URL: ${verifyUrl}`)
    return { devUrl: verifyUrl }
  }

  await sendEmail({
    to: email,
    subject: `Verify your ${config.SITE_NAME} email address`,
    html: `<p>Thanks for signing up! Click the link below to verify your email address. This link expires in 24 hours.</p>
           <p><a href="${verifyUrl}">${verifyUrl}</a></p>
           <p>If you did not create an account, you can ignore this email.</p>`,
  })
  return {}
}

async function sendResetEmail(email, token, { googleOnly = false } = {}) {
  const resetUrl = `https://${config.BASE_DOMAIN}/reset-password?token=${token}`
  console.log(`[resend] sendResetEmail → ${email} (googleOnly: ${googleOnly})`)

  if (!config.RESEND_API_KEY) {
    console.log(`[resend] RESEND_API_KEY not set — reset URL: ${resetUrl}`)
    return
  }

  await sendEmail({
    to: email,
    subject: `Reset your ${config.SITE_NAME} password`,
    html: googleOnly
      ? `<p>We received a password reset request for this account.</p>
         <p>This account was created using <strong>Google Sign-In</strong>. You can continue using Google to log in, or click the link below to set a password as an alternative login method. This link expires in 1 hour.</p>
         <p><a href="${resetUrl}">${resetUrl}</a></p>
         <p>If you did not request this, you can safely ignore this email.</p>`
      : `<p>Click the link below to reset your password. This link expires in 1 hour.</p>
         <p><a href="${resetUrl}">${resetUrl}</a></p>
         <p>If you did not request a password reset, you can ignore this email.</p>`,
  })
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
    const ad = getAdForOwner(null, db)
    return reply.view('register.njk', { registrationClosed: setting?.value === 'false', ad })
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

    // Generate verification token
    const verifyToken = generateToken(40)
    const verifyTokenHash = hashTokenFast(verifyToken)
    const verifyExpires = Date.now() + 24 * 60 * 60 * 1000 // 24 hours
    db.run(
      'UPDATE users SET email_verify_token_hash = ?, email_verify_token_expires = ? WHERE id = ?',
      verifyTokenHash, verifyExpires, info.lastInsertRowid
    )

    let devUrl = null
    try {
      const result = await sendVerificationEmail(emailLc, verifyToken)
      devUrl = result?.devUrl || null
    } catch (err) {
      console.error('[register] Failed to send verification email:', err.message)
    }

    // Store pending claim in session without logging user in
    req.session.pendingVerifyEmail = emailLc

    return reply.view('verify-email-sent.njk', { email: emailLc, devUrl })
  })

  // ----------------------------------------------------------------
  // GET /login
  // ----------------------------------------------------------------
  fastify.get('/login', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    if (req.session.userId) return reply.redirect('/dashboard')
    const ad = getAdForOwner(null, db)
    return reply.view('login.njk', { next: req.query.next, ad })
  })

  // ----------------------------------------------------------------
  // POST /login
  // ----------------------------------------------------------------
  fastify.post('/login', {
    config: {
      rateLimit: {
        max: fastify.config.RATE_LIMIT_LOGIN_MAX,
        timeWindow: fastify.config.RATE_LIMIT_LOGIN_WINDOW_MS,
        keyGenerator: req => req.ip,
      }
    }
  }, async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const { login = '', password = '', next } = req.body || {}
    const loginLc = login.trim().toLowerCase()

    const ad = getAdForOwner(null, db)
    if (!loginLc || !password) {
      return reply.view('login.njk', { error: 'Please enter your email and password.', prefill: login, ad })
    }

    const user = db.get(
      `SELECT * FROM users WHERE email = ? OR username = ?`,
      loginLc, loginLc
    )

    if (!user || !(await verifyPassword(password, user.password_hash))) {
      // Special case: account exists but has no password (Google-only)
      if (user && !user.password_hash && user.google_id) {
        return reply.view('login.njk', { googleOnlyEmail: user.email, prefill: login, ad })
      }
      return reply.view('login.njk', { error: 'Invalid email or password.', prefill: login, ad })
    }
    if (user.is_blocked) {
      return reply.view('login.njk', { error: 'Your account has been suspended.', prefill: login, ad })
    }
    if (!user.email_verified) {
      return reply.view('login.njk', { unverifiedEmail: user.email, prefill: login, ad })
    }

    db.run('UPDATE users SET last_login = ? WHERE id = ?', Date.now(), user.id)

    // TODO: 2FA check point — if user has 2FA enabled, set req.session.pending2faUserId
    //       and redirect to /2fa/verify instead of completing login here.

    const pendingCode = req.session.pendingClaimCode || null
    await new Promise((res, rej) => req.session.regenerate(e => e ? rej(e) : res()))
    if (pendingCode) req.session.pendingClaimCode = pendingCode
    setSessionFromUser(req, user)
    claimPendingLink(db, req)

    // Reject open-redirect tricks like //attacker.com or /\attacker.com
    const safeNext = (next && /^\/[^/\\]/.test(next)) ? next : '/dashboard'
    return reply.redirect(safeNext)
  })

  // ----------------------------------------------------------------
  // POST /logout
  // ----------------------------------------------------------------
  fastify.post('/logout', async (req, reply) => {
    req.session.destroy()
    return reply.redirect('/')
  })

  // ----------------------------------------------------------------
  // GET /verify-email  — confirm email address via token link
  // ----------------------------------------------------------------
  fastify.get('/verify-email', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const { token } = req.query
    if (!token) return reply.redirect('/login')

    const tokenHash = hashTokenFast(token)
    const user = db.get(
      'SELECT * FROM users WHERE email_verify_token_hash = ? AND email_verify_token_expires > ?',
      tokenHash, Date.now()
    )

    if (!user) {
      return reply.view('verify-email.njk', { error: 'This verification link is invalid or has expired.' })
    }

    // Mark verified, clear token
    db.run(
      'UPDATE users SET email_verified = 1, email_verify_token_hash = NULL, email_verify_token_expires = NULL WHERE id = ?',
      user.id
    )

    // Log the user in
    const pendingCode = req.session.pendingClaimCode || null
    await new Promise((res, rej) => req.session.regenerate(e => e ? rej(e) : res()))
    if (pendingCode) req.session.pendingClaimCode = pendingCode
    setSessionFromUser(req, user)
    claimPendingLink(db, req)

    req.session.flash = { type: 'success', message: 'Email verified! Welcome to your account.' }
    return reply.redirect('/dashboard')
  })

  // ----------------------------------------------------------------
  // GET /resend-verification — form to request a new verification email
  // ----------------------------------------------------------------
  fastify.get('/resend-verification', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    if (req.session.userId) return reply.redirect('/dashboard')
    const email = req.session.pendingVerifyEmail || ''
    return reply.view('verify-email-sent.njk', { email, resendForm: true })
  })

  // ----------------------------------------------------------------
  // POST /resend-verification
  // ----------------------------------------------------------------
  fastify.post('/resend-verification', {
    config: {
      rateLimit: { max: 5, timeWindow: 600000, keyGenerator: req => req.ip }
    }
  }, async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const { email = '' } = req.body || {}
    const emailLc = email.trim().toLowerCase()

    // Always show generic success to prevent enumeration
    const success = (devUrl = null) => reply.view('verify-email-sent.njk', {
      email: emailLc,
      resent: true,
      devUrl,
    })

    if (!emailLc) return success()

    const user = db.get('SELECT * FROM users WHERE email = ? AND email_verified = 0', emailLc)
    if (!user) return success()

    const verifyToken = generateToken(40)
    const verifyTokenHash = hashTokenFast(verifyToken)
    const verifyExpires = Date.now() + 24 * 60 * 60 * 1000

    db.run(
      'UPDATE users SET email_verify_token_hash = ?, email_verify_token_expires = ? WHERE id = ?',
      verifyTokenHash, verifyExpires, user.id
    )

    let devUrl = null
    try {
      const result = await sendVerificationEmail(emailLc, verifyToken)
      devUrl = result?.devUrl || null
    } catch (err) {
      console.error('[resend-verification] Failed to send email:', err.message)
    }

    req.session.pendingVerifyEmail = emailLc
    return success(devUrl)
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
    const tokenHash = hashTokenFast(token)
    const expires = Date.now() + 60 * 60 * 1000 // 1 hour

    db.run(
      'UPDATE users SET reset_token_hash = ?, reset_token_expires = ? WHERE id = ?',
      tokenHash, expires, user.id
    )

    try {
      await sendResetEmail(emailLc, token, { googleOnly: !user.password_hash && !!user.google_id })
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
    const tokenHash = hashTokenFast(token)
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

    const tokenHash = hashTokenFast(token)
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

    await new Promise((res, rej) => req.session.regenerate(e => e ? rej(e) : res()))
    setSessionFromUser(req, user)
    req.session.flash = { type: 'success', message: 'Password set. You are now logged in.' }
    return reply.redirect('/dashboard')
  })

  // ----------------------------------------------------------------
  // GET /profile
  // ----------------------------------------------------------------
  fastify.get('/profile', { preHandler: requireAuth }, async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const user = db.get('SELECT * FROM users WHERE id = ?', req.session.userId)
    const tierInfo = db.get('SELECT * FROM account_tiers WHERE name = ?', user?.subscription_tier || 'free')
    const ad = getAdForOwner(req.session.userId, db)
    return reply.view('profile.njk', { profileUser: user, tierInfo, ad })
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
      if (user.password_hash) {
        // Existing password users must confirm current password
        if (!current_password) {
          error = 'Enter your current password to set a new one.'
        } else if (!(await verifyPassword(current_password, user.password_hash))) {
          error = 'Current password is incorrect.'
        }
      }
      if (!error && new_password.length < 8) {
        error = 'New password must be at least 8 characters.'
      } else if (!error && new_password !== new_password2) {
        error = 'New passwords do not match.'
      }
    }

    if (error) {
      const tierInfo = db.get('SELECT * FROM account_tiers WHERE name = ?', user?.subscription_tier || 'free')
      return reply.view('profile.njk', { profileUser: user, tierInfo, error })
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
  // POST /profile/unlink-google
  // ----------------------------------------------------------------
  fastify.post('/profile/unlink-google', { preHandler: requireAuth }, async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const user = db.get('SELECT * FROM users WHERE id = ?', req.session.userId)
    if (!user?.google_id) {
      req.session.flash = { type: 'error', message: 'No Google account is linked.' }
      return reply.redirect('/profile')
    }
    if (!user.password_hash) {
      req.session.flash = { type: 'error', message: 'Set a password before unlinking Google, otherwise you will be locked out of your account.' }
      return reply.redirect('/profile')
    }
    db.run('UPDATE users SET google_id = NULL WHERE id = ?', user.id)
    req.session.flash = { type: 'success', message: 'Google account unlinked. Use your password to log in.' }
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
    const SORTABLE = { created_at: 'l.created_at', code: 'l.code', type: 'l.type', visit_count: 'visit_count', is_active: 'l.is_active' }
    const sort = SORTABLE[req.query.sort] ? req.query.sort : 'created_at'
    const sortCol = SORTABLE[sort]
    const dir = req.query.dir === 'asc' ? 'ASC' : 'DESC'

    const VALID_TYPES = new Set(['url', 'text', 'html', 'image', 'bookmark'])
    const typeFilter = VALID_TYPES.has(req.query.type) ? req.query.type : null

    const baseWhere = typeFilter ? 'l.owner_id = ? AND l.type = ?' : 'l.owner_id = ?'
    const baseParams = typeFilter ? [req.session.userId, typeFilter] : [req.session.userId]

    const userLinks = db.all(`
      SELECT l.*, COUNT(t.id) as visit_count
      FROM links l
      LEFT JOIN tracking t ON t.link_id = l.id
      WHERE ${baseWhere}
      GROUP BY l.id
      ORDER BY ${sortCol} ${dir}
      LIMIT ? OFFSET ?
    `, ...baseParams, perPage, offset)

    const total = db.get(
      `SELECT COUNT(*) as n FROM links WHERE ${baseWhere.replace(/l\./g, '')}`,
      ...baseParams
    ).n

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

    const ad = getAdForOwner(req.session.userId, db)
    return reply.view('dashboard.njk', {
      ad,
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
      sort, dir,
      typeFilter: typeFilter || 'all',
    })
  })

  // ----------------------------------------------------------------
  // POST /dashboard/delete/:id
  // ----------------------------------------------------------------
  fastify.post('/dashboard/delete/:id', { preHandler: requireAuth }, async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const link = db.get('SELECT type, destination FROM links WHERE id = ? AND owner_id = ?',
      Number(req.params.id), req.session.userId)
    db.run('DELETE FROM links WHERE id = ? AND owner_id = ?',
      Number(req.params.id), req.session.userId)
    if (link && (link.type === 'text' || link.type === 'html')) {
      unlink(path.join(PASTE_DIR, link.destination)).catch(() => {})
    }
    req.session.flash = { type: 'success', message: 'Link deleted.' }
    const back = req.body?._back
    const safeback = (back && /^\?[a-zA-Z0-9=&%_-]*$/.test(back)) ? back : ''
    return reply.redirect('/dashboard' + safeback)
  })

  // ----------------------------------------------------------------
  // GET /dashboard/edit/:id
  // ----------------------------------------------------------------
  fastify.get('/dashboard/edit/:id', { preHandler: requireAuth }, async (req, reply) => {
    const link = db.get('SELECT * FROM links WHERE id = ? AND owner_id = ?', req.params.id, req.session.userId)
    if (!link) { reply.code(404); return reply.view('errors/404.njk', {}) }
    if (link.type === 'bookmark') return reply.redirect(`/b/${link.code}`)
    let content = null
    if ((link.type === 'text' || link.type === 'html') && !link.is_encrypted) {
      content = await readFile(path.join(PASTE_DIR, link.destination), 'utf8').catch(() => '')
    }
    return reply.view('dashboard-edit.njk', { link, content })
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
      if (link.is_encrypted) {
        // Cannot edit encrypted content server-side; only title is editable
        db.run('UPDATE links SET title = ? WHERE id = ?', title || null, link.id)
      } else {
        if (!content?.trim()) {
          req.session.flash = { type: 'error', message: 'Content cannot be empty.' }
          return reply.redirect(`/dashboard/edit/${link.id}`)
        }
        await writeFile(path.join(PASTE_DIR, link.destination), content, 'utf8')
        const byteSize = Buffer.byteLength(content, 'utf8')
        db.run('UPDATE links SET title = ?, file_size = ? WHERE id = ?', title || null, byteSize, link.id)
      }
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
    const ad = getAdForOwner(req.session.userId, db)
    return reply.view('tokens.njk', { tokens, ad })
  })

  fastify.post('/tokens', { preHandler: requireAuth }, async (req, reply) => {
    const { label = '' } = req.body || {}
    const plain = generateToken(32)
    const hash = hashTokenFast(plain)
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
    const impersonatedUserId = req.session.userId
    const adminId = req.session.impersonatingAdminId
    req.session.userId = adminId
    req.session.username = req.session.impersonatingAdminUsername
    req.session.role = req.session.impersonatingAdminRole
    req.session.displayName = req.session.impersonatingAdminDisplayName || null
    req.session.email = req.session.impersonatingAdminEmail || null
    delete req.session.impersonatingAdminId
    delete req.session.impersonatingAdminUsername
    delete req.session.impersonatingAdminRole
    delete req.session.impersonatingAdminDisplayName
    delete req.session.impersonatingAdminEmail
    try {
      fastify.db.run(
        'INSERT INTO audit_log(action, admin_id, target_user_id, ip, created_at) VALUES(?,?,?,?,?)',
        'impersonate_end', adminId, impersonatedUserId, req.ip, Date.now()
      )
    } catch (_) {}
    req.session.flash = { type: 'success', message: 'Returned to admin account.' }
    return reply.redirect('/admin/users')
  })

  // ----------------------------------------------------------------
  // GET /pricing — public pricing/subscription page
  // ----------------------------------------------------------------
  fastify.get('/pricing', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const tiers = db.all("SELECT * FROM account_tiers WHERE is_enabled = 1 AND name != 'anonymous' ORDER BY price ASC")
    let currentTier = req.session.subscriptionTier || (req.session.userId ? 'free' : null)
    let subscriptionInterval = null
    if (req.session.userId) {
      // Always read from DB — session may be stale after Stripe webhook updates the tier
      const freshUser = db.get('SELECT subscription_tier, stripe_subscription_interval FROM users WHERE id = ?', req.session.userId)
      if (freshUser) {
        currentTier = freshUser.subscription_tier || 'free'
        req.session.subscriptionTier = currentTier  // keep session in sync
        subscriptionInterval = freshUser.stripe_subscription_interval || null
      }
    }
    const ad = getAdForOwner(req.session.userId || null, db)
    return reply.view('pricing.njk', { tiers, currentTier, subscriptionInterval, ad })
  })

  // POST /pricing/change — user requests a tier change (manual/admin-side flow for now)
  fastify.post('/pricing/change', { preHandler: requireAuth }, async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const { tier } = req.body || {}
    const target = db.get('SELECT * FROM account_tiers WHERE name = ? AND is_enabled = 1', tier)
    if (!target) {
      req.session.flash = { type: 'error', message: 'Invalid tier.' }
      return reply.redirect('/pricing')
    }
    if (target.price > 0) {
      // Paid tier — payment not yet integrated; show info
      req.session.flash = { type: 'info', message: 'Paid subscriptions are not yet available. Check back soon.' }
      return reply.redirect('/pricing')
    }
    // Free tier — allow downgrade immediately
    db.run('UPDATE users SET subscription_tier = ? WHERE id = ?', target.name, req.session.userId)
    req.session.subscriptionTier = target.name
    req.session.flash = { type: 'success', message: `Switched to ${target.label || target.name} plan.` }
    return reply.redirect('/pricing')
  })

  // ----------------------------------------------------------------
  // GET /advertise — advertising info page (placeholder)
  // ----------------------------------------------------------------
  fastify.get('/advertise', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    return reply.view('advertise.njk', {})
  })
}

export default fp(usersPlugin, { name: 'users' })
