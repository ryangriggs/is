import fp from 'fastify-plugin'
import QRCode from 'qrcode'

async function qrPlugin(fastify) {
  fastify.get('/q', async (req, reply) => {
    return reply.view('qr.njk', { url: req.query.url || '', size: '400', ecc: 'M' })
  })

  fastify.post('/q', async (req, reply) => {
    const { url = '', size = '400', ecc = 'M' } = req.body || {}
    if (!url.trim()) {
      return reply.view('qr.njk', { url, size, ecc, error: 'Please enter some text or a URL.' })
    }
    const qrDataUrl = await QRCode.toDataURL(url, {
      width: Math.min(Math.max(parseInt(size) || 400, 100), 1000),
      errorCorrectionLevel: ['L', 'M', 'Q', 'H'].includes(ecc) ? ecc : 'M',
      margin: 2,
    })
    return reply.view('qr.njk', { url, size, ecc, qrDataUrl })
  })

  // Download QR as PNG
  fastify.get('/q/download', async (req, reply) => {
    const { url = '', size = '400', ecc = 'M' } = req.query
    if (!url) return reply.redirect('/q')
    const buffer = await QRCode.toBuffer(url, {
      width: Math.min(Math.max(parseInt(size) || 400, 100), 1000),
      errorCorrectionLevel: ['L', 'M', 'Q', 'H'].includes(ecc) ? ecc : 'M',
      margin: 2,
    })
    reply.header('Content-Type', 'image/png')
    reply.header('Content-Disposition', 'attachment; filename="qr.png"')
    return reply.send(buffer)
  })
}

export default fp(qrPlugin, { name: 'qr' })
