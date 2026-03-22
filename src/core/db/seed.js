import { getDb } from './index.js'
import { hashPassword, generateToken } from '../auth.js'
import config from '../../config.js'

const DEFAULTS = {
  registration_open: 'true',
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

  // Bootstrap admin user — only runs if no admin account exists yet
  const existing = db.get(`SELECT id FROM users WHERE username = 'admin' AND role = 'admin'`)
  if (!existing) {
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
      console.log('  Save this password or set ADMIN_PASSWORD in .env')
      console.log('='.repeat(60))
    }
  }
}
