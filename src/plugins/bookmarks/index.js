import fp from 'fastify-plugin'
import { createLink } from '../../core/links.js'
import { requireAuth } from '../../core/auth.js'
import config from '../../config.js'

async function bookmarksPlugin(fastify) {
  const db = fastify.db
  const hooks = fastify.hooks

  // List collections
  fastify.get('/b', { preHandler: requireAuth }, async (req, reply) => {
    const collections = db.all(
      `SELECT l.*, COUNT(bi.id) as item_count
       FROM links l
       LEFT JOIN bookmark_items bi ON bi.link_id = l.id
       WHERE l.owner_id = ? AND l.type = 'bookmark'
       GROUP BY l.id ORDER BY l.created_at DESC`,
      req.session.userId
    )
    return reply.view('bookmarks.njk', { collections })
  })

  // Create collection
  fastify.post('/b', { preHandler: requireAuth }, async (req, reply) => {
    const { title = '', is_private } = req.body || {}
    if (!title.trim()) {
      const collections = db.all(
        `SELECT l.*, COUNT(bi.id) as item_count
         FROM links l LEFT JOIN bookmark_items bi ON bi.link_id = l.id
         WHERE l.owner_id = ? AND l.type = 'bookmark'
         GROUP BY l.id ORDER BY l.created_at DESC`,
        req.session.userId
      )
      return reply.view('bookmarks.njk', { collections, error: 'Title is required.' })
    }
    const { link } = await createLink(db, hooks, {
      type: 'bookmark',
      destination: null,
      title: title.trim(),
      isPrivate: is_private === '1',
      ownerId: req.session.userId,
      req,
    })
    return reply.redirect(`/b/${link.code}`)
  })

  // Manage a collection
  fastify.get('/b/:code', { preHandler: requireAuth }, async (req, reply) => {
    const link = db.get(
      `SELECT * FROM links WHERE code = ? AND type = 'bookmark' AND owner_id = ?`,
      req.params.code, req.session.userId
    )
    if (!link) { reply.code(404); return reply.view('errors/404.njk', {}) }

    const items = db.all(
      'SELECT * FROM bookmark_items WHERE link_id = ? ORDER BY folder, sort_order, id',
      link.id
    )
    const shortUrl = `https://${config.BASE_DOMAIN}/${link.code}`
    return reply.view('bookmark-manage.njk', { link, items, shortUrl })
  })

  // Add item to collection
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
    const count = db.get('SELECT COUNT(*) as n FROM bookmark_items WHERE link_id = ?', link.id)
    db.run(
      `INSERT INTO bookmark_items(link_id, url, title, description, folder, sort_order) VALUES(?,?,?,?,?,?)`,
      link.id, url.trim(), title.trim() || url.trim(),
      description.trim() || null, folder.trim() || null, count.n
    )
    return reply.redirect(`/b/${link.code}`)
  })

  // Delete item
  fastify.post('/b/:code/delete/:itemId', { preHandler: requireAuth }, async (req, reply) => {
    const link = db.get(
      `SELECT * FROM links WHERE code = ? AND type = 'bookmark' AND owner_id = ?`,
      req.params.code, req.session.userId
    )
    if (!link) { reply.code(404); return reply.view('errors/404.njk', {}) }
    db.run('DELETE FROM bookmark_items WHERE id = ? AND link_id = ?', req.params.itemId, link.id)
    return reply.redirect(`/b/${link.code}`)
  })

  // Delete collection
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

  // Toggle public/private
  fastify.post('/b/:code/visibility', { preHandler: requireAuth }, async (req, reply) => {
    const link = db.get(
      `SELECT * FROM links WHERE code = ? AND type = 'bookmark' AND owner_id = ?`,
      req.params.code, req.session.userId
    )
    if (!link) { reply.code(404); return reply.view('errors/404.njk', {}) }
    db.run('UPDATE links SET is_private = ? WHERE id = ?', link.is_private ? 0 : 1, link.id)
    return reply.redirect(`/b/${link.code}`)
  })
}

export default fp(bookmarksPlugin, { name: 'bookmarks' })
