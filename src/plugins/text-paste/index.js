import fp from 'fastify-plugin'
import { createLink } from '../../core/links.js'
import { requireAuth } from '../../core/auth.js'
import { getAdForOwner } from '../../core/ads.js'

const MAX_PASTE_BYTES = 512 * 1024

async function textPastePlugin(fastify) {
  const db = fastify.db
  const hooks = fastify.hooks

  fastify.get('/t', async (req, reply) => {
    const ad = getAdForOwner(req.session.userId || null, db)
    return reply.view('text-create.njk', { ad })
  })

  fastify.post('/t', async (req, reply) => {
    const { content = '', title = '', is_private, is_encrypted, burn_on_read, expires_at } = req.body || {}
    const wantsJson = req.headers.accept?.includes('application/json')
    const ad = getAdForOwner(req.session.userId || null, db)
    if (!content.trim()) {
      if (wantsJson) return reply.code(400).send({ error: 'Content cannot be empty.' })
      return reply.view('text-create.njk', { error: 'Content cannot be empty.', content, title, ad })
    }
    const byteSize = Buffer.byteLength(content, 'utf8')
    if (byteSize > MAX_PASTE_BYTES) {
      if (wantsJson) return reply.code(400).send({ error: 'Paste too large (max 512 KB).' })
      return reply.view('text-create.njk', { error: 'Paste too large (max 512 KB).', content, title, ad })
    }
    const expiresAtMs = expires_at ? new Date(expires_at).getTime() : null
    const { link, plainToken } = await createLink(db, hooks, {
      type: 'text',
      destination: content,
      title: title.trim() || null,
      isPrivate: is_private === '1',
      isEncrypted: is_encrypted === '1',
      burnOnRead: burn_on_read === '1',
      expiresAt: expiresAtMs && !isNaN(expiresAtMs) ? expiresAtMs : null,
      ownerId: req.session.userId || null,
      req,
    })
    db.run('UPDATE links SET file_size = ? WHERE id = ?', byteSize, link.id)
    if (!req.session.userId) req.session.pendingClaimCode = link.code
    if (wantsJson) return reply.send({ code: link.code })
    return reply.redirect(`/success?code=${link.code}${plainToken ? '&token=' + plainToken : ''}`)
  })

  // ----------------------------------------------------------------
  // GET /t/:code/edit — edit form (owner only)
  // ----------------------------------------------------------------
  fastify.get('/t/:code/edit', { preHandler: requireAuth }, async (req, reply) => {
    const link = db.get("SELECT * FROM links WHERE code = ? AND type = 'text'", req.params.code)
    if (!link) { reply.code(404); return reply.view('errors/404.njk', {}) }
    if (link.owner_id !== req.session.userId) { reply.code(403); return reply.view('errors/403.njk', {}) }
    return reply.view('text-create.njk', {
      title: link.title || '',
      content: link.destination,
      isPrivate: link.is_private,
      editCode: link.code,
    })
  })

  // ----------------------------------------------------------------
  // POST /t/:code/edit — save edits (owner only)
  // ----------------------------------------------------------------
  fastify.post('/t/:code/edit', { preHandler: requireAuth }, async (req, reply) => {
    const link = db.get("SELECT * FROM links WHERE code = ? AND type = 'text'", req.params.code)
    if (!link) { reply.code(404); return reply.view('errors/404.njk', {}) }
    if (link.owner_id !== req.session.userId) { reply.code(403); return reply.view('errors/403.njk', {}) }
    const { content = '', title = '', is_private } = req.body || {}
    if (!content.trim()) {
      return reply.view('text-create.njk', { error: 'Content cannot be empty.', content, title, editCode: link.code })
    }
    const byteSize = Buffer.byteLength(content, 'utf8')
    if (byteSize > MAX_PASTE_BYTES) {
      return reply.view('text-create.njk', { error: 'Paste too large (max 512 KB).', content, title, editCode: link.code })
    }
    db.run(
      'UPDATE links SET destination = ?, title = ?, is_private = ?, file_size = ? WHERE id = ?',
      content, title.trim() || null, is_private === '1' ? 1 : 0, byteSize, link.id
    )
    req.session.flash = { type: 'success', message: 'Paste updated.' }
    return reply.redirect(`/${link.code}`)
  })
}

export default fp(textPastePlugin, { name: 'text-paste' })
