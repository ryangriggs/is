import fp from 'fastify-plugin'
import path from 'path'
import { nanoid } from 'nanoid'
import { createLink } from '../../core/links.js'
import { getTierForUser } from '../../core/tiers.js'
import { applyWatermark } from '../../core/watermark.js'
import { getAdForOwner } from '../../core/ads.js'
import { getSetting } from '../../core/settings-cache.js'

const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
const MIME_TO_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
}

async function imageUploadPlugin(fastify) {
  const db = fastify.db
  const hooks = fastify.hooks
  const uploadsDir = path.join(process.cwd(), 'uploads')

  fastify.get('/i', async (req, reply) => {
    const ad = getAdForOwner(req.session.userId || null, db)
    return reply.view('image-create.njk', { ad })
  })

  fastify.post('/i', async (req, reply) => {
    const ad = getAdForOwner(req.session.userId || null, db)
    let data
    try {
      data = await req.file()
    } catch {
      return reply.view('image-create.njk', { error: 'Upload failed. Please try again.', ad })
    }

    if (!data) {
      return reply.view('image-create.njk', { error: 'No file selected.', ad })
    }
    if (!ALLOWED_TYPES.has(data.mimetype)) {
      await data.toBuffer()
      return reply.view('image-create.njk', { error: 'Unsupported file type. Use JPEG, PNG, GIF, or WebP.', ad })
    }

    const ext = MIME_TO_EXT[data.mimetype]
    const filename = nanoid(16) + ext
    const filepath = path.join(uploadsDir, filename)

    let fileSize = 0
    try {
      const buf = await data.toBuffer()
      fileSize = buf.length

      // Tier checks (file size + allowed image types)
      const tier = getTierForUser(req.session.userId || null, db)
      const allowedTypes = (tier.allowed_image_types || 'image/jpeg,image/png,image/gif').split(',').map(s => s.trim())
      if (!allowedTypes.includes(data.mimetype)) {
        const labels = allowedTypes.map(m => MIME_TO_EXT[m]?.replace('.', '').toUpperCase() || m).join(', ')
        return reply.view('image-create.njk', { error: `Your plan only allows: ${labels}.`, ad })
      }
      const maxBytes = (tier.max_file_size_mb || 10) * 1024 * 1024
      if (fileSize > maxBytes) {
        return reply.view('image-create.njk', { error: `File too large. Your plan allows up to ${tier.max_file_size_mb} MB.`, ad })
      }

      const { writeFile } = await import('fs/promises')
      await writeFile(filepath, buf)

      // Apply watermark out-of-band — respond immediately, process in background
      if (tier.allow_watermark) {
        const wmSettings = {
          watermark_image_path: getSetting('watermark_image_path'),
          watermark_position:   getSetting('watermark_position'),
          watermark_size_pct:   getSetting('watermark_size_pct'),
        }
        setImmediate(async () => {
          try {
            const wmBuf = await applyWatermark(filepath, wmSettings)
            if (wmBuf) await writeFile(filepath, wmBuf)
          } catch (_) {}
        })
      }
    } catch {
      return reply.view('image-create.njk', { error: 'Failed to save file. Please try again.', ad })
    }

    const burn_on_read = data.fields?.burn_on_read?.value
    const expires_at = data.fields?.expires_at?.value
    const expiresAtMs = expires_at ? new Date(expires_at).getTime() : null
    const { link, plainToken } = await createLink(db, hooks, {
      type: 'image',
      destination: filename,
      title: filename,
      meta: { mimetype: data.mimetype },
      burnOnRead: burn_on_read === '1',
      expiresAt: expiresAtMs && !isNaN(expiresAtMs) ? expiresAtMs : null,
      ownerId: req.session.userId || null,
      req,
    })

    if (fileSize) db.run('UPDATE links SET file_size = ? WHERE id = ?', fileSize, link.id)
    if (!req.session.userId) req.session.pendingClaimCode = link.code

    return reply.redirect(`/success?code=${link.code}${plainToken ? '&token=' + plainToken : ''}`)
  })
}

export default fp(imageUploadPlugin, { name: 'image-upload' })
