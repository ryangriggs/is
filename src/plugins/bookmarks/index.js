import fp from 'fastify-plugin'
import { createLink } from '../../core/links.js'
import { requireAuth } from '../../core/auth.js'
import { verifyToken, hashToken } from '../../core/auth.js'
import config from '../../config.js'
import { getAdForOwner } from '../../core/ads.js'

function slugify(str) {
  return str.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/, '')
}

function findBySlug(db, slug, userId) {
  const rows = userId
    ? db.all(`SELECT * FROM links WHERE type = 'bookmark' AND owner_id = ?`, userId)
    : db.all(`SELECT * FROM links WHERE type = 'bookmark' AND is_private = 0`)
  return rows.find(l => {
    try { return JSON.parse(l.meta || '{}').slug === slug } catch { return false }
  }) || null
}

async function checkPassword(req, link) {
  if (!link.password_hash) return true
  const submitted = req.query.p || req.body?.password
  if (!submitted) return false
  return verifyToken(submitted, link.password_hash)
}

async function bookmarksPlugin(fastify) {
  const db = fastify.db
  const hooks = fastify.hooks

  // GET /b — list own collections
  fastify.get('/b', { preHandler: requireAuth }, async (req, reply) => {
    const collections = db.all(
      `SELECT l.*, COUNT(bi.id) as item_count
       FROM links l
       LEFT JOIN bookmark_items bi ON bi.link_id = l.id
       WHERE l.owner_id = ? AND l.type = 'bookmark'
       GROUP BY l.id ORDER BY l.created_at DESC`,
      req.session.userId
    )
    const ad = getAdForOwner(req.session.userId || null, db)
    return reply.view('bookmarks.njk', { collections, ad })
  })

  // POST /b — create collection
  fastify.post('/b', { preHandler: requireAuth }, async (req, reply) => {
    const { title = '', is_private, password } = req.body || {}
    if (!title.trim()) {
      req.session.flash = { type: 'error', message: 'Title is required.' }
      return reply.redirect('/b')
    }
    const slug = slugify(title.trim())
    const passwordHash = password ? await hashToken(password) : null
    const { link } = await createLink(db, hooks, {
      type: 'bookmark',
      destination: null,
      title: title.trim(),
      meta: { slug },
      isPrivate: is_private === '1',
      ownerId: req.session.userId,
      req,
    })
    if (passwordHash) {
      db.run('UPDATE links SET password_hash = ? WHERE id = ?', passwordHash, link.id)
    }
    return reply.redirect(`/b/${link.code}`)
  })

  // POST /b/:code/add — add item to collection (by shortcode)
  fastify.post('/b/:code/add', { preHandler: requireAuth }, async (req, reply) => {
    const link = db.get(
      `SELECT * FROM links WHERE code = ? AND type = 'bookmark' AND owner_id = ?`,
      req.params.code, req.session.userId
    )
    if (!link) { reply.code(404); return reply.view('errors/404.njk', {}) }

    const { url = '', title = '', description = '', folder = '' } = req.body || {}
    if (!url.trim()) {
      req.session.flash = { type: 'error', message: 'URL is required.' }
      return reply.redirect(`/b/${link.code}`)
    }
    // Try to fetch page title if none provided
    let resolvedTitle = title.trim()
    if (!resolvedTitle) {
      try {
        const res = await fetch(url.trim(), {
          signal: AbortSignal.timeout(5000),
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; is.am-bot/1.0)' },
        })
        const html = await res.text()
        const match = html.match(/<title[^>]*>([^<]+)<\/title>/i)
        if (match) resolvedTitle = match[1].trim().replace(/\s+/g, ' ').substring(0, 200)
      } catch (_) {}
    }

    const count = db.get('SELECT COUNT(*) as n FROM bookmark_items WHERE link_id = ?', link.id)
    const result = db.run(
      `INSERT INTO bookmark_items(link_id, url, title, description, folder, sort_order) VALUES(?,?,?,?,?,?)`,
      link.id, url.trim(), resolvedTitle || url.trim(),
      description.trim() || null, folder.trim() || null, count.n
    )
    const itemId = result.lastInsertRowid

    // Create a shortlink for this bookmark item
    try {
      const { link: shortlink } = await createLink(db, hooks, {
        type: 'url',
        destination: url.trim(),
        ownerId: req.session.userId,
        req,
      })
      db.run('UPDATE bookmark_items SET shortlink_code = ? WHERE id = ?', shortlink.code, itemId)
    } catch (_) {}

    return reply.redirect(`/b/${link.code}`)
  })

  // POST /b/:code/rename/:itemId — rename a bookmark item
  fastify.post('/b/:code/rename/:itemId', { preHandler: requireAuth }, async (req, reply) => {
    const link = db.get(
      `SELECT * FROM links WHERE code = ? AND type = 'bookmark' AND owner_id = ?`,
      req.params.code, req.session.userId
    )
    if (!link) { reply.code(404); return reply.view('errors/404.njk', {}) }
    const newTitle = (req.body?.title || '').trim()
    if (newTitle) {
      db.run('UPDATE bookmark_items SET title = ? WHERE id = ? AND link_id = ?',
        newTitle, req.params.itemId, link.id)
    }
    return reply.redirect(`/b/${link.code}`)
  })

  // POST /b/:code/delete/:itemId — delete a bookmark item
  fastify.post('/b/:code/delete/:itemId', { preHandler: requireAuth }, async (req, reply) => {
    const link = db.get(
      `SELECT * FROM links WHERE code = ? AND type = 'bookmark' AND owner_id = ?`,
      req.params.code, req.session.userId
    )
    if (!link) { reply.code(404); return reply.view('errors/404.njk', {}) }
    db.run('DELETE FROM bookmark_items WHERE id = ? AND link_id = ?', req.params.itemId, link.id)
    return reply.redirect(`/b/${link.code}`)
  })

  // POST /b/:code/delete — delete collection
  fastify.post('/b/:code/delete', { preHandler: requireAuth }, async (req, reply) => {
    const link = db.get(
      `SELECT * FROM links WHERE code = ? AND type = 'bookmark' AND owner_id = ?`,
      req.params.code, req.session.userId
    )
    if (!link) { reply.code(404); return reply.view('errors/404.njk', {}) }
    db.run('DELETE FROM links WHERE id = ?', link.id)
    req.session.flash = { type: 'success', message: 'Collection deleted.' }
    return reply.redirect('/b')
  })

  // POST /b/:code/visibility — toggle public/private
  fastify.post('/b/:code/visibility', { preHandler: requireAuth }, async (req, reply) => {
    const link = db.get(
      `SELECT * FROM links WHERE code = ? AND type = 'bookmark' AND owner_id = ?`,
      req.params.code, req.session.userId
    )
    if (!link) { reply.code(404); return reply.view('errors/404.njk', {}) }
    db.run('UPDATE links SET is_private = ? WHERE id = ?', link.is_private ? 0 : 1, link.id)
    return reply.redirect(`/b/${link.code}`)
  })

  // POST /b/:code/password — set or clear collection password
  fastify.post('/b/:code/password', { preHandler: requireAuth }, async (req, reply) => {
    const link = db.get(
      `SELECT * FROM links WHERE code = ? AND type = 'bookmark' AND owner_id = ?`,
      req.params.code, req.session.userId
    )
    if (!link) { reply.code(404); return reply.view('errors/404.njk', {}) }
    const { password = '', remove } = req.body || {}
    if (remove === '1' || !password.trim()) {
      db.run('UPDATE links SET password_hash = NULL WHERE id = ?', link.id)
      req.session.flash = { type: 'success', message: 'Password removed.' }
    } else {
      const hash = await hashToken(password)
      db.run('UPDATE links SET password_hash = ? WHERE id = ?', hash, link.id)
      req.session.flash = { type: 'success', message: 'Password set.' }
    }
    return reply.redirect(`/b/${link.code}`)
  })

  // GET /b/* — smart handler:
  //   /b/slug:https://url   → quick-add URL to collection (requires login)
  //   /b/slug               → view/manage collection by slug or shortcode
  fastify.get('/b/*', async (req, reply) => {
    const raw = decodeURIComponent(req.params['*'] || '')
    if (!raw) return reply.redirect('/b')

    // Detect slug:url pattern (first colon not preceded by only slashes)
    const colonIdx = raw.indexOf(':')
    const isQuickAdd = colonIdx > 0 && !raw.substring(0, colonIdx).includes('/')

    if (isQuickAdd) {
      // Quick-add: requires login
      if (!req.session.userId) return reply.redirect('/login?next=' + encodeURIComponent(req.url))

      const slug = raw.substring(0, colonIdx)
      const url = raw.substring(colonIdx + 1)

      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        req.session.flash = { type: 'error', message: 'Invalid URL.' }
        return reply.redirect('/b')
      }

      // Find or create collection by slug
      let link = findBySlug(db, slug, req.session.userId)
      if (!link) {
        const title = slug.replace(/-/g, ' ')
        const result = await createLink(db, hooks, {
          type: 'bookmark',
          destination: null,
          title,
          meta: { slug },
          isPrivate: 0,
          ownerId: req.session.userId,
          req,
        })
        link = result.link
      }

      const count = db.get('SELECT COUNT(*) as n FROM bookmark_items WHERE link_id = ?', link.id)
      const qaResult = db.run(
        `INSERT INTO bookmark_items(link_id, url, title, description, folder, sort_order) VALUES(?,?,?,?,?,?)`,
        link.id, url, url, null, null, count.n
      )
      try {
        const { link: shortlink } = await createLink(db, hooks, {
          type: 'url', destination: url, ownerId: req.session.userId, req,
        })
        db.run('UPDATE bookmark_items SET shortlink_code = ? WHERE id = ?', shortlink.code, qaResult.lastInsertRowid)
      } catch (_) {}

      req.session.flash = { type: 'success', message: `Added to "${link.title}".` }
      return reply.redirect(`/b/${link.code}`)
    }

    // View/manage by shortcode or slug
    const identifier = raw.split('/')[0]

    // Try shortcode first
    let link = db.get(`SELECT * FROM links WHERE code = ? AND type = 'bookmark'`, identifier)

    // Fall back to slug lookup
    if (!link) {
      link = findBySlug(db, identifier, req.session.userId || null)
      if (!link && req.session.userId) {
        // Try public slug too
        link = findBySlug(db, identifier, null)
      }
    }

    if (!link) {
      reply.code(404)
      return reply.view('errors/404.njk', {})
    }

    const isOwner = req.session.userId && link.owner_id === req.session.userId

    // Owner → manage view
    if (isOwner) {
      const items = db.all(
        'SELECT * FROM bookmark_items WHERE link_id = ? ORDER BY folder, sort_order, id',
        link.id
      )
      const shortUrl = `https://${config.BASE_DOMAIN}/${link.code}`
      return reply.view('bookmark-manage.njk', { link, items, shortUrl })
    }

    // Private collection → 403
    if (link.is_private) {
      reply.code(403)
      return reply.view('errors/403.njk', { message: 'This collection is private.' })
    }

    // Password check
    if (link.password_hash) {
      const ok = await checkPassword(req, link)
      if (!ok) {
        return reply.view('password.njk', { code: link.code, error: req.query.p ? 'Incorrect password.' : null })
      }
    }

    const items = db.all(
      'SELECT * FROM bookmark_items WHERE link_id = ? ORDER BY folder, sort_order, id',
      link.id
    )
    return reply.view('bookmark-view.njk', { link, items })
  })
}

export default fp(bookmarksPlugin, { name: 'bookmarks' })
