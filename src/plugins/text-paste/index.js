import fp from 'fastify-plugin'
import { createLink } from '../../core/links.js'
import config from '../../config.js'

const MAX_PASTE_BYTES = 512 * 1024 // 512 KB

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
    if (Buffer.byteLength(content, 'utf8') > MAX_PASTE_BYTES) {
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
    const qs = plainToken ? `?token=${plainToken}` : ''
    return reply.redirect(`/success?code=${link.code}${plainToken ? '&token=' + plainToken : ''}`)
  })
}

export default fp(textPastePlugin, { name: 'text-paste' })
