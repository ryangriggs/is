import fp from 'fastify-plugin'
import QRCode from 'qrcode'
import { encode } from '../../core/shortcode.js'
import { hashToken, verifyToken, generateToken } from '../../core/auth.js'
import config from '../../config.js'

async function shortlinksPlugin(fastify) {
  const db = fastify.db
  const hooks = fastify.hooks

  // Register the post:link:visit hook for tracking
  hooks.on('post:link:visit', async ({ link, req }) => {
    try {
      db.run(
        `INSERT INTO tracking(link_id, visited_at, ip, user_agent, referer) VALUES(?,?,?,?,?)`,
        link.id, Date.now(), req.ip,
        req.headers['user-agent'] || '',
        req.headers['referer'] || req.headers['referrer'] || ''
      )
    } catch (_) {}
  })

  // ----------------------------------------------------------------
  // GET / — homepage (main domain only)
  // ----------------------------------------------------------------
  fastify.get('/', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const stats = db.get(`
      SELECT
        (SELECT COUNT(*) FROM links) as totalLinks,
        (SELECT COUNT(*) FROM tracking) as totalVisits,
        (SELECT COUNT(*) FROM users) as totalUsers
    `)
    return reply.view('home.njk', { stats })
  })

  // ----------------------------------------------------------------
  // POST / — create link (main domain or l. subdomain)
  // ----------------------------------------------------------------
  fastify.post('/', {
    config: {
      rateLimit: {
        max: config.RATE_LIMIT_CREATION_MAX,
        timeWindow: config.RATE_LIMIT_CREATION_WINDOW_MS,
        keyGenerator: req => req.ip,
      }
    }
  }, async (req, reply) => {
    if (req.subdomain !== '' && req.subdomain !== 'l') return reply.callNotFound()
    const destination = (req.body?.destination || '').trim()
    if (!destination.startsWith('http://') && !destination.startsWith('https://')) {
      req.session.flash = { type: 'error', message: 'Please enter a valid URL starting with http:// or https://' }
      return reply.redirect('/')
    }
    return createAndRedirect(req, reply, destination)
  })

  // ----------------------------------------------------------------
  // GET on l.domain/* — instant create from address bar
  // ----------------------------------------------------------------
  fastify.get('/*', async (req, reply) => {
    if (req.subdomain !== 'l') return reply.callNotFound()
    const destination = req.params['*']
    if (!destination || (!destination.startsWith('http://') && !destination.startsWith('https://'))) {
      return reply.view('home.njk', {
        flash: { type: 'info', message: `Usage: l.${config.BASE_DOMAIN}/https://your-url-here` }
      })
    }
    return createAndRedirect(req, reply, destination)
  })

  // ----------------------------------------------------------------
  // GET /success
  // ----------------------------------------------------------------
  fastify.get('/success', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const { code, token } = req.query
    if (!code) return reply.redirect('/')

    const link = db.get('SELECT * FROM links WHERE code = ?', code)
    if (!link) return reply.redirect('/')

    const shortUrl = `https://${config.BASE_DOMAIN}/${code}`
    const qrDataUrl = await QRCode.toDataURL(shortUrl, { width: 200, margin: 2 })

    let manageUrl = null
    if (!link.owner_id && token && link.manage_token_hash) {
      const valid = await verifyToken(token, link.manage_token_hash)
      if (valid) {
        manageUrl = `https://${config.BASE_DOMAIN}/manage/${code}?token=${token}`
        setMgmtCookie(reply, req, code, token)
      }
    } else if (!link.owner_id && link.manage_token_hash) {
      const cookieToken = getMgmtTokenFromCookie(req, code)
      if (cookieToken) manageUrl = `https://${config.BASE_DOMAIN}/manage/${code}`
    }

    return reply.view('success.njk', { link, shortUrl, qrDataUrl, manageUrl, token })
  })

  // ----------------------------------------------------------------
  // GET /:code — redirect
  // ----------------------------------------------------------------
  fastify.get('/:code', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const { code } = req.params
    const link = db.get('SELECT * FROM links WHERE code = ?', code)

    if (!link || !link.is_active) {
      reply.code(404)
      return reply.view('errors/404.njk', {})
    }

    if (link.expires_at && link.expires_at < Date.now()) {
      reply.code(410)
      return reply.view('errors/404.njk', { message: 'This link has expired.' })
    }

    if (link.password_hash) {
      const submitted = req.query.p || req.body?.password
      if (!submitted) return reply.view('password.njk', { code, error: null })
      const valid = await verifyToken(submitted, link.password_hash)
      if (!valid) return reply.view('password.njk', { code, error: 'Incorrect password.' })
    }

    await hooks.run('post:link:visit', { link, req, log: fastify.log })
    return reply.redirect(302, link.destination)
  })

  // ----------------------------------------------------------------
  // GET /manage/:code — anonymous management
  // ----------------------------------------------------------------
  fastify.get('/manage/:code', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const { code } = req.params
    const link = db.get('SELECT * FROM links WHERE code = ?', code)

    if (!link || link.owner_id) {
      reply.code(404)
      return reply.view('errors/404.njk', {})
    }

    const token = await getValidMgmtToken(req, link)
    if (!token) {
      reply.code(403)
      return reply.view('errors/403.njk', { message: 'Invalid or missing management token.' })
    }

    const shortUrl = `https://${config.BASE_DOMAIN}/${code}`
    const qrDataUrl = await QRCode.toDataURL(shortUrl, { width: 160, margin: 2 })
    const stats = db.get(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN visited_at > ? THEN 1 ELSE 0 END) as today
      FROM tracking WHERE link_id = ?
    `, Date.now() - 86400000, link.id)

    return reply.view('manage.njk', {
      link, shortUrl, qrDataUrl, token,
      stats: { total: stats.total || 0, today: stats.today || 0 }
    })
  })

  // ----------------------------------------------------------------
  // POST /manage/:code — update or delete
  // ----------------------------------------------------------------
  fastify.post('/manage/:code', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const { code } = req.params
    const link = db.get('SELECT * FROM links WHERE code = ?', code)

    if (!link || link.owner_id) {
      reply.code(404)
      return reply.view('errors/404.njk', {})
    }

    const token = await getValidMgmtToken(req, link)
    if (!token) {
      reply.code(403)
      return reply.view('errors/403.njk', { message: 'Invalid management token.' })
    }

    const { action, destination, title } = req.body

    if (action === 'delete') {
      db.run('DELETE FROM links WHERE id = ?', link.id)
      removeMgmtCookie(reply, req, code)
      req.session.flash = { type: 'success', message: 'Link deleted.' }
      return reply.redirect('/')
    }

    if (action === 'update') {
      const dest = (destination || '').trim()
      if (!dest.startsWith('http://') && !dest.startsWith('https://')) {
        req.session.flash = { type: 'error', message: 'Invalid URL.' }
        return reply.redirect(`/manage/${code}?token=${token}`)
      }
      db.run('UPDATE links SET destination = ?, title = ? WHERE id = ?',
        dest, title || null, link.id)
      req.session.flash = { type: 'success', message: 'Link updated.' }
      return reply.redirect(`/manage/${code}?token=${token}`)
    }

    return reply.redirect(`/manage/${code}?token=${token}`)
  })

  // ----------------------------------------------------------------
  // GET /report/:code — report form
  // ----------------------------------------------------------------
  fastify.get('/report/:code', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    return reply.view('report.njk', { code: req.params.code })
  })

  // ----------------------------------------------------------------
  // POST /report/:code — submit report
  // ----------------------------------------------------------------
  fastify.post('/report/:code', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const { code } = req.params
    const link = db.get('SELECT id FROM links WHERE code = ?', code)
    if (link) {
      db.run(
        `INSERT INTO reports(link_id, reporter_ip, reason, created_at) VALUES(?,?,?,?)`,
        link.id, req.ip, (req.body?.reason || '').slice(0, 500), Date.now()
      )
    }
    req.session.flash = { type: 'success', message: 'Report submitted. Thank you.' }
    return reply.redirect('/')
  })

  // ----------------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------------

  async function createAndRedirect(req, reply, destination) {
    const isLoggedIn = !!req.session.userId
    const plainToken = isLoggedIn ? null : generateToken(32)
    const tokenHash = plainToken ? await hashToken(plainToken) : null

    const insertData = {
      type: 'url',
      destination,
      ownerId: isLoggedIn ? req.session.userId : null,
      manageTokenHash: tokenHash,
      createdAt: Date.now(),
      createdIp: req.ip,
    }

    await hooks.run('pre:link:create', { data: insertData, req })

    const link = db.transaction(() => {
      const info = db.run(
        `INSERT INTO links(type, destination, owner_id, manage_token_hash, is_active, created_at, created_ip, code)
         VALUES(?,?,?,?,1,?,?,'')`,
        insertData.type, insertData.destination, insertData.ownerId,
        insertData.manageTokenHash, insertData.createdAt, insertData.createdIp
      )
      const id = info.lastInsertRowid
      const code = encode(id)
      db.run('UPDATE links SET code = ? WHERE id = ?', code, id)
      return db.get('SELECT * FROM links WHERE id = ?', id)
    })()

    await hooks.run('post:link:create', { link, req, log: fastify.log })

    if (plainToken) {
      setMgmtCookie(reply, req, link.code, plainToken)
      return reply.redirect(`/success?code=${link.code}&token=${plainToken}`)
    }
    return reply.redirect(`/success?code=${link.code}`)
  }

  async function getValidMgmtToken(req, link) {
    const fromQuery = req.query.token
    const fromCookie = getMgmtTokenFromCookie(req, link.code)
    const candidate = fromQuery || fromCookie
    if (!candidate || !link.manage_token_hash) return null
    const valid = await verifyToken(candidate, link.manage_token_hash)
    return valid ? candidate : null
  }

  function getMgmtTokenFromCookie(req, code) {
    try {
      const raw = req.cookies?.mgmt_tokens
      if (!raw) return null
      const list = JSON.parse(decodeURIComponent(raw))
      const entry = list.find(e => e.code === code)
      return entry?.token || null
    } catch { return null }
  }

  function setMgmtCookie(reply, req, code, token) {
    try {
      const existing = getMgmtCookieList(req).filter(e => e.code !== code)
      existing.push({ code, token })
      reply.setCookie('mgmt_tokens', encodeURIComponent(JSON.stringify(existing)), {
        path: '/', httpOnly: true, sameSite: 'strict',
        maxAge: config.ANON_TOKEN_COOKIE_DAYS * 86400, secure: config.IS_PROD,
      })
    } catch {}
  }

  function removeMgmtCookie(reply, req, code) {
    try {
      const existing = getMgmtCookieList(req).filter(e => e.code !== code)
      reply.setCookie('mgmt_tokens', encodeURIComponent(JSON.stringify(existing)), {
        path: '/', httpOnly: true, sameSite: 'strict', maxAge: 365 * 86400, secure: config.IS_PROD,
      })
    } catch {}
  }

  function getMgmtCookieList(req) {
    try {
      const raw = req.cookies?.mgmt_tokens
      return raw ? JSON.parse(decodeURIComponent(raw)) : []
    } catch { return [] }
  }
}

export default fp(shortlinksPlugin, { name: 'shortlinks' })
