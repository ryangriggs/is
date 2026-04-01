import fp from 'fastify-plugin'
import path from 'path'
import { readFile, writeFile, unlink } from 'fs/promises'
import { nanoid } from 'nanoid'
import { createLink } from '../../core/links.js'
import { requireAuth } from '../../core/auth.js'
import { getAdForOwner } from '../../core/ads.js'

const MAX_PASTE_BYTES = 512 * 1024
const PASTE_DIR = path.join(process.cwd(), 'data', 'pastes')

async function htmlPastePlugin(fastify) {
  const db = fastify.db
  const hooks = fastify.hooks

  fastify.get('/h', async (req, reply) => {
    const ad = getAdForOwner(req.session.userId || null, db)
    return reply.view('html-create.njk', { ad })
  })

  fastify.post('/h', async (req, reply) => {
    const { content = '', title = '', is_private, burn_on_read, expires_at } = req.body || {}
    const ad = getAdForOwner(req.session.userId || null, db)

    if (!content.trim()) {
      return reply.view('html-create.njk', { error: 'Content cannot be empty.', content, title, ad })
    }
    const byteSize = Buffer.byteLength(content, 'utf8')
    if (byteSize > MAX_PASTE_BYTES) {
      return reply.view('html-create.njk', { error: 'Paste too large (max 512 KB).', content, title, ad })
    }

    const expiresAtMs = expires_at ? new Date(expires_at).getTime() : null
    const filename = nanoid(16) + '.html'
    const filepath = path.join(PASTE_DIR, filename)

    await writeFile(filepath, content, 'utf8')

    let link, plainToken
    try {
      ;({ link, plainToken } = await createLink(db, hooks, {
        type: 'html',
        destination: filename,
        title: title.trim() || null,
        isPrivate: is_private === '1',
        burnOnRead: burn_on_read === '1',
        expiresAt: expiresAtMs && !isNaN(expiresAtMs) ? expiresAtMs : null,
        ownerId: req.session.userId || null,
        req,
      }))
    } catch (err) {
      await unlink(filepath).catch(() => {})
      throw err
    }

    db.run('UPDATE links SET file_size = ? WHERE id = ?', byteSize, link.id)
    if (!req.session.userId) req.session.pendingClaimCode = link.code
    return reply.redirect(`/success?code=${link.code}${plainToken ? '&token=' + plainToken : ''}`)
  })

  // ----------------------------------------------------------------
  // GET /h/:code/edit — edit form (owner only)
  // ----------------------------------------------------------------
  fastify.get('/h/:code/edit', { preHandler: requireAuth }, async (req, reply) => {
    const link = db.get("SELECT * FROM links WHERE code = ? AND type = 'html'", req.params.code)
    if (!link) { reply.code(404); return reply.view('errors/404.njk', {}) }
    if (link.owner_id !== req.session.userId) { reply.code(403); return reply.view('errors/403.njk', {}) }
    const content = await readFile(path.join(PASTE_DIR, link.destination), 'utf8')
    return reply.view('html-create.njk', {
      title: link.title || '',
      content,
      isPrivate: link.is_private,
      editCode: link.code,
    })
  })

  // ----------------------------------------------------------------
  // POST /h/:code/edit — save edits (owner only)
  // ----------------------------------------------------------------
  fastify.post('/h/:code/edit', { preHandler: requireAuth }, async (req, reply) => {
    const link = db.get("SELECT * FROM links WHERE code = ? AND type = 'html'", req.params.code)
    if (!link) { reply.code(404); return reply.view('errors/404.njk', {}) }
    if (link.owner_id !== req.session.userId) { reply.code(403); return reply.view('errors/403.njk', {}) }
    const { content = '', title = '', is_private } = req.body || {}
    if (!content.trim()) {
      return reply.view('html-create.njk', { error: 'Content cannot be empty.', content, title, editCode: link.code })
    }
    const byteSize = Buffer.byteLength(content, 'utf8')
    if (byteSize > MAX_PASTE_BYTES) {
      return reply.view('html-create.njk', { error: 'Paste too large (max 512 KB).', content, title, editCode: link.code })
    }
    await writeFile(path.join(PASTE_DIR, link.destination), content, 'utf8')
    db.run(
      'UPDATE links SET title = ?, is_private = ?, file_size = ? WHERE id = ?',
      title.trim() || null, is_private === '1' ? 1 : 0, byteSize, link.id
    )
    req.session.flash = { type: 'success', message: 'HTML paste updated.' }
    return reply.redirect(`/${link.code}`)
  })
}

export default fp(htmlPastePlugin, { name: 'html-paste' })
