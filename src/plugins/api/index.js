import fp from 'fastify-plugin'
import { createLink } from '../../core/links.js'
import { normalizeCode } from '../../core/shortcode.js'
import { generateToken, hashTokenFast } from '../../core/auth.js'
import config from '../../config.js'

async function apiPlugin(fastify) {
  const db = fastify.db
  const hooks = fastify.hooks

  // Auth middleware for API routes
  async function apiAuth(req, reply) {
    const header = req.headers['authorization'] || ''
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null
    if (!token) return reply.code(401).send({ error: 'Missing API token' })

    const hash = hashTokenFast(token)
    const row = db.get('SELECT * FROM api_tokens WHERE token_hash = ?', hash)
    if (!row) return reply.code(401).send({ error: 'Invalid API token' })

    db.run('UPDATE api_tokens SET last_used = ? WHERE id = ?', Date.now(), row.id)
    req.apiUserId = row.user_id
  }

  // GET /a — API info
  fastify.get('/a', async (req, reply) => {
    return reply.send({
      name: config.SITE_NAME + ' API',
      version: '1',
      endpoints: [
        'GET /a/links',
        'POST /a/links',
        'GET /a/links/:code',
        'DELETE /a/links/:code',
        'GET /a/tokens',
        'POST /a/tokens',
        'DELETE /a/tokens/:id',
      ]
    })
  })

  // GET /a/links
  fastify.get('/a/links', { preHandler: apiAuth }, async (req, reply) => {
    const page = Math.max(1, parseInt(req.query.page) || 1)
    const limit = Math.min(100, parseInt(req.query.limit) || 20)
    const offset = (page - 1) * limit
    const links = db.all(
      `SELECT code, type, destination, title, is_active, is_private, created_at, expires_at,
              (SELECT COUNT(*) FROM tracking WHERE link_id = links.id) as visits
       FROM links WHERE owner_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      req.apiUserId, limit, offset
    )
    return reply.send({ links, page, limit })
  })

  // POST /a/links
  fastify.post('/a/links', { preHandler: apiAuth }, async (req, reply) => {
    const { url, title } = req.body || {}
    if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
      return reply.code(400).send({ error: 'Valid url is required' })
    }
    const { link } = await createLink(db, hooks, {
      type: 'url',
      destination: url,
      title: title || null,
      ownerId: req.apiUserId,
      req,
    })
    return reply.code(201).send({
      code: link.code,
      short_url: `https://${config.BASE_DOMAIN}/${link.code}`,
      destination: link.destination,
      created_at: link.created_at,
    })
  })

  // GET /a/links/:code
  fastify.get('/a/links/:code', { preHandler: apiAuth }, async (req, reply) => {
    const link = db.get(
      `SELECT code, type, destination, title, is_active, is_private, created_at, expires_at,
              (SELECT COUNT(*) FROM tracking WHERE link_id = links.id) as visits
       FROM links WHERE code = ? AND owner_id = ?`,
      normalizeCode(req.params.code), req.apiUserId
    )
    if (!link) return reply.code(404).send({ error: 'Not found' })
    return reply.send({ link })
  })

  // DELETE /a/links/:code
  fastify.delete('/a/links/:code', { preHandler: apiAuth }, async (req, reply) => {
    const result = db.run(
      'DELETE FROM links WHERE code = ? AND owner_id = ?',
      normalizeCode(req.params.code), req.apiUserId
    )
    if (!result.changes) return reply.code(404).send({ error: 'Not found' })
    return reply.send({ ok: true })
  })

  // GET /a/tokens — list own tokens
  fastify.get('/a/tokens', { preHandler: apiAuth }, async (req, reply) => {
    const tokens = db.all(
      'SELECT id, label, last_used, created_at FROM api_tokens WHERE user_id = ?',
      req.apiUserId
    )
    return reply.send({ tokens })
  })

  // POST /a/tokens — create token (also usable from web session via /tokens route in users plugin)
  fastify.post('/a/tokens', { preHandler: apiAuth }, async (req, reply) => {
    const { label = '' } = req.body || {}
    const plain = generateToken(32)
    const hash = hashTokenFast(plain)
    const result = db.run(
      'INSERT INTO api_tokens(user_id, token_hash, label, created_at) VALUES(?,?,?,?)',
      req.apiUserId, hash, label.trim() || null, Date.now()
    )
    return reply.code(201).send({ id: result.lastInsertRowid, token: plain, label })
  })

  // DELETE /a/tokens/:id
  fastify.delete('/a/tokens/:id', { preHandler: apiAuth }, async (req, reply) => {
    const result = db.run(
      'DELETE FROM api_tokens WHERE id = ? AND user_id = ?',
      req.params.id, req.apiUserId
    )
    if (!result.changes) return reply.code(404).send({ error: 'Not found' })
    return reply.send({ ok: true })
  })
}

// Web UI token management (session auth)
// POST /tokens — create token from web UI
// DELETE /tokens/:id — revoke token from web UI

export default fp(apiPlugin, { name: 'api' })
