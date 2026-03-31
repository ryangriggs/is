import fp from 'fastify-plugin'
import { requireAuth } from '../../core/auth.js'
import { hashToken, generateToken, verifyToken } from '../../core/auth.js'
import config from '../../config.js'
import { getTierForUser } from '../../core/tiers.js'
import { getAdForOwner } from '../../core/ads.js'

const dynApex = () => `${config.DYN_SUBDOMAIN}.${config.BASE_DOMAIN}`

function isValidIp4(ip) {
  if (!ip) return true
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) return false
  return ip.split('.').every(n => Number(n) >= 0 && Number(n) <= 255)
}

function isValidIp6(ip) {
  if (!ip) return true
  return /^[0-9a-fA-F:]+$/.test(ip) && ip.includes(':')
}

async function dnsUiPlugin(fastify) {
  const db = fastify.db

  fastify.get('/d', { preHandler: requireAuth }, async (req, reply) => {
    const records = db.all(
      'SELECT * FROM dns_records WHERE user_id = ? ORDER BY subdomain',
      req.session.userId
    )
    const isPaid = req.session.subscriptionTier === 'paid' || req.session.role === 'admin'
    const ad = getAdForOwner(req.session.userId || null, db)
    return reply.view('dns-ui.njk', { records, baseDomain: config.BASE_DOMAIN, dynApex: dynApex(), isPaid, ad })
  })

  fastify.post('/d', { preHandler: requireAuth }, async (req, reply) => {
    const { subdomain = '', ip4 = '', ip6 = '', ttl } = req.body || {}
    const sub = subdomain.trim().toLowerCase().replace(/[^a-z0-9-]/g, '')

    if (!sub || sub.length < 1) {
      req.session.flash = { type: 'error', message: 'Subdomain must be at least 1 character.' }
      return reply.redirect('/d')
    }
    if (!ip4.trim() && !ip6.trim()) {
      req.session.flash = { type: 'error', message: 'Provide at least one IP address.' }
      return reply.redirect('/d')
    }
    if (!isValidIp4(ip4.trim())) {
      req.session.flash = { type: 'error', message: 'Invalid IPv4 address.' }
      return reply.redirect('/d')
    }
    if (!isValidIp6(ip6.trim())) {
      req.session.flash = { type: 'error', message: 'Invalid IPv6 address.' }
      return reply.redirect('/d')
    }

    const existing = db.get('SELECT * FROM dns_records WHERE subdomain = ?', sub)
    if (existing && existing.user_id !== req.session.userId) {
      req.session.flash = { type: 'error', message: 'That subdomain is taken.' }
      return reply.redirect('/d')
    }

    // DDNS entry limit check (only when creating a new record)
    if (!existing) {
      const tier = getTierForUser(req.session.userId, db)
      if (tier.max_ddns_entries > 0) {
        const { n } = db.get('SELECT COUNT(*) as n FROM dns_records WHERE user_id = ?', req.session.userId)
        if (n >= tier.max_ddns_entries) {
          req.session.flash = { type: 'error', message: `DDNS entry limit reached (${tier.max_ddns_entries}). Upgrade your plan.` }
          return reply.redirect('/d')
        }
      }
    }

    const isPaid = req.session.subscriptionTier === 'paid' || req.session.role === 'admin'
    const ttlValue = isPaid && ttl ? Math.max(30, Math.min(86400, parseInt(ttl) || 300)) : 300

    const secretKey = existing?.secret_key_hash ? null : generateToken(32)
    const secretKeyHash = secretKey ? await hashToken(secretKey) : existing?.secret_key_hash

    db.run(
      `INSERT INTO dns_records(subdomain, user_id, ip4, ip6, ttl, secret_key_hash, updated_at)
       VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(subdomain) DO UPDATE SET
         ip4 = excluded.ip4, ip6 = excluded.ip6, ttl = excluded.ttl, updated_at = excluded.updated_at`,
      sub, req.session.userId,
      ip4.trim() || null, ip6.trim() || null,
      ttlValue, secretKeyHash, Date.now()
    )

    if (fastify.invalidateDnsCache) fastify.invalidateDnsCache()

    if (secretKey) {
      req.session.flash = {
        type: 'key',
        label: 'DNS Update Key',
        sublabel: `${sub}.${dynApex()} — shown once, save it now`,
        key: secretKey,
      }
    } else {
      req.session.flash = { type: 'success', message: 'Record updated.' }
    }
    return reply.redirect('/d')
  })

  // Edit IP only (for existing record)
  fastify.post('/d/:id/edit-ip', { preHandler: requireAuth }, async (req, reply) => {
    const record = db.get('SELECT * FROM dns_records WHERE id = ? AND user_id = ?',
      Number(req.params.id), req.session.userId)
    if (!record) { reply.code(404); return reply.view('errors/404.njk', {}) }

    const { ip4 = '', ip6 = '', ttl } = req.body || {}
    if (!isValidIp4(ip4.trim())) {
      req.session.flash = { type: 'error', message: 'Invalid IPv4 address.' }
      return reply.redirect('/d')
    }
    if (!isValidIp6(ip6.trim())) {
      req.session.flash = { type: 'error', message: 'Invalid IPv6 address.' }
      return reply.redirect('/d')
    }
    const isPaid = req.session.subscriptionTier === 'paid' || req.session.role === 'admin'
    const ttlValue = isPaid && ttl ? Math.max(30, Math.min(86400, parseInt(ttl) || record.ttl)) : record.ttl

    db.run(
      'UPDATE dns_records SET ip4 = ?, ip6 = ?, ttl = ?, updated_at = ? WHERE id = ?',
      ip4.trim() || null, ip6.trim() || null, ttlValue, Date.now(), record.id
    )
    if (fastify.invalidateDnsCache) fastify.invalidateDnsCache()
    req.session.flash = { type: 'success', message: 'Record updated.' }
    return reply.redirect('/d')
  })

  fastify.post('/d/delete/:id', { preHandler: requireAuth }, async (req, reply) => {
    db.run('DELETE FROM dns_records WHERE id = ? AND user_id = ?', Number(req.params.id), req.session.userId)
    if (fastify.invalidateDnsCache) fastify.invalidateDnsCache()
    req.session.flash = { type: 'success', message: 'Record deleted.' }
    return reply.redirect('/d')
  })

  // Dynamic update endpoint: GET /d/update?host=sub&key=secret&ip=1.2.3.4
  fastify.get('/d/update', async (req, reply) => {
    const { host, key, ip, ip6 } = req.query
    if (!host || !key) return reply.code(400).send('Missing host or key')

    const record = db.get('SELECT * FROM dns_records WHERE subdomain = ?', host)
    if (!record) return reply.code(404).send('Not found')

    const valid = await verifyToken(key, record.secret_key_hash)
    if (!valid) return reply.code(403).send('Forbidden')

    const newIp4 = ip || req.ip || record.ip4
    const newIp6 = ip6 || record.ip6

    db.run(
      'UPDATE dns_records SET ip4 = ?, ip6 = ?, updated_at = ? WHERE id = ?',
      newIp4, newIp6, Date.now(), record.id
    )
    if (fastify.invalidateDnsCache) fastify.invalidateDnsCache()
    return reply.send('OK')
  })
}

export default fp(dnsUiPlugin, { name: 'dns-ui' })
