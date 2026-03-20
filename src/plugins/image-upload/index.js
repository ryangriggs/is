import fp from 'fastify-plugin'
import { createWriteStream } from 'fs'
import { pipeline } from 'stream/promises'
import path from 'path'
import { nanoid } from 'nanoid'
import { createLink } from '../../core/links.js'

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
    return reply.view('image-create.njk', {})
  })

  fastify.post('/i', async (req, reply) => {
    let data
    try {
      data = await req.file()
    } catch {
      return reply.view('image-create.njk', { error: 'Upload failed. Please try again.' })
    }

    if (!data) {
      return reply.view('image-create.njk', { error: 'No file selected.' })
    }
    if (!ALLOWED_TYPES.has(data.mimetype)) {
      await data.toBuffer() // drain stream
      return reply.view('image-create.njk', { error: 'Unsupported file type. Use JPEG, PNG, GIF, or WebP.' })
    }

    const ext = MIME_TO_EXT[data.mimetype]
    const filename = nanoid(16) + ext
    const filepath = path.join(uploadsDir, filename)

    try {
      await pipeline(data.file, createWriteStream(filepath))
    } catch {
      return reply.view('image-create.njk', { error: 'Failed to save file. Please try again.' })
    }

    const { link, plainToken } = await createLink(db, hooks, {
      type: 'image',
      destination: filename,
      title: filename,
      meta: { mimetype: data.mimetype },
      ownerId: req.session.userId || null,
      req,
    })
    return reply.redirect(`/success?code=${link.code}${plainToken ? '&token=' + plainToken : ''}`)
  })
}

export default fp(imageUploadPlugin, { name: 'image-upload' })
