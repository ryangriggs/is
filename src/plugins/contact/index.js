import fp from 'fastify-plugin'
import { stripTags } from '../../core/scanner.js'
import { getAdForOwner } from '../../core/ads.js'

async function contactPlugin(fastify) {
  const db = fastify.db

  fastify.get('/contact', async (req, reply) => {
    const ad = getAdForOwner(req.session.userId || null, db)
    return reply.view('contact.njk', { ad })
  })

  fastify.post('/contact', async (req, reply) => {
    const { name = '', email = '', subject = '', body = '', website = '' } = req.body || {}
    // Honeypot: bots fill hidden fields; silently succeed without storing anything
    if (website) {
      req.session.flash = { type: 'success', message: 'Message sent. Thank you!' }
      return reply.redirect('/contact')
    }
    const ad = getAdForOwner(req.session.userId || null, db)
    const cleanBody = stripTags(body).slice(0, 4000)
    if (!cleanBody.trim()) {
      return reply.view('contact.njk', { error: 'Message cannot be empty.', name, email, subject, ad })
    }
    db.run(
      `INSERT INTO messages(name, email, subject, body, ip, created_at) VALUES(?,?,?,?,?,?)`,
      stripTags(name).slice(0, 100),
      stripTags(email).slice(0, 200),
      stripTags(subject).slice(0, 200),
      cleanBody,
      req.ip,
      Date.now()
    )
    req.session.flash = { type: 'success', message: 'Message sent. Thank you!' }
    return reply.redirect('/contact')
  })
}

export default fp(contactPlugin, { name: 'contact' })
