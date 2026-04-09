import fp from 'fastify-plugin'
import { createChallenge, verifySolution } from 'altcha-lib'
import { stripTags } from '../../core/scanner.js'
import { getAdForOwner } from '../../core/ads.js'
import config from '../../config.js'

const ALTCHA_EXPIRY_MS = 10 * 60 * 1000 // 10 minutes

async function contactPlugin(fastify) {
  const db = fastify.db

  fastify.get('/altcha-challenge', async (req, reply) => {
    const challenge = await createChallenge({
      hmacKey: config.SESSION_SECRET,
      maxNumber: 100000,
      expires: new Date(Date.now() + ALTCHA_EXPIRY_MS),
    })
    return reply.send(challenge)
  })

  fastify.get('/contact', async (req, reply) => {
    const ad = getAdForOwner(req.session.userId || null, db)
    return reply.view('contact.njk', { ad })
  })

  fastify.post('/contact', async (req, reply) => {
    const { name = '', email = '', subject = '', body = '', website = '', altcha = '' } = req.body || {}
    // Honeypot: bots fill hidden fields; silently succeed without storing anything
    if (website) {
      req.session.flash = { type: 'success', message: 'Message sent. Thank you!' }
      return reply.redirect('/contact')
    }
    const ad = getAdForOwner(req.session.userId || null, db)

    // ALTCHA verification for guests
    if (!req.session.userId) {
      const valid = altcha && await verifySolution(altcha, config.SESSION_SECRET).catch(() => false)
      if (!valid) {
        return reply.view('contact.njk', { error: 'Please complete the CAPTCHA.', name, email, subject, body, ad })
      }
    }

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
