import fp from 'fastify-plugin'
import { createLink } from '../../core/links.js'

const MAX_PASTE_BYTES = 512 * 1024 // 512 KB

async function htmlPastePlugin(fastify) {
  const db = fastify.db
  const hooks = fastify.hooks

  fastify.get('/h', async (req, reply) => {
    return reply.view('html-create.njk', {})
  })

  fastify.post('/h', async (req, reply) => {
    const { content = '', title = '', is_private } = req.body || {}
    if (!content.trim()) {
      return reply.view('html-create.njk', { error: 'Content cannot be empty.', content, title })
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_PASTE_BYTES) {
      return reply.view('html-create.njk', { error: 'Paste too large (max 512 KB).', content, title })
    }
    const { link, plainToken } = await createLink(db, hooks, {
      type: 'html',
      destination: content,
      title: title.trim() || null,
      isPrivate: is_private === '1',
      ownerId: req.session.userId || null,
      req,
    })
    return reply.redirect(`/success?code=${link.code}${plainToken ? '&token=' + plainToken : ''}`)
  })
}

export default fp(htmlPastePlugin, { name: 'html-paste' })
