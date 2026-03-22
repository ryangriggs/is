import sharp from 'sharp'
import path from 'path'

const POSITION_MAP = {
  'bottom-right':  'southeast',
  'bottom-left':   'southwest',
  'bottom-center': 'south',
  'top-right':     'northeast',
  'top-left':      'northwest',
  'top-center':    'north',
  'center':        'centre',
}

// Returns the watermarked buffer, or null if watermarking should be skipped/failed.
// inputPath: absolute path to the uploaded image file.
// settings: object with watermark_image_path, watermark_position, watermark_size_pct.
export async function applyWatermark(inputPath, settings) {
  if (!settings?.watermark_image_path) return null

  const wmAbsPath = path.join(process.cwd(), settings.watermark_image_path)
  const sizePct = Math.max(1, Math.min(100, parseInt(settings.watermark_size_pct) || 15))
  const gravity = POSITION_MAP[settings.watermark_position] || 'southeast'

  try {
    const image = sharp(inputPath)
    const meta = await image.metadata()

    // Skip animated images (GIF, animated WebP, animated PNG)
    if (meta.pages > 1) {
      console.log('[watermark] skipping animated image, pages:', meta.pages)
      return null
    }
    // Skip GIF format entirely (animation detection may not catch all cases)
    if (meta.format === 'gif') return null

    const wmHeight = Math.max(4, Math.round(meta.height * sizePct / 100))

    // Resize watermark to target height, preserving aspect ratio
    const wmBuf = await sharp(wmAbsPath)
      .resize({ height: wmHeight, fit: 'inside', withoutEnlargement: false })
      .toBuffer()

    return await image
      .composite([{ input: wmBuf, gravity }])
      .toBuffer()
  } catch (err) {
    console.log('[watermark] error:', err.message)
    return null
  }
}
