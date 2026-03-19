import { getDb } from './index.js'
import { hashPassword, generateToken } from '../auth.js'
import config from '../../config.js'

const DEFAULTS = {
  registration_open: 'true',
  require_login_to_create: 'false',
  max_links_anonymous: '10',
  max_file_size_mb: '10',
  allowed_image_types: 'image/jpeg,image/png,image/gif,image/webp',
  site_name: config.SITE_NAME,
  site_tagline: config.SITE_TAGLINE,
  site_logo_path: config.SITE_LOGO_PATH,
  ads_enabled: 'false',
  analytics_enabled: 'true',
}

export async function seed() {
  const db = getDb()

  // Insert default settings (skip if key already exists)
  for (const [key, value] of Object.entries(DEFAULTS)) {
    db.run(
      `INSERT INTO settings(key, value, updated_at) VALUES(?,?,?)
       ON CONFLICT(key) DO NOTHING`,
      key, value, Date.now()
    )
  }

  // Bootstrap admin user if no users exist
  const row = db.get('SELECT COUNT(*) as n FROM users')
  if (row.n === 0) {
    const password = config.ADMIN_PASSWORD || generateToken(12)
    const passwordHash = await hashPassword(password)
    db.run(
      `INSERT INTO users(username, email, password_hash, role, created_at)
       VALUES(?,?,?,?,?)`,
      'admin', config.ADMIN_EMAIL || 'admin@localhost', passwordHash, 'admin', Date.now()
    )

    if (!config.ADMIN_PASSWORD) {
      console.log('='.repeat(60))
      console.log('  ADMIN ACCOUNT CREATED')
      console.log('  Username: admin')
      console.log(`  Password: ${password}`)
      console.log('  Please change this password after first login.')
      console.log('='.repeat(60))
    }
  }
}
