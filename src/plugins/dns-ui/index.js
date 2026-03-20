import fp from 'fastify-plugin'
import { requireAuth } from '../../core/auth.js'
import { hashToken, generateToken } from '../../core/auth.js'
import config from '../../config.js'

async function dnsUiPlugin(fastify) {
  const db = fastify.db

  fastify.get('/d', { preHandler: requireAuth }, async (req, reply) => {
    const records = db.all(
      'SELECT * FROM dns_records WHERE user_id = ? ORDER BY subdomain',
      req.session.userId
    )
    return reply.view('dns-ui.njk', { records, baseDomain: config.BASE_DOMAIN })
  })

  // Add or update a DNS record
  fastify.post('/d', { preHandler: requireAuth }, async (req, reply) => {
    const { subdomain = '', ip4 = '', ip6 = '' } = req.body || {}
    const sub = subdomain.trim().toLowerCase().replace(/[^a-z0-9-]/g, '')

    if (!sub || sub.length < 3) {
      req.session.flash = { type: 'error', message: 'Subdomain must be at least 3 characters (letters, numbers, hyphens).' }
      return reply.redirect('/d')
    }
    if (!ip4.trim() && !ip6.trim()) {
      req.session.flash = { type: 'error', message: 'Provide at least one IP address.' }
      return reply.redirect('/d')
    }

    // Check if subdomain belongs to this user (or is unclaimed)
    const existing = db.get('SELECT * FROM dns_records WHERE subdomain = ?', sub)
    if (existing && existing.user_id !== req.session.userId) {
      req.session.flash = { type: 'error', message: 'That subdomain is taken.' }
      return reply.redirect('/d')
    }

    const secretKey = existing?.secret_key_hash ? null : generateToken(32)
    const secretKeyHash = secretKey ? await hashToken(secretKey) : existing?.secret_key_hash

    db.run(
      `INSERT INTO dns_records(subdomain, user_id, ip4, ip6, secret_key_hash, updated_at)
       VALUES(?,?,?,?,?,?)
       ON CONFLICT(subdomain) DO UPDATE SET
         ip4 = excluded.ip4, ip6 = excluded.ip6, updated_at = excluded.updated_at`,
      sub, req.session.userId,
      ip4.trim() || null, ip6.trim() || null,
      secretKeyHash, Date.now()
    )

    if (fastify.invalidateDnsCache) fastify.invalidateDnsCache()

    if (secretKey) {
      req.session.flash = {
        type: 'success',
        message: `Record created! Your update key (save it, shown once): ${secretKey}`
      }
    } else {
      req.session.flash = { type: 'success', message: 'Record updated.' }
    }
    return reply.redirect('/d')
  })

  // Delete a record
  fastify.post('/d/delete/:id', { preHandler: requireAuth }, async (req, reply) => {
    db.run(
      'DELETE FROM dns_records WHERE id = ? AND user_id = ?',
      req.params.id, req.session.userId
    )
    if (fastify.invalidateDnsCache) fastify.invalidateDnsCache()
    req.session.flash = { type: 'success', message: 'Record deleted.' }
    return reply.redirect('/d')
  })

  // Dynamic update endpoint — for use in scripts/cron
  // GET /d/update?host=sub&key=secret&ip=1.2.3.4
  fastify.get('/d/update', async (req, reply) => {
    const { host, key, ip, ip6 } = req.query
    if (!host || !key) return reply.code(400).send('Missing host or key')

    const record = db.get('SELECT * FROM dns_records WHERE subdomain = ?', host)
    if (!record) return reply.code(404).send('Not found')

    const { verifyToken } = await import('../../core/auth.js')
    const valid = await verifyToken(key, record.secret_key_hash)
    if (!valid) return reply.code(403).send('Forbidden')

    db.run(
      'UPDATE dns_records SET ip4 = ?, ip6 = ?, updated_at = ? WHERE id = ?',
      ip || record.ip4, ip6 || record.ip6, Date.now(), record.id
    )
    if (fastify.invalidateDnsCache) fastify.invalidateDnsCache()
    return reply.send('OK')
  })
}

export default fp(dnsUiPlugin, { name: 'dns-ui' })
