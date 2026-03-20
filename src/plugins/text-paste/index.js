import fp from 'fastify-plugin'
import { createLink } from '../../core/links.js'

const MAX_PASTE_BYTES = 512 * 1024

async function textPastePlugin(fastify) {
  const db = fastify.db
  const hooks = fastify.hooks

  fastify.get('/t', async (req, reply) => {
    return reply.view('text-create.njk', {})
  })

  fastify.post('/t', async (req, reply) => {
    const { content = '', title = '', is_private } = req.body || {}
    if (!content.trim()) {
      return reply.view('text-create.njk', { error: 'Content cannot be empty.', content, title })
    }
    const byteSize = Buffer.byteLength(content, 'utf8')
    if (byteSize > MAX_PASTE_BYTES) {
      return reply.view('text-create.njk', { error: 'Paste too large (max 512 KB).', content, title })
    }
    const { link, plainToken } = await createLink(db, hooks, {
      type: 'text',
      destination: content,
      title: title.trim() || null,
      isPrivate: is_private === '1',
      ownerId: req.session.userId || null,
      req,
    })
    db.run('UPDATE links SET file_size = ? WHERE id = ?', byteSize, link.id)
    if (!req.session.userId) req.session.pendingClaimCode = link.code
    return reply.redirect(`/success?code=${link.code}${plainToken ? '&token=' + plainToken : ''}`)
  })
}

export default fp(textPastePlugin, { name: 'text-paste' })
