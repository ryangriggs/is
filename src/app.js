import path from 'path'
import { dirname } from 'path'
import { fileURLToPath } from 'url'
import { readFileSync } from 'fs'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import session from '@fastify/session'
import formbody from '@fastify/formbody'
import rateLimit from '@fastify/rate-limit'
import staticFiles from '@fastify/static'
import view from '@fastify/view'
import multipart from '@fastify/multipart'
import nunjucks from 'nunjucks'

import config from './config.js'
import { initDb } from './core/db/index.js'
import { checkIpBlocked } from './core/ipblock.js'
import { HookRegistry } from './core/hooks.js'
import { extractSubdomain } from './core/subdomain.js'
import { SqliteSessionStore } from './core/auth.js'
import pluginLoader from './plugins/loader.js'
import { checkForUpdates, getUpdateStatus } from './core/updater.js'
import { initSettingsCache, getSetting } from './core/settings-cache.js'
import { initWriteBuffer } from './core/write-buffer.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const { version } = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))

function dateFilter(ts) {
  if (!ts) return '—'
  return new Date(Number(ts)).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric'
  })
}

function datetimeFilter(ts) {
  if (!ts) return '—'
  return new Date(Number(ts)).toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  })
}

export async function buildApp() {
  const db = await initDb()
  initSettingsCache(db)
  initWriteBuffer(db)

  // Read active theme from DB at startup (takes effect on restart after admin changes it)
  let startupTheme = config.THEME || 'default'
  try {
    const themeSetting = db.get("SELECT value FROM settings WHERE key = 'active_theme'")
    if (themeSetting?.value) {
      const raw = themeSetting.value
      // Prevent path traversal: only allow alphanumeric, dash, underscore
      // and verify the resolved path stays inside the themes directory
      if (/^[a-zA-Z0-9_-]+$/.test(raw)) {
        const themesDir = path.join(__dirname, 'themes')
        const resolved = path.resolve(themesDir, raw)
        if (resolved.startsWith(themesDir + path.sep) || resolved === themesDir) {
          startupTheme = raw
        }
      }
    }
  } catch (_) {}

  const app = Fastify({
    logger: config.IS_DEV
      ? { level: 'info' }
      : { level: 'warn' },
    trustProxy: 1,        // Trust exactly one proxy hop (nginx); prevents X-Forwarded-For spoofing
    ignoreTrailingSlash: true,
  })

  // Shared decorators
  app.decorate('db', db)
  app.decorate('hooks', new HookRegistry())
  app.decorate('config', config)

  // Earliest possible IP block check — plain text response, no template
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/static/') || req.url.startsWith('/uploads/')) return
    try {
      if (checkIpBlocked(req.ip, db)) {
        reply.code(403).header('Content-Type', 'text/plain; charset=utf-8')
        return reply.send('Your IP address has been blocked. Contact the site administrator if you believe this is an error.')
      }
    } catch (_) {}
  })

  // Cookies (must be before session)
  await app.register(cookie, { secret: config.SESSION_SECRET })

  // Session store
  const sessionStore = new SqliteSessionStore(db)
  await app.register(session, {
    secret: config.SESSION_SECRET,
    store: sessionStore,
    cookie: {
      secure: config.IS_PROD,
      httpOnly: true,
      sameSite: 'lax',
      maxAge: config.ANON_TOKEN_COOKIE_DAYS * 24 * 60 * 60 * 1000,
    },
    saveUninitialized: false,
  })

  // CSRF: reject cross-origin state-changing requests.
  // API routes (/a/*) are excluded — they authenticate via Bearer token, not cookies.
  app.addHook('preHandler', async (req, reply) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return
    if (req.url.startsWith('/a/')) return
    if (req.url === '/stripe/webhook') return  // Stripe webhook verified by signature
    const origin = req.headers.origin
    const referer = req.headers.referer
    // No Origin and no Referer = server-to-server (curl, etc.) — allow
    if (!origin && !referer) return
    const siteHost = config.BASE_DOMAIN
    const isAllowedHost = (header) => {
      try {
        const host = new URL(header).hostname
        return host === siteHost || host.endsWith('.' + siteHost)
      } catch { return false }
    }
    if (origin) {
      if (!isAllowedHost(origin)) return reply.code(403).send('Forbidden')
    } else if (referer) {
      if (!isAllowedHost(referer)) return reply.code(403).send('Forbidden')
    }
  })

  // Body parsers
  await app.register(formbody)

  // Rate limiting (opt-in per route)
  await app.register(rateLimit, { global: false })

  // Multipart (file uploads)
  await app.register(multipart, { limits: { fileSize: config.IMAGE_MAX_BYTES } })

  // Static files
  const themeName = startupTheme
  const defaultStaticPath = path.join(__dirname, 'themes', 'default', 'static')
  const customStaticPath = path.join(__dirname, 'themes', themeName, 'static')

  await app.register(staticFiles, {
    root: themeName !== 'default' ? customStaticPath : defaultStaticPath,
    prefix: '/static/',
  })

  await app.register(staticFiles, {
    root: path.join(process.cwd(), 'uploads'),
    prefix: '/uploads/',
    decorateReply: false,
    list: false,  // Never expose directory listings
  })

  // Nunjucks views with multi-path theme support
  const defaultViewPath = path.join(__dirname, 'themes', 'default', 'views')
  const customViewPath = path.join(__dirname, 'themes', themeName, 'views')
  const viewPaths = themeName !== 'default' ? [customViewPath, defaultViewPath] : [defaultViewPath]

  // @fastify/view always calls engine.configure() — wrap nunjucks so we can
  // add custom filters to the env it creates before handing it back.
  const nunjucksWithFilters = {
    ...nunjucks,
    configure(paths, opts) {
      const env = nunjucks.configure(paths, opts)
      env.addFilter('date', dateFilter)
      env.addFilter('datetime', datetimeFilter)
      return env
    }
  }

  await app.register(view, {
    engine: { nunjucks: nunjucksWithFilters },
    root: viewPaths,
    options: { autoescape: true, noCache: config.IS_DEV },
  })

  // Global preHandler: subdomain + IP blocking + template locals
  app.addHook('preHandler', async (req, reply) => {
    req.subdomain = extractSubdomain(req.hostname, config.BASE_DOMAIN)

    // Run IP-blocking hooks registered by plugins
    try {
      await app.hooks.run('pre:request', { req, reply })
    } catch (err) {
      // Hook threw — response already set
      return
    }

    // Load branding settings from in-memory cache (no DB hit per request)
    const siteName = getSetting('site_name') || config.SITE_NAME
    const siteTagline = getSetting('site_tagline') || config.SITE_TAGLINE
    const siteLogo = getSetting('site_logo_path') || config.SITE_LOGO_PATH
    const faviconEmoji = getSetting('favicon_emoji') || '🔗'
    const siteHeroSubtitle = getSetting('site_hero_subtitle') || ''
    const githubRepoUrl = getSetting('github_repo_url') || 'https://github.com/ryangriggs/is'
    const adImageHeight = getSetting('ad_image_height') || '90'
    const gdprEnabled = getSetting('gdpr_enabled') === 'true'

    // Flash: read and clear
    const flash = req.session.flash || null
    if (req.session.flash) delete req.session.flash

    let unreadMessages = 0
    let showUpdateBanner = false
    let updateLatest = null
    if (req.session.role === 'admin') {
      try {
        unreadMessages = db.get('SELECT COUNT(*) as n FROM messages WHERE is_read = 0')?.n || 0
      } catch (_) {}
      const status = getUpdateStatus()
      if (status.updateAvailable) {
        updateLatest = status.latest
        const dismissed = req.cookies?.upd_dismissed
        showUpdateBanner = dismissed !== status.latest
      }
    }

    reply.locals = {
      user: req.session.userId
        ? {
            id: req.session.userId,
            username: req.session.username,
            displayName: req.session.displayName || null,
            email: req.session.email || null,
            role: req.session.role,
            subscriptionTier: req.session.subscriptionTier || 'free',
          }
        : null,
      impersonating: req.session.impersonatingAdminId
        ? { adminId: req.session.impersonatingAdminId, adminUsername: req.session.impersonatingAdminUsername }
        : null,
      siteName,
      siteTagline,
      githubRepoUrl,
      siteLogo,
      faviconEmoji,
      siteHeroSubtitle,
      adImageHeight,
      baseDomain: config.BASE_DOMAIN,
      currentPath: req.url,
      flash,
      unreadMessages,
      appVersion: version,
      showUpdateBanner,
      updateLatest,
      gdprEnabled,
      gdprConsent: req.cookies?.gdpr_consent || null,
    }
  })

  // Load all feature plugins
  await app.register(pluginLoader)

  // Cleanup expired links every hour
  const cleanupExpiredLinks = async () => {
    try {
      const now = Date.now()
      const expiredImages = db.all(
        "SELECT destination FROM links WHERE type = 'image' AND expires_at IS NOT NULL AND expires_at < ?", now
      )
      const expiredPastes = db.all(
        "SELECT destination FROM links WHERE type IN ('text', 'html') AND expires_at IS NOT NULL AND expires_at < ?", now
      )
      db.run('DELETE FROM links WHERE expires_at IS NOT NULL AND expires_at < ?', now)
      const { unlink } = await import('fs/promises')
      for (const img of expiredImages) {
        await unlink(path.join(process.cwd(), 'uploads', img.destination)).catch(() => {})
      }
      for (const paste of expiredPastes) {
        await unlink(path.join(process.cwd(), 'data', 'pastes', paste.destination)).catch(() => {})
      }
    } catch (_) {}
  }
  setTimeout(cleanupExpiredLinks, 15000)
  setInterval(cleanupExpiredLinks, 3600 * 1000)

  // Sweep unverified accounts that are older than the configured threshold
  const sweepUnverifiedAccounts = () => {
    try {
      const days = parseInt(db.get("SELECT value FROM settings WHERE key = 'unverified_sweep_days'")?.value || '0', 10)
      if (!days || days < 1) return
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
      const result = db.run(
        'DELETE FROM users WHERE email_verified = 0 AND created_at < ?',
        cutoff
      )
      if (result.changes > 0) {
        console.log(`[sweep] Deleted ${result.changes} unverified account(s) older than ${days} day(s).`)
      }
    } catch (err) {
      console.error('[sweep] Unverified account sweep failed:', err.message)
    }
  }
  setTimeout(sweepUnverifiedAccounts, 30000)          // First run 30s after startup
  setInterval(sweepUnverifiedAccounts, 24 * 3600 * 1000) // Then daily

  // Schedule periodic update checks
  const doUpdateCheck = async () => {
    try {
      const repoUrl = db.get("SELECT value FROM settings WHERE key = 'github_repo_url'")?.value
      const hours = parseInt(db.get("SELECT value FROM settings WHERE key = 'update_check_hours'")?.value || '24')
      await checkForUpdates(repoUrl, { maxAgeHours: hours })
    } catch (_) {}
  }
  setTimeout(doUpdateCheck, 10000)          // Initial check 10s after startup
  setInterval(doUpdateCheck, 3600 * 1000)   // Re-check every hour (cached by module)

  // Error handlers
  app.setNotFoundHandler(async (req, reply) => {
    reply.code(404)
    return reply.view('errors/404.njk', {})
  })

  app.setErrorHandler(async (err, req, reply) => {
    app.log.error({ err }, 'Unhandled error')
    const code = err.statusCode || 500
    reply.code(code)
    if (code === 429) {
      return reply.send({ error: 'Too many requests. Please slow down.' })
    }
    return reply.view('errors/403.njk', { message: err.message || 'An unexpected error occurred.' })
  })

  return app
}
