import fp from 'fastify-plugin'
import { requireAdmin } from '../../core/auth.js'
import config from '../../config.js'
import { ipMatchesCidr } from '../../core/cidr.js'
import { invalidateIpCache } from '../../core/ipblock.js'
import { scanUrl, scanUrlContent } from '../../core/scanner.js'
import { checkForUpdates, getUpdateStatus, reloadCurrentVersion } from '../../core/updater.js'
import { checkLinkLimits } from '../../core/tiers.js'

async function adminPlugin(fastify) {
  const db = fastify.db

  function blockIp(cidr, reason) {
    const normalized = cidr.trim()
    if (!normalized) return false
    db.run(`DELETE FROM blocked_ips WHERE cidr = ? AND type = 'unblock'`, normalized)
    const exists = db.get(`SELECT id FROM blocked_ips WHERE cidr = ? AND type = 'block'`, normalized)
    if (exists) return false
    db.run(
      `INSERT INTO blocked_ips(cidr, reason, type, created_at) VALUES(?,?,?,?)`,
      normalized, reason || null, 'block', Date.now()
    )
    invalidateIpCache()
    return true
  }

  function unblockIp(cidr) {
    const normalized = cidr.trim()
    if (!normalized) return
    db.run(`DELETE FROM blocked_ips WHERE cidr = ? AND type = 'block'`, normalized)
    const netmasks = db.all(`SELECT cidr FROM blocked_ips WHERE type = 'block' AND cidr LIKE '%/%'`)
    const coveredByNetmask = netmasks.some(r => ipMatchesCidr(normalized, r.cidr))
    if (coveredByNetmask) {
      const exists = db.get(`SELECT id FROM blocked_ips WHERE cidr = ? AND type = 'unblock'`, normalized)
      if (!exists) {
        db.run(
          `INSERT INTO blocked_ips(cidr, reason, type, created_at) VALUES(?,?,?,?)`,
          normalized, 'Explicitly unblocked', 'unblock', Date.now()
        )
      }
    }
    invalidateIpCache()
  }

  // Scan links against scan_words on creation; increment hit counter on match
  const hooks = fastify.hooks
  hooks.on('pre:link:create', async ({ data }) => {
    // Tier limit checks
    checkLinkLimits(data, db)

    // Content scanning
    if (!data.destination) return
    const words = db.all('SELECT * FROM scan_words WHERE active = 1')
    if (!words.length) return
    const matched = scanUrl(data.destination, words)
    if (matched) {
      const word = words.find(w => w.word.toLowerCase() === matched.toLowerCase())
      if (word) {
        try { db.run('UPDATE scan_words SET hits = hits + 1 WHERE id = ?', word.id) } catch (_) {}
      }
      throw Object.assign(new Error('Link blocked by content policy.'), { statusCode: 422 })
    }
  })

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
      `SELECT code, type, created_at FROM links ORDER BY created_at DESC LIMIT 10`
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

    const perPage = Math.min(500, Math.max(10,
      parseInt(req.query.perPage || req.cookies?.admin_links_perpage || '100')
    ))
    const page = Math.max(1, Number(req.query.page) || 1)
    const offset = (page - 1) * perPage
    const q = (req.query.q || '').trim()
    const SORTABLE = { created_at: 'l.created_at', code: 'l.code', type: 'l.type', username: 'u.username', visit_count: 'visit_count', is_active: 'l.is_active', created_ip: 'l.created_ip', file_size: 'l.file_size' }
    const sort = SORTABLE[req.query.sort] ? req.query.sort : 'created_at'
    const sortCol = SORTABLE[sort]
    const dir = req.query.dir === 'asc' ? 'ASC' : 'DESC'

    let rows, totalRow
    if (q) {
      const like = `%${q}%`
      rows = db.all(`
        SELECT l.*, u.username, u.is_blocked as owner_is_blocked, COUNT(t.id) as visit_count
        FROM links l
        LEFT JOIN users u ON u.id = l.owner_id
        LEFT JOIN tracking t ON t.link_id = l.id
        WHERE l.code LIKE ? OR l.destination LIKE ? OR u.username LIKE ?
        GROUP BY l.id ORDER BY ${sortCol} ${dir} LIMIT ? OFFSET ?
      `, like, like, like, perPage, offset)
      totalRow = db.get(`SELECT COUNT(*) as n FROM links l LEFT JOIN users u ON u.id = l.owner_id WHERE l.code LIKE ? OR l.destination LIKE ? OR u.username LIKE ?`, like, like, like)
    } else {
      rows = db.all(`
        SELECT l.*, u.username, u.is_blocked as owner_is_blocked, COUNT(t.id) as visit_count
        FROM links l
        LEFT JOIN users u ON u.id = l.owner_id
        LEFT JOIN tracking t ON t.link_id = l.id
        GROUP BY l.id ORDER BY ${sortCol} ${dir} LIMIT ? OFFSET ?
      `, perPage, offset)
      totalRow = db.get(`SELECT COUNT(*) as n FROM links`)
    }

    const blockedIps = new Set(
      db.all(`SELECT cidr FROM blocked_ips WHERE type = 'block' AND cidr NOT LIKE '%/%'`).map(r => r.cidr)
    )

    return reply.view('admin/links.njk', {
      links: rows.map(l => ({
        ...l, createdAt: l.created_at,
        isActive: Boolean(l.is_active), visitCount: l.visit_count,
        creatorIpBlocked: l.created_ip ? blockedIps.has(l.created_ip) : false,
        ownerIsBlocked: Boolean(l.owner_is_blocked),
      })),
      pagination: { page, totalPages: Math.ceil(totalRow.n / perPage), total: totalRow.n },
      query: { q, sort, dir: dir.toLowerCase() },
      perPage,
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

  fastify.post('/admin/users/:id/make-admin', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    db.run(`UPDATE users SET role = 'admin' WHERE id = ?`, Number(req.params.id))
    req.session.flash = { type: 'success', message: 'User promoted to admin.' }
    return reply.redirect('/admin/users')
  })

  fastify.post('/admin/users/:id/remove-admin', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    if (Number(req.params.id) === req.session.userId) {
      req.session.flash = { type: 'error', message: "You can't remove your own admin role." }
      return reply.redirect('/admin/users')
    }
    db.run(`UPDATE users SET role = 'user' WHERE id = ?`, Number(req.params.id))
    req.session.flash = { type: 'success', message: 'Admin role removed.' }
    return reply.redirect('/admin/users')
  })

  fastify.post('/admin/users/:id/delete', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    if (Number(req.params.id) === req.session.userId) {
      req.session.flash = { type: 'error', message: "You can't delete your own account. Have another admin do it." }
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
          SELECT r.*,
            l.code as link_code, l.destination as link_destination, l.created_ip as link_creator_ip, l.is_active as link_is_active,
            u.id as owner_id, u.username as owner_username, u.is_blocked as owner_is_blocked
          FROM reports r
          LEFT JOIN links l ON l.id = r.link_id
          LEFT JOIN users u ON u.id = l.owner_id
          WHERE r.status = ? ORDER BY r.created_at DESC LIMIT 100
        `, status)
      : db.all(`
          SELECT r.*,
            l.code as link_code, l.destination as link_destination, l.created_ip as link_creator_ip, l.is_active as link_is_active,
            u.id as owner_id, u.username as owner_username, u.is_blocked as owner_is_blocked
          FROM reports r
          LEFT JOIN links l ON l.id = r.link_id
          LEFT JOIN users u ON u.id = l.owner_id
          ORDER BY r.created_at DESC LIMIT 100
        `)

    const blockedIps = new Set(
      db.all(`SELECT cidr FROM blocked_ips WHERE type = 'block' AND cidr NOT LIKE '%/%'`).map(r => r.cidr)
    )

    return reply.view('admin/reports.njk', {
      reports: reports.map(r => ({
        ...r, createdAt: r.created_at,
        linkCode: r.link_code, linkDestination: r.link_destination,
        linkCreatorIp: r.link_creator_ip, linkIsActive: Boolean(r.link_is_active),
        reporterIp: r.reporter_ip,
        ownerId: r.owner_id, ownerUsername: r.owner_username, ownerIsBlocked: Boolean(r.owner_is_blocked),
        creatorIpBlocked: r.link_creator_ip ? blockedIps.has(r.link_creator_ip) : false,
        isReenableRequest: (r.reason || '').startsWith('[re-enable request]'),
      })),
      query: { status: req.query.status || 'pending' },
    })
  })

  fastify.post('/admin/reports/:id/ignore', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    db.run(`UPDATE reports SET status = 'ignored' WHERE id = ?`, Number(req.params.id))
    return reply.redirect('/admin/reports')
  })

  fastify.post('/admin/reports/:id/disable', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const report = db.get('SELECT * FROM reports WHERE id = ?', Number(req.params.id))
    if (report) {
      db.run(`UPDATE reports SET status = 'actioned' WHERE id = ?`, report.id)
      db.run('UPDATE links SET is_active = 0 WHERE id = ?', report.link_id)
    }
    req.session.flash = { type: 'success', message: 'Link disabled.' }
    return reply.redirect('/admin/reports')
  })

  fastify.post('/admin/reports/:id/enable', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const report = db.get('SELECT * FROM reports WHERE id = ?', Number(req.params.id))
    if (report) {
      db.run(`UPDATE reports SET status = 'actioned' WHERE id = ?`, report.id)
      db.run('UPDATE links SET is_active = 1 WHERE id = ?', report.link_id)
    }
    req.session.flash = { type: 'success', message: 'Link re-enabled.' }
    return reply.redirect('/admin/reports')
  })

  fastify.post('/admin/reports/:id/block-user', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const report = db.get(`SELECT r.*, l.owner_id FROM reports r LEFT JOIN links l ON l.id = r.link_id WHERE r.id = ?`, Number(req.params.id))
    if (report?.owner_id) db.run('UPDATE users SET is_blocked = 1 WHERE id = ?', report.owner_id)
    req.session.flash = { type: 'success', message: 'User blocked.' }
    return reply.redirect('/admin/reports')
  })

  fastify.post('/admin/reports/:id/unblock-user', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const report = db.get(`SELECT r.*, l.owner_id FROM reports r LEFT JOIN links l ON l.id = r.link_id WHERE r.id = ?`, Number(req.params.id))
    if (report?.owner_id) db.run('UPDATE users SET is_blocked = 0 WHERE id = ?', report.owner_id)
    req.session.flash = { type: 'success', message: 'User unblocked.' }
    return reply.redirect('/admin/reports')
  })

  fastify.post('/admin/reports/:id/block-ip', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const report = db.get(`SELECT r.*, l.created_ip FROM reports r LEFT JOIN links l ON l.id = r.link_id WHERE r.id = ?`, Number(req.params.id))
    if (report?.created_ip) blockIp(report.created_ip, `Blocked from report #${report.id}`)
    req.session.flash = { type: 'success', message: 'IP blocked.' }
    return reply.redirect('/admin/reports')
  })

  fastify.post('/admin/reports/:id/unblock-ip', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const report = db.get(`SELECT r.*, l.created_ip FROM reports r LEFT JOIN links l ON l.id = r.link_id WHERE r.id = ?`, Number(req.params.id))
    if (report?.created_ip) unblockIp(report.created_ip)
    req.session.flash = { type: 'success', message: 'IP unblocked.' }
    return reply.redirect('/admin/reports')
  })

  // ----------------------------------------------------------------
  // GET /admin/dns
  // ----------------------------------------------------------------
  fastify.get('/admin/dns', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const records = db.all(`
      SELECT d.*, u.username
      FROM dns_records d
      LEFT JOIN users u ON u.id = d.user_id
      ORDER BY d.subdomain
    `)
    return reply.view('admin/dns.njk', { records, dynApex: `${config.DYN_SUBDOMAIN}.${config.BASE_DOMAIN}` })
  })

  fastify.post('/admin/dns/:id/ttl', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const ttl = Math.max(30, Math.min(86400, parseInt(req.body.ttl) || 300))
    db.run('UPDATE dns_records SET ttl = ? WHERE id = ?', ttl, Number(req.params.id))
    if (fastify.invalidateDnsCache) fastify.invalidateDnsCache()
    req.session.flash = { type: 'success', message: `TTL updated to ${ttl}s.` }
    return reply.redirect('/admin/dns')
  })

  // ----------------------------------------------------------------
  // GET /admin/settings
  // ----------------------------------------------------------------
  fastify.get('/admin/settings', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const rows = db.all('SELECT key, value FROM settings')
    const settingsMap = Object.fromEntries(rows.map(r => [r.key, r.value]))
    // List available themes
    const { readdirSync } = await import('fs')
    const { join, dirname } = await import('path')
    const { fileURLToPath } = await import('url')
    const __dir = dirname(fileURLToPath(import.meta.url))
    let availableThemes = ['default']
    try {
      const entries = readdirSync(join(__dir, '../../themes'), { withFileTypes: true })
      availableThemes = entries.filter(e => e.isDirectory()).map(e => e.name)
    } catch (_) {}
    return reply.view('admin/settings.njk', { settings: settingsMap, availableThemes, updateInfo: getUpdateStatus() })
  })

  fastify.post('/admin/settings', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const allowed = [
      'site_name', 'site_tagline', 'registration_open',
      'require_login_to_create', 'max_links_anonymous',
      'max_file_size_mb', 'allowed_image_types', 'ads_enabled', 'active_theme',
      'github_repo_url', 'update_check_hours',
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

  // ----------------------------------------------------------------
  // GET /admin/blocked-ips
  // ----------------------------------------------------------------
  fastify.get('/admin/blocked-ips', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const q = (req.query.q || '').trim()
    const typeFilter = req.query.type || ''
    let rows
    if (q) {
      rows = db.all(`SELECT * FROM blocked_ips WHERE cidr LIKE ? ORDER BY created_at DESC`, `%${q}%`)
    } else {
      rows = db.all(`SELECT * FROM blocked_ips ORDER BY created_at DESC`)
    }
    if (typeFilter) rows = rows.filter(r => r.type === typeFilter)
    return reply.view('admin/blocked-ips.njk', {
      entries: rows.map(r => ({ ...r, createdAt: r.created_at })),
      query: { q, type: typeFilter },
    })
  })

  fastify.post('/admin/blocked-ips', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const { cidr, reason, type = 'block' } = req.body
    if (!cidr?.trim()) return reply.redirect('/admin/blocked-ips')
    if (type === 'unblock') {
      unblockIp(cidr)
    } else {
      const added = blockIp(cidr, reason)
      if (!added) {
        req.session.flash = { type: 'info', message: `${cidr} is already blocked.` }
      }
    }
    return reply.redirect('/admin/blocked-ips')
  })

  fastify.post('/admin/blocked-ips/:id/delete', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    db.run('DELETE FROM blocked_ips WHERE id = ?', Number(req.params.id))
    invalidateIpCache()
    return reply.redirect('/admin/blocked-ips')
  })

  // Block/unblock IP from any admin page (used by links + reports)
  fastify.post('/admin/ip/block', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const { ip, reason, redirect = '/admin/links' } = req.body
    if (ip?.trim()) blockIp(ip.trim(), reason)
    req.session.flash = { type: 'success', message: `${ip} blocked.` }
    return reply.redirect(redirect)
  })

  fastify.post('/admin/ip/unblock', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const { ip, redirect = '/admin/links' } = req.body
    if (ip?.trim()) unblockIp(ip.trim())
    req.session.flash = { type: 'success', message: `${ip} unblocked.` }
    return reply.redirect(redirect)
  })

  fastify.post('/admin/users/:id/tier', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const { tier } = req.body
    if (['free', 'paid'].includes(tier)) {
      db.run('UPDATE users SET subscription_tier = ? WHERE id = ?', tier, Number(req.params.id))
    }
    req.session.flash = { type: 'success', message: 'Tier updated.' }
    return reply.redirect('/admin/users')
  })

  fastify.post('/admin/users/:id/impersonate', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const user = db.get('SELECT * FROM users WHERE id = ?', Number(req.params.id))
    if (!user) {
      req.session.flash = { type: 'error', message: 'User not found.' }
      return reply.redirect('/admin/users')
    }
    req.session.impersonatingAdminId = req.session.userId
    req.session.impersonatingAdminUsername = req.session.username
    req.session.impersonatingAdminRole = req.session.role
    req.session.impersonatingAdminDisplayName = req.session.displayName || null
    req.session.impersonatingAdminEmail = req.session.email || null
    req.session.userId = user.id
    req.session.username = user.username
    req.session.displayName = user.display_name || null
    req.session.email = user.email || null
    req.session.role = user.role
    req.session.subscriptionTier = user.subscription_tier || 'free'
    req.session.flash = { type: 'info', message: `Now logged in as ${user.email || user.username}` }
    return reply.redirect('/dashboard')
  })

  // ----------------------------------------------------------------
  // GET /admin/messages
  // ----------------------------------------------------------------
  fastify.get('/admin/messages', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const messages = db.all('SELECT * FROM messages ORDER BY created_at DESC LIMIT 200')
    return reply.view('admin/messages.njk', {
      messages: messages.map(m => ({ ...m, createdAt: m.created_at, isRead: Boolean(m.is_read) })),
    })
  })

  fastify.post('/admin/messages/:id/read', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    db.run('UPDATE messages SET is_read = 1 WHERE id = ?', Number(req.params.id))
    return reply.redirect('/admin/messages')
  })

  fastify.post('/admin/messages/:id/delete', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    db.run('DELETE FROM messages WHERE id = ?', Number(req.params.id))
    return reply.redirect('/admin/messages')
  })

  // ----------------------------------------------------------------
  // GET /admin/scan-words
  // ----------------------------------------------------------------
  fastify.get('/admin/scan-words', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const words = db.all('SELECT * FROM scan_words ORDER BY created_at DESC')
    return reply.view('admin/scan-words.njk', { words: words.map(w => ({ ...w, isActive: Boolean(w.active) })) })
  })

  fastify.post('/admin/scan-words', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const { word, scope = 'url' } = req.body
    if (word?.trim()) {
      const validScope = ['url', 'domain', 'content'].includes(scope) ? scope : 'url'
      db.run(
        `INSERT INTO scan_words(word, scope, active, created_at) VALUES(?,?,1,?)`,
        word.trim().toLowerCase(), validScope, Date.now()
      )
    }
    return reply.redirect('/admin/scan-words')
  })

  fastify.post('/admin/scan-words/:id/delete', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    db.run('DELETE FROM scan_words WHERE id = ?', Number(req.params.id))
    return reply.redirect('/admin/scan-words')
  })

  fastify.post('/admin/scan-words/:id/toggle', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const w = db.get('SELECT id, active FROM scan_words WHERE id = ?', Number(req.params.id))
    if (w) db.run('UPDATE scan_words SET active = ? WHERE id = ?', w.active ? 0 : 1, w.id)
    return reply.redirect('/admin/scan-words')
  })

  // ----------------------------------------------------------------
  // Admin: reset user password
  // ----------------------------------------------------------------
  fastify.post('/admin/users/:id/reset-password', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const { password = '' } = req.body || {}
    if (!password || password.length < 8) {
      req.session.flash = { type: 'error', message: 'Password must be at least 8 characters.' }
      return reply.redirect('/admin/users')
    }
    const { hashPassword } = await import('../../core/auth.js')
    const hash = await hashPassword(password)
    db.run('UPDATE users SET password_hash = ? WHERE id = ?', hash, Number(req.params.id))
    req.session.flash = { type: 'success', message: 'Password reset.' }
    return reply.redirect('/admin/users')
  })

  // ----------------------------------------------------------------
  // Admin: account tiers
  // ----------------------------------------------------------------
  fastify.get('/admin/account-tiers', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const tiers = db.all('SELECT * FROM account_tiers ORDER BY name')
    return reply.view('admin/account-tiers.njk', { tiers })
  })

  fastify.post('/admin/account-tiers', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const { name, label, description, price, max_links_total, max_images_total, max_text_total, max_links_per_hour,
      max_ddns_entries, max_file_size_mb, allow_raw_html, show_ads, allow_ad_campaigns, is_enabled } = req.body || {}
    if (!name?.trim()) {
      req.session.flash = { type: 'error', message: 'Name required.' }
      return reply.redirect('/admin/account-tiers')
    }
    db.run(
      `INSERT INTO account_tiers(name,label,description,price,max_links_total,max_images_total,max_text_total,max_links_per_hour,max_ddns_entries,max_file_size_mb,allow_raw_html,show_ads,allow_ad_campaigns,is_enabled,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(name) DO UPDATE SET label=excluded.label, description=excluded.description,
         price=excluded.price, max_links_total=excluded.max_links_total,
         max_images_total=excluded.max_images_total, max_text_total=excluded.max_text_total,
         max_links_per_hour=excluded.max_links_per_hour, max_ddns_entries=excluded.max_ddns_entries,
         max_file_size_mb=excluded.max_file_size_mb, allow_raw_html=excluded.allow_raw_html,
         show_ads=excluded.show_ads, allow_ad_campaigns=excluded.allow_ad_campaigns,
         is_enabled=excluded.is_enabled`,
      name.trim().toLowerCase(), label || name.trim(), description?.trim() || null,
      parseFloat(price) || 0,
      Number(max_links_total) || 0, Number(max_images_total) || 0, Number(max_text_total) || 0,
      Number(max_links_per_hour) || 0, Number(max_ddns_entries) || 5, Number(max_file_size_mb) || 10,
      allow_raw_html === '1' ? 1 : 0, show_ads === '1' ? 1 : 0, allow_ad_campaigns === '1' ? 1 : 0,
      is_enabled === '1' ? 1 : 0,
      Date.now()
    )
    req.session.flash = { type: 'success', message: 'Tier saved.' }
    return reply.redirect('/admin/account-tiers')
  })

  fastify.post('/admin/account-tiers/:id/delete', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    db.run('DELETE FROM account_tiers WHERE id = ?', Number(req.params.id))
    req.session.flash = { type: 'success', message: 'Tier deleted.' }
    return reply.redirect('/admin/account-tiers')
  })

  fastify.post('/admin/account-tiers/:id/toggle-enabled', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const tier = db.get('SELECT id, is_enabled FROM account_tiers WHERE id = ?', Number(req.params.id))
    if (tier) db.run('UPDATE account_tiers SET is_enabled = ? WHERE id = ?', tier.is_enabled ? 0 : 1, tier.id)
    return reply.redirect('/admin/account-tiers')
  })

  // ----------------------------------------------------------------
  // POST /admin/update/check — force a remote version check
  // ----------------------------------------------------------------
  fastify.post('/admin/update/check', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const repoUrl = db.get("SELECT value FROM settings WHERE key = 'github_repo_url'")?.value
    const result = await checkForUpdates(repoUrl, { force: true })
    if (result) {
      req.session.flash = result.updateAvailable
        ? { type: 'info', message: `Update available: v${result.latest} (current: v${result.current})` }
        : { type: 'success', message: `Up to date (v${result.current})` }
    } else {
      req.session.flash = { type: 'error', message: 'Could not reach update server. Check GitHub repo URL.' }
    }
    return reply.redirect('/admin/settings')
  })

  // ----------------------------------------------------------------
  // POST /admin/update/apply — git pull then restart via PM2
  // ----------------------------------------------------------------
  fastify.post('/admin/update/apply', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const { execSync } = await import('child_process')
    try {
      const out = execSync('git pull', { cwd: process.cwd(), timeout: 60000 })
      console.log('[updater] git pull output:', out.toString())
      reloadCurrentVersion()
      req.session.flash = { type: 'success', message: 'Update applied. App is restarting...' }
      await reply.redirect('/admin/settings')
      setTimeout(() => process.exit(0), 500)
    } catch (err) {
      console.error('[updater] git pull failed:', err.message)
      req.session.flash = { type: 'error', message: 'Update failed: ' + (err.stderr?.toString() || err.message) }
      return reply.redirect('/admin/settings')
    }
  })

  // Add theme to settings allowed list and list available themes
  fastify.get('/admin/themes', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const { readdirSync, existsSync } = await import('fs')
    const { join, dirname } = await import('path')
    const { fileURLToPath } = await import('url')
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const themesDir = join(__dirname, '../../themes')
    let themes = ['default']
    try {
      const entries = readdirSync(themesDir, { withFileTypes: true })
      themes = entries.filter(e => e.isDirectory()).map(e => e.name)
    } catch (_) {}
    const current = db.get("SELECT value FROM settings WHERE key = 'active_theme'")?.value || 'default'
    return reply.send({ themes, current })
  })
}

export default fp(adminPlugin, { name: 'admin' })
