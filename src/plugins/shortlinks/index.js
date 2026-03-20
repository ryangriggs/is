import fp from 'fastify-plugin'
import QRCode from 'qrcode'
import { normalizeCode } from '../../core/shortcode.js'
import { createLink } from '../../core/links.js'
import { verifyToken } from '../../core/auth.js'
import config from '../../config.js'

async function shortlinksPlugin(fastify) {
  const db = fastify.db
  const hooks = fastify.hooks

  // Track visits
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
  // GET / — homepage
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
  // POST / — create URL shortlink (main domain or l. subdomain)
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
    return createUrlAndRedirect(req, reply, destination)
  })

  // ----------------------------------------------------------------
  // GET /l/* — quick-create from address bar (subdomain or path)
  // ----------------------------------------------------------------
  fastify.get('/l/*', async (req, reply) => {
    const destination = req.params['*']
    if (!destination || (!destination.startsWith('http://') && !destination.startsWith('https://'))) {
      return reply.view('home.njk', {
        flash: { type: 'info', message: `Usage: l.${config.BASE_DOMAIN}/https://your-url-here` }
      })
    }
    return createUrlAndRedirect(req, reply, destination)
  })

  // Also handle l. subdomain via wildcard
  fastify.get('/*', async (req, reply) => {
    if (req.subdomain !== 'l') return reply.callNotFound()
    const destination = req.params['*']
    if (!destination || (!destination.startsWith('http://') && !destination.startsWith('https://'))) {
      return reply.view('home.njk', {
        flash: { type: 'info', message: `Usage: l.${config.BASE_DOMAIN}/https://your-url-here` }
      })
    }
    return createUrlAndRedirect(req, reply, destination)
  })

  // ----------------------------------------------------------------
  // GET /success
  // ----------------------------------------------------------------
  fastify.get('/success', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const { code, token } = req.query
    if (!code) return reply.redirect('/')

    const link = db.get('SELECT * FROM links WHERE code = ?', normalizeCode(code))
    if (!link) return reply.redirect('/')

    const shortUrl = `https://${config.BASE_DOMAIN}/${link.code}`
    const qrDataUrl = await QRCode.toDataURL(shortUrl, { width: 200, margin: 2 })

    let manageUrl = null
    if (!link.owner_id && token && link.manage_token_hash) {
      const valid = await verifyToken(token, link.manage_token_hash)
      if (valid) {
        manageUrl = `https://${config.BASE_DOMAIN}/manage/${link.code}?token=${token}`
        setMgmtCookie(reply, req, link.code, token)
      }
    } else if (!link.owner_id && link.manage_token_hash) {
      const cookieToken = getMgmtTokenFromCookie(req, link.code)
      if (cookieToken) manageUrl = `https://${config.BASE_DOMAIN}/manage/${link.code}`
    }

    return reply.view('success.njk', { link, shortUrl, qrDataUrl, manageUrl, token })
  })

  // ----------------------------------------------------------------
  // GET /:code/raw — serve raw content (HTML: no branding; image: file)
  // ----------------------------------------------------------------
  fastify.get('/:code/raw', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const code = normalizeCode(req.params.code)
    const link = db.get('SELECT * FROM links WHERE code = ?', code)
    if (!link || !link.is_active) {
      reply.code(404)
      return reply.view('errors/404.njk', {})
    }
    if (link.type === 'html') {
      reply.header('Content-Type', 'text/html; charset=utf-8')
      return reply.send(link.destination)
    }
    if (link.type === 'image') {
      return reply.redirect(302, `/uploads/${link.destination}`)
    }
    return reply.redirect(302, `/${code}`)
  })

  // ----------------------------------------------------------------
  // GET /:code — serve content by type
  // ----------------------------------------------------------------
  fastify.get('/:code', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const code = normalizeCode(req.params.code)
    const link = db.get('SELECT * FROM links WHERE code = ?', code)

    if (!link) {
      reply.code(404)
      return reply.view('errors/404.njk', {})
    }
    if (!link.is_active) {
      // Show disabled page to owner so they can request re-enable
      if (req.session.userId && link.owner_id === req.session.userId) {
        reply.code(410)
        return reply.view('link-disabled.njk', { link, code })
      }
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

    await hooks.run('post:link:visit', { link, req })

    switch (link.type) {
      case 'text':
        return reply.view('text-view.njk', { link })
      case 'html':
        return reply.view('html-view.njk', { link })
      case 'image':
        return reply.redirect(302, `/uploads/${link.destination}`)
      case 'bookmark': {
        const items = db.all(
          'SELECT * FROM bookmark_items WHERE link_id = ? ORDER BY folder, sort_order, id',
          link.id
        )
        return reply.view('bookmark-view.njk', { link, items })
      }
      default:
        return reply.redirect(302, link.destination)
    }
  })

  // ----------------------------------------------------------------
  // GET /manage/:code
  // ----------------------------------------------------------------
  fastify.get('/manage/:code', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const code = normalizeCode(req.params.code)
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
      SELECT COUNT(*) as total,
             SUM(CASE WHEN visited_at > ? THEN 1 ELSE 0 END) as today
      FROM tracking WHERE link_id = ?
    `, Date.now() - 86400000, link.id)

    return reply.view('manage.njk', {
      link, shortUrl, qrDataUrl, token,
      stats: { total: stats.total || 0, today: stats.today || 0 }
    })
  })

  // ----------------------------------------------------------------
  // POST /manage/:code
  // ----------------------------------------------------------------
  fastify.post('/manage/:code', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const code = normalizeCode(req.params.code)
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
      req.session.flash = { type: 'success', message: 'Deleted.' }
      return reply.redirect('/')
    }

    if (action === 'update') {
      if (link.type === 'url') {
        const dest = (destination || '').trim()
        if (!dest.startsWith('http://') && !dest.startsWith('https://')) {
          req.session.flash = { type: 'error', message: 'Invalid URL.' }
          return reply.redirect(`/manage/${code}?token=${token}`)
        }
        db.run('UPDATE links SET destination = ?, title = ? WHERE id = ?', dest, title || null, link.id)
      } else {
        db.run('UPDATE links SET title = ? WHERE id = ?', title || null, link.id)
      }
      req.session.flash = { type: 'success', message: 'Updated.' }
      return reply.redirect(`/manage/${code}?token=${token}`)
    }

    return reply.redirect(`/manage/${code}?token=${token}`)
  })

  // ----------------------------------------------------------------
  // GET /report/:code
  // ----------------------------------------------------------------
  fastify.get('/report/:code', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    return reply.view('report.njk', { code: req.params.code })
  })

  // ----------------------------------------------------------------
  // POST /report/:code
  // ----------------------------------------------------------------
  fastify.post('/report/:code', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const code = normalizeCode(req.params.code)
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

  async function createUrlAndRedirect(req, reply, destination) {
    const { link, plainToken } = await createLink(db, hooks, {
      type: 'url',
      destination,
      ownerId: req.session.userId || null,
      req,
    })
    // Store code so it can be claimed if user logs in / registers
    if (!req.session.userId) {
      req.session.pendingClaimCode = link.code
    }
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
