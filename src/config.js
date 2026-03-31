import 'dotenv/config'

function required(key) {
  const val = process.env[key]
  if (!val) throw new Error(`Missing required environment variable: ${key}`)
  return val
}

function optional(key, fallback = '') {
  return process.env[key] ?? fallback
}

const config = Object.freeze({
  NODE_ENV: optional('NODE_ENV', 'development'),
  PORT: Number(optional('PORT', '3000')),
  BASE_DOMAIN: optional('BASE_DOMAIN', 'localhost'),

  SESSION_SECRET: optional('SESSION_SECRET', 'dev-secret-change-in-production-please'),

  DB_TYPE: optional('DB_TYPE', 'sqlite'),
  SQLITE_PATH: optional('SQLITE_PATH', './data/isam.db'),
  MYSQL_HOST: optional('MYSQL_HOST', '127.0.0.1'),
  MYSQL_PORT: Number(optional('MYSQL_PORT', '3306')),
  MYSQL_USER: optional('MYSQL_USER', 'isam'),
  MYSQL_PASSWORD: optional('MYSQL_PASSWORD', ''),
  MYSQL_DATABASE: optional('MYSQL_DATABASE', 'isam'),

  SITE_NAME: optional('SITE_NAME', 'is.am'),
  SITE_TAGLINE: optional('SITE_TAGLINE', 'Shorten. Share. Track.'),
  SITE_LOGO_PATH: optional('SITE_LOGO_PATH', ''),
  ADMIN_EMAIL: optional('ADMIN_EMAIL', ''),
  ADMIN_PASSWORD: optional('ADMIN_PASSWORD', ''),

  THEME: optional('THEME', 'default'),

  SHORTLINK_CHARS: optional('SHORTLINK_CHARS', 'abcdefghijklmnopqrstuvwxyz0123456789'),
  IMAGE_MAX_BYTES: Number(optional('IMAGE_MAX_BYTES', String(10 * 1024 * 1024))),

  BCRYPT_ROUNDS: Number(optional('BCRYPT_ROUNDS', '10')),
  RATE_LIMIT_CREATION_MAX: Number(optional('RATE_LIMIT_CREATION_MAX', '10')),
  RATE_LIMIT_CREATION_WINDOW_MS: Number(optional('RATE_LIMIT_CREATION_WINDOW_MS', '60000')),
  RATE_LIMIT_REGISTER_MAX: Number(optional('RATE_LIMIT_REGISTER_MAX', '5')),
  RATE_LIMIT_REGISTER_WINDOW_MS: Number(optional('RATE_LIMIT_REGISTER_WINDOW_MS', '600000')),
  RATE_LIMIT_LOGIN_MAX: Number(optional('RATE_LIMIT_LOGIN_MAX', '10')),
  RATE_LIMIT_LOGIN_WINDOW_MS: Number(optional('RATE_LIMIT_LOGIN_WINDOW_MS', '600000')),
  ANON_TOKEN_COOKIE_DAYS: Number(optional('ANON_TOKEN_COOKIE_DAYS', '30')),

  RESEND_API_KEY: optional('RESEND_API_KEY', ''),
  RESEND_FROM_EMAIL: optional('RESEND_FROM_EMAIL', ''),

  get IS_PROD() { return this.NODE_ENV === 'production' },
  get IS_DEV() { return this.NODE_ENV === 'development' },
})

export default config
