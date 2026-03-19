import fp from 'fastify-plugin'
import { requireAdmin } from '../../core/auth.js'

async function adminPlugin(fastify) {
  const db = fastify.db

  // Guard all /admin routes
  fastify.addHook('preHandler', async (req, reply) => {
    if (req.url?.startsWith('/admin')) {
      await requireAdmin(req, reply)
    }
  })

  fastify.get('/admin', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    return reply.redirect('/admin/overview')
  })

  // ----------------------------------------------------------------
  // GET /admin/overview
  // ----------------------------------------------------------------
  fastify.get('/admin/overview', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const todayStart = new Date().setHours(0, 0, 0, 0)
    const stats = db.get(`
      SELECT
        (SELECT COUNT(*) FROM links) as totalLinks,
        (SELECT COUNT(*) FROM users) as totalUsers,
        (SELECT COUNT(*) FROM tracking) as totalVisits,
        (SELECT COUNT(*) FROM tracking WHERE visited_at >= ?) as visitsToday,
        (SELECT COUNT(*) FROM reports WHERE status = 'pending') as pendingReports
    `, todayStart)

    const recentLinks = db.all(
      `SELECT code, created_at FROM links ORDER BY created_at DESC LIMIT 10`
    )

    return reply.view('admin/index.njk', {
      stats,
      recentLinks: recentLinks.map(l => ({ ...l, createdAt: l.created_at })),
      currentUserId: req.session.userId,
    })
  })

  // ----------------------------------------------------------------
  // GET /admin/links
  // ----------------------------------------------------------------
  fastify.get('/admin/links', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()

    const page = Math.max(1, Number(req.query.page) || 1)
    const perPage = 30
    const offset = (page - 1) * perPage
    const q = (req.query.q || '').trim()
    const sort = ['created_at', 'code'].includes(req.query.sort) ? req.query.sort : 'created_at'
    const dir = req.query.dir === 'asc' ? 'ASC' : 'DESC'

    let rows, totalRow
    if (q) {
      const like = `%${q}%`
      rows = db.all(`
        SELECT l.*, u.username, COUNT(t.id) as visit_count
        FROM links l
        LEFT JOIN users u ON u.id = l.owner_id
        LEFT JOIN tracking t ON t.link_id = l.id
        WHERE l.code LIKE ? OR l.destination LIKE ?
        GROUP BY l.id ORDER BY l.${sort} ${dir} LIMIT ? OFFSET ?
      `, like, like, perPage, offset)
      totalRow = db.get(`SELECT COUNT(*) as n FROM links WHERE code LIKE ? OR destination LIKE ?`, like, like)
    } else {
      rows = db.all(`
        SELECT l.*, u.username, COUNT(t.id) as visit_count
        FROM links l
        LEFT JOIN users u ON u.id = l.owner_id
        LEFT JOIN tracking t ON t.link_id = l.id
        GROUP BY l.id ORDER BY l.${sort} ${dir} LIMIT ? OFFSET ?
      `, perPage, offset)
      totalRow = db.get(`SELECT COUNT(*) as n FROM links`)
    }

    return reply.view('admin/links.njk', {
      links: rows.map(l => ({
        ...l, createdAt: l.created_at,
        isActive: Boolean(l.is_active), visitCount: l.visit_count,
      })),
      pagination: { page, totalPages: Math.ceil(totalRow.n / perPage), total: totalRow.n },
      query: { q, sort, dir: dir.toLowerCase() },
    })
  })

  fastify.post('/admin/links/:id/delete', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    db.run('DELETE FROM links WHERE id = ?', Number(req.params.id))
    req.session.flash = { type: 'success', message: 'Link deleted.' }
    return reply.redirect('/admin/links')
  })

  fastify.post('/admin/links/:id/toggle', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const link = db.get('SELECT id, is_active FROM links WHERE id = ?', Number(req.params.id))
    if (link) db.run('UPDATE links SET is_active = ? WHERE id = ?', link.is_active ? 0 : 1, link.id)
    return reply.redirect('/admin/links')
  })

  // ----------------------------------------------------------------
  // GET /admin/users
  // ----------------------------------------------------------------
  fastify.get('/admin/users', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()

    const page = Math.max(1, Number(req.query.page) || 1)
    const perPage = 30
    const offset = (page - 1) * perPage
    const q = (req.query.q || '').trim()

    let rows, totalRow
    if (q) {
      const like = `%${q}%`
      rows = db.all(`
        SELECT u.*, COUNT(l.id) as link_count FROM users u
        LEFT JOIN links l ON l.owner_id = u.id
        WHERE u.username LIKE ? OR u.email LIKE ?
        GROUP BY u.id ORDER BY u.created_at DESC LIMIT ? OFFSET ?
      `, like, like, perPage, offset)
      totalRow = db.get(`SELECT COUNT(*) as n FROM users WHERE username LIKE ? OR email LIKE ?`, like, like)
    } else {
      rows = db.all(`
        SELECT u.*, COUNT(l.id) as link_count FROM users u
        LEFT JOIN links l ON l.owner_id = u.id
        GROUP BY u.id ORDER BY u.created_at DESC LIMIT ? OFFSET ?
      `, perPage, offset)
      totalRow = db.get(`SELECT COUNT(*) as n FROM users`)
    }

    return reply.view('admin/users.njk', {
      users: rows.map(u => ({
        ...u, createdAt: u.created_at,
        isBlocked: Boolean(u.is_blocked),
        subscriptionTier: u.subscription_tier,
        linkCount: u.link_count,
      })),
      pagination: { page, totalPages: Math.ceil(totalRow.n / perPage), total: totalRow.n },
      query: { q },
      currentUserId: req.session.userId,
    })
  })

  fastify.post('/admin/users/:id/block', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    db.run('UPDATE users SET is_blocked = 1 WHERE id = ?', Number(req.params.id))
    req.session.flash = { type: 'success', message: 'User blocked.' }
    return reply.redirect('/admin/users')
  })

  fastify.post('/admin/users/:id/unblock', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    db.run('UPDATE users SET is_blocked = 0 WHERE id = ?', Number(req.params.id))
    req.session.flash = { type: 'success', message: 'User unblocked.' }
    return reply.redirect('/admin/users')
  })

  fastify.post('/admin/users/:id/delete', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    if (Number(req.params.id) === req.session.userId) {
      req.session.flash = { type: 'error', message: "You can't delete your own account." }
      return reply.redirect('/admin/users')
    }
    db.run('DELETE FROM users WHERE id = ?', Number(req.params.id))
    req.session.flash = { type: 'success', message: 'User deleted.' }
    return reply.redirect('/admin/users')
  })

  // ----------------------------------------------------------------
  // GET /admin/reports
  // ----------------------------------------------------------------
  fastify.get('/admin/reports', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const status = req.query.status === 'all' ? null : 'pending'

    const reports = status
      ? db.all(`
          SELECT r.*, l.code as link_code, l.destination as link_destination
          FROM reports r LEFT JOIN links l ON l.id = r.link_id
          WHERE r.status = ? ORDER BY r.created_at DESC LIMIT 100
        `, status)
      : db.all(`
          SELECT r.*, l.code as link_code, l.destination as link_destination
          FROM reports r LEFT JOIN links l ON l.id = r.link_id
          ORDER BY r.created_at DESC LIMIT 100
        `)

    return reply.view('admin/reports.njk', {
      reports: reports.map(r => ({
        ...r, createdAt: r.created_at,
        linkCode: r.link_code, linkDestination: r.link_destination,
        reporterIp: r.reporter_ip,
      })),
      query: { status: req.query.status || 'pending' },
    })
  })

  fastify.post('/admin/reports/:id/ignore', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    db.run(`UPDATE reports SET status = 'ignored' WHERE id = ?`, Number(req.params.id))
    return reply.redirect('/admin/reports')
  })

  fastify.post('/admin/reports/:id/action', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const report = db.get('SELECT * FROM reports WHERE id = ?', Number(req.params.id))
    if (report) {
      db.run(`UPDATE reports SET status = 'actioned' WHERE id = ?`, report.id)
      db.run('UPDATE links SET is_active = 0 WHERE id = ?', report.link_id)
    }
    req.session.flash = { type: 'success', message: 'Link deactivated.' }
    return reply.redirect('/admin/reports')
  })

  // ----------------------------------------------------------------
  // GET /admin/settings
  // ----------------------------------------------------------------
  fastify.get('/admin/settings', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const rows = db.all('SELECT key, value FROM settings')
    const settingsMap = Object.fromEntries(rows.map(r => [r.key, r.value]))
    const blockedIps = db.all('SELECT * FROM blocked_ips ORDER BY created_at DESC')
    return reply.view('admin/settings.njk', { settings: settingsMap, blockedIps })
  })

  fastify.post('/admin/settings', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const allowed = [
      'site_name', 'site_tagline', 'registration_open',
      'require_login_to_create', 'max_links_anonymous',
      'max_file_size_mb', 'allowed_image_types', 'ads_enabled',
    ]
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        db.run(
          `INSERT INTO settings(key, value, updated_at) VALUES(?,?,?)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
          key, String(req.body[key]), Date.now()
        )
      }
    }
    req.session.flash = { type: 'success', message: 'Settings saved.' }
    return reply.redirect('/admin/settings')
  })

  fastify.post('/admin/blocked-ips', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const { cidr, reason } = req.body
    if (cidr?.trim()) {
      db.run(
        `INSERT INTO blocked_ips(cidr, reason, blocked_by, created_at) VALUES(?,?,?,?)`,
        cidr.trim(), reason || null, req.session.userId, Date.now()
      )
    }
    return reply.redirect('/admin/settings')
  })

  fastify.post('/admin/blocked-ips/:id/delete', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    db.run('DELETE FROM blocked_ips WHERE id = ?', Number(req.params.id))
    return reply.redirect('/admin/settings')
  })
}

export default fp(adminPlugin, { name: 'admin' })
