import fp from 'fastify-plugin'
import { requireAuth, requireAdmin } from '../../core/auth.js'
import { pipeline } from 'stream/promises'
import { createWriteStream } from 'fs'
import { mkdir } from 'fs/promises'
import path from 'path'
import { nanoid } from 'nanoid'

const UPLOADS_DIR = path.join(process.cwd(), 'uploads', 'ads')

async function adsPlugin(fastify) {
  const db = fastify.db

  await mkdir(UPLOADS_DIR, { recursive: true })

  // ----------------------------------------------------------------
  // Public JSON API: GET /ad/next — return a random active approved ad
  // ----------------------------------------------------------------
  fastify.get('/ad/next', async (req, reply) => {
    const ad = db.get(`
      SELECT ai.id, ai.image_path, ac.id as campaign_id, ac.click_url
      FROM ad_images ai
      JOIN ad_campaigns ac ON ac.id = ai.campaign_id
      WHERE ai.is_approved = 1
        AND ac.is_active = 1
        AND (ac.expires_at IS NULL OR ac.expires_at > ?)
      ORDER BY RANDOM()
      LIMIT 1
    `, Date.now())

    if (!ad) return reply.send({})

    return reply.send({
      imageUrl: `/uploads/ads/${ad.image_path}`,
      clickUrl: `/ad/c/${ad.id}`,
    })
  })

  // ----------------------------------------------------------------
  // Click tracking: GET /ad/c/:id — record click and redirect
  // ----------------------------------------------------------------
  fastify.get('/ad/c/:id', async (req, reply) => {
    const ad = db.get(`
      SELECT ai.id, ac.click_url
      FROM ad_images ai
      JOIN ad_campaigns ac ON ac.id = ai.campaign_id
      WHERE ai.id = ?
    `, req.params.id)

    if (!ad || !ad.click_url) {
      reply.code(404); return reply.send('Not found')
    }

    try {
      const gdprSetting = db.get("SELECT value FROM settings WHERE key = 'gdpr_enabled'")
      if (gdprSetting?.value !== 'true' || req.cookies?.gdpr_consent === 'accepted') {
        db.run(
          'INSERT INTO ad_clicks(image_id, ip, clicked_at) VALUES(?,?,?)',
          ad.id, req.ip, Date.now()
        )
      }
    } catch (_) {}

    return reply.redirect(302, ad.click_url)
  })

  // ----------------------------------------------------------------
  // User: GET /ads — list own campaigns
  // ----------------------------------------------------------------
  fastify.get('/ads', { preHandler: requireAuth }, async (req, reply) => {
    const campaigns = db.all(`
      SELECT ac.*, COUNT(ai.id) as image_count
      FROM ad_campaigns ac
      LEFT JOIN ad_images ai ON ai.campaign_id = ac.id
      WHERE ac.owner_id = ?
      GROUP BY ac.id
      ORDER BY ac.created_at DESC
    `, req.session.userId)
    return reply.view('ads/index.njk', { campaigns })
  })

  // ----------------------------------------------------------------
  // User: POST /ads — create campaign
  // ----------------------------------------------------------------
  fastify.post('/ads', { preHandler: requireAuth }, async (req, reply) => {
    const { name = '', click_url = '', expires_at = '' } = req.body || {}

    if (!name.trim()) {
      req.session.flash = { type: 'error', message: 'Campaign name is required.' }
      return reply.redirect('/ads')
    }
    let parsedClickUrl
    try {
      parsedClickUrl = new URL(click_url.trim())
      if (parsedClickUrl.protocol !== 'http:' && parsedClickUrl.protocol !== 'https:') throw new Error()
    } catch {
      req.session.flash = { type: 'error', message: 'A valid http/https click URL is required.' }
      return reply.redirect('/ads')
    }

    const expiresAt = expires_at ? new Date(expires_at).getTime() : null

    const info = db.run(
      `INSERT INTO ad_campaigns(owner_id, name, click_url, is_active, expires_at, created_at)
       VALUES(?,?,?,0,?,?)`,
      req.session.userId, name.trim(), parsedClickUrl.href, expiresAt, Date.now()
    )
    req.session.flash = { type: 'success', message: 'Campaign created. Upload an image to get started.' }
    return reply.redirect(`/ads/${info.lastInsertRowid}`)
  })

  // ----------------------------------------------------------------
  // User: GET /ads/:id — view/manage campaign
  // ----------------------------------------------------------------
  fastify.get('/ads/:id', { preHandler: requireAuth }, async (req, reply) => {
    const campaign = db.get(
      'SELECT * FROM ad_campaigns WHERE id = ? AND owner_id = ?',
      req.params.id, req.session.userId
    )
    if (!campaign) { reply.code(404); return reply.view('errors/404.njk', {}) }

    const images = db.all(`
      SELECT ai.*,
             COUNT(DISTINCT ac.id) as click_count,
             COUNT(DISTINCT imp.id) as impression_count
      FROM ad_images ai
      LEFT JOIN ad_clicks ac ON ac.image_id = ai.id
      LEFT JOIN ad_impressions imp ON imp.image_id = ai.id
      WHERE ai.campaign_id = ?
      GROUP BY ai.id
      ORDER BY ai.created_at DESC
    `, campaign.id)
    const clicks = db.get(
      `SELECT COUNT(*) as n FROM ad_clicks ac
       JOIN ad_images img ON img.id = ac.image_id
       WHERE img.campaign_id = ?`,
      campaign.id
    )
    const impressions = db.get(
      `SELECT COUNT(*) as n FROM ad_impressions imp
       JOIN ad_images img ON img.id = imp.image_id
       WHERE img.campaign_id = ?`,
      campaign.id
    )
    return reply.view('ads/campaign.njk', { campaign, images, clicks: clicks?.n || 0, impressions: impressions?.n || 0 })
  })

  // ----------------------------------------------------------------
  // User: POST /ads/:id/upload — upload image to campaign
  // ----------------------------------------------------------------
  fastify.post('/ads/:id/upload', { preHandler: requireAuth }, async (req, reply) => {
    const campaign = db.get(
      'SELECT * FROM ad_campaigns WHERE id = ? AND owner_id = ?',
      req.params.id, req.session.userId
    )
    if (!campaign) { reply.code(404); return reply.view('errors/404.njk', {}) }

    let fileData = null
    let altText = ''

    for await (const part of req.parts()) {
      if (part.type === 'file' && part.fieldname === 'image') {
        const ext = path.extname(part.filename || '').toLowerCase() || '.jpg'
        const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp']
        if (!allowed.includes(ext)) {
          req.session.flash = { type: 'error', message: 'Only image files are allowed.' }
          return reply.redirect(`/ads/${campaign.id}`)
        }
        const filename = nanoid(16) + ext
        const dest = path.join(UPLOADS_DIR, filename)
        await pipeline(part.file, createWriteStream(dest))
        fileData = filename
      } else if (part.type === 'field' && part.fieldname === 'alt_text') {
        altText = part.value || ''
      }
    }

    if (!fileData) {
      req.session.flash = { type: 'error', message: 'No image file received.' }
      return reply.redirect(`/ads/${campaign.id}`)
    }

    db.run(
      `INSERT INTO ad_images(campaign_id, image_path, alt_text, is_approved, created_at) VALUES(?,?,?,0,?)`,
      campaign.id, fileData, altText.trim() || null, Date.now()
    )
    req.session.flash = { type: 'success', message: 'Image uploaded. Awaiting admin approval.' }
    return reply.redirect(`/ads/${campaign.id}`)
  })

  // ----------------------------------------------------------------
  // User: POST /ads/:id/delete — delete campaign
  // ----------------------------------------------------------------
  fastify.post('/ads/:id/delete', { preHandler: requireAuth }, async (req, reply) => {
    const campaign = db.get(
      'SELECT * FROM ad_campaigns WHERE id = ? AND owner_id = ?',
      req.params.id, req.session.userId
    )
    if (!campaign) { reply.code(404); return reply.view('errors/404.njk', {}) }

    db.run('DELETE FROM ad_images WHERE campaign_id = ?', campaign.id)
    db.run('DELETE FROM ad_campaigns WHERE id = ?', campaign.id)
    req.session.flash = { type: 'success', message: 'Campaign deleted.' }
    return reply.redirect('/ads')
  })

  // ----------------------------------------------------------------
  // Admin: GET /admin/ads — list all campaigns
  // ----------------------------------------------------------------
  fastify.get('/admin/ads', { preHandler: requireAdmin }, async (req, reply) => {
    const campaigns = db.all(`
      SELECT ac.*, u.email, u.username, u.display_name,
             COUNT(ai.id) as image_count,
             SUM(CASE WHEN ai.is_approved = 1 THEN 1 ELSE 0 END) as approved_count,
             SUM(CASE WHEN ai.is_approved = 0 THEN 1 ELSE 0 END) as pending_count
      FROM ad_campaigns ac
      LEFT JOIN users u ON u.id = ac.owner_id
      LEFT JOIN ad_images ai ON ai.campaign_id = ac.id
      GROUP BY ac.id
      ORDER BY ac.created_at DESC
    `)

    const pendingImages = db.all(`
      SELECT ai.*, ac.id as campaign_id, ac.name as campaign_name, u.email, u.username, u.display_name
      FROM ad_images ai
      JOIN ad_campaigns ac ON ac.id = ai.campaign_id
      JOIN users u ON u.id = ac.owner_id
      WHERE ai.is_approved = 0
      ORDER BY ai.created_at ASC
    `)

    return reply.view('admin/ads.njk', { campaigns, pendingImages })
  })

  // ----------------------------------------------------------------
  // Admin: GET /admin/ads/:id — campaign detail
  // ----------------------------------------------------------------
  fastify.get('/admin/ads/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const campaign = db.get(`
      SELECT ac.*, u.email, u.username, u.display_name
      FROM ad_campaigns ac
      LEFT JOIN users u ON u.id = ac.owner_id
      WHERE ac.id = ?
    `, req.params.id)
    if (!campaign) { reply.code(404); return reply.view('errors/404.njk', {}) }

    const images = db.all(`
      SELECT ai.*,
             COUNT(DISTINCT ac2.id) as click_count,
             COUNT(DISTINCT ai2.id) as impression_count
      FROM ad_images ai
      LEFT JOIN ad_clicks ac2 ON ac2.image_id = ai.id
      LEFT JOIN ad_impressions ai2 ON ai2.image_id = ai.id
      WHERE ai.campaign_id = ?
      GROUP BY ai.id
      ORDER BY ai.created_at DESC
    `, campaign.id)

    const totalClicks = db.get(`
      SELECT COUNT(*) as n FROM ad_clicks ac
      JOIN ad_images ai ON ai.id = ac.image_id
      WHERE ai.campaign_id = ?
    `, campaign.id)

    const totalImpressions = db.get(`
      SELECT COUNT(*) as n FROM ad_impressions ai2
      JOIN ad_images ai ON ai.id = ai2.image_id
      WHERE ai.campaign_id = ?
    `, campaign.id)

    return reply.view('admin/ads-campaign.njk', { campaign, images, totalClicks: totalClicks?.n || 0, totalImpressions: totalImpressions?.n || 0 })
  })

  // ----------------------------------------------------------------
  // Admin: POST /admin/ads/:id/toggle — activate/deactivate
  // ----------------------------------------------------------------
  fastify.post('/admin/ads/:id/toggle', { preHandler: requireAdmin }, async (req, reply) => {
    const campaign = db.get('SELECT * FROM ad_campaigns WHERE id = ?', req.params.id)
    if (!campaign) { reply.code(404); return reply.view('errors/404.njk', {}) }
    db.run('UPDATE ad_campaigns SET is_active = ? WHERE id = ?', campaign.is_active ? 0 : 1, campaign.id)
    const back = req.headers.referer?.includes(`/admin/ads/${campaign.id}`) ? `/admin/ads/${campaign.id}` : '/admin/ads'
    return reply.redirect(back)
  })

  // ----------------------------------------------------------------
  // Admin: POST /admin/ads/:id/delete — delete campaign + images
  // ----------------------------------------------------------------
  fastify.post('/admin/ads/:id/delete', { preHandler: requireAdmin }, async (req, reply) => {
    db.run('DELETE FROM ad_images WHERE campaign_id = ?', req.params.id)
    db.run('DELETE FROM ad_campaigns WHERE id = ?', req.params.id)
    req.session.flash = { type: 'success', message: 'Campaign deleted.' }
    return reply.redirect('/admin/ads')
  })

  // ----------------------------------------------------------------
  // Admin: POST /admin/ads/images/:id/approve
  // ----------------------------------------------------------------
  fastify.post('/admin/ads/images/:id/approve', { preHandler: requireAdmin }, async (req, reply) => {
    const img = db.get('SELECT campaign_id FROM ad_images WHERE id = ?', req.params.id)
    db.run('UPDATE ad_images SET is_approved = 1 WHERE id = ?', req.params.id)
    req.session.flash = { type: 'success', message: 'Image approved.' }
    const back = req.body?.back === 'campaign' && img ? `/admin/ads/${img.campaign_id}` : '/admin/ads'
    return reply.redirect(back)
  })

  // ----------------------------------------------------------------
  // Admin: POST /admin/ads/images/:id/disapprove
  // ----------------------------------------------------------------
  fastify.post('/admin/ads/images/:id/disapprove', { preHandler: requireAdmin }, async (req, reply) => {
    const img = db.get('SELECT campaign_id FROM ad_images WHERE id = ?', req.params.id)
    db.run('UPDATE ad_images SET is_approved = 0 WHERE id = ?', req.params.id)
    req.session.flash = { type: 'success', message: 'Image disapproved.' }
    const back = req.body?.back === 'campaign' && img ? `/admin/ads/${img.campaign_id}` : '/admin/ads'
    return reply.redirect(back)
  })

  // ----------------------------------------------------------------
  // Admin: POST /admin/ads/images/:id/delete — delete image file + record
  // ----------------------------------------------------------------
  fastify.post('/admin/ads/images/:id/delete', { preHandler: requireAdmin }, async (req, reply) => {
    const img = db.get('SELECT campaign_id, image_path FROM ad_images WHERE id = ?', req.params.id)
    if (img) {
      db.run('DELETE FROM ad_images WHERE id = ?', req.params.id)
      try {
        const { unlink } = await import('fs/promises')
        await unlink(path.join(UPLOADS_DIR, img.image_path))
      } catch (_) {}
    }
    req.session.flash = { type: 'success', message: 'Image deleted.' }
    const back = req.body?.back === 'campaign' && img ? `/admin/ads/${img.campaign_id}` : '/admin/ads'
    return reply.redirect(back)
  })

  // ----------------------------------------------------------------
  // Admin: POST /admin/ads/images/:id/reject — kept for backwards compat (= delete)
  // ----------------------------------------------------------------
  fastify.post('/admin/ads/images/:id/reject', { preHandler: requireAdmin }, async (req, reply) => {
    const img = db.get('SELECT campaign_id, image_path FROM ad_images WHERE id = ?', req.params.id)
    if (img) {
      db.run('DELETE FROM ad_images WHERE id = ?', req.params.id)
      try {
        const { unlink } = await import('fs/promises')
        await unlink(path.join(UPLOADS_DIR, img.image_path))
      } catch (_) {}
    }
    req.session.flash = { type: 'success', message: 'Image rejected and removed.' }
    return reply.redirect('/admin/ads')
  })
}

export default fp(adsPlugin, { name: 'ads' })
