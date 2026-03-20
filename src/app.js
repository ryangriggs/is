import path from 'path'
import { dirname } from 'path'
import { fileURLToPath } from 'url'
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

const __dirname = dirname(fileURLToPath(import.meta.url))

function dateFilter(ts) {
  if (!ts) return '—'
  return new Date(Number(ts)).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric'
  })
}

export async function buildApp() {
  const db = await initDb()

  const app = Fastify({
    logger: config.IS_DEV
      ? { level: 'info' }
      : { level: 'warn' },
    trustProxy: true,
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

  // Body parsers
  await app.register(formbody)

  // Rate limiting (opt-in per route)
  await app.register(rateLimit, { global: false })

  // Multipart (file uploads)
  await app.register(multipart, { limits: { fileSize: config.IMAGE_MAX_BYTES } })

  // Static files
  const themeName = config.THEME || 'default'
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

    // Load branding settings
    let siteName = config.SITE_NAME
    let siteTagline = config.SITE_TAGLINE
    let siteLogo = config.SITE_LOGO_PATH
    try {
      const rows = db.all(`SELECT key, value FROM settings WHERE key IN ('site_name','site_tagline','site_logo_path')`)
      for (const row of rows) {
        if (row.key === 'site_name' && row.value) siteName = row.value
        if (row.key === 'site_tagline' && row.value) siteTagline = row.value
        if (row.key === 'site_logo_path' && row.value) siteLogo = row.value
      }
    } catch (_) {}

    // Flash: read and clear
    const flash = req.session.flash || null
    if (req.session.flash) delete req.session.flash

    reply.locals = {
      user: req.session.userId
        ? { id: req.session.userId, username: req.session.username, role: req.session.role }
        : null,
      impersonating: req.session.impersonatingAdminId
        ? { adminId: req.session.impersonatingAdminId, adminUsername: req.session.impersonatingAdminUsername }
        : null,
      siteName,
      siteTagline,
      siteLogo,
      baseDomain: config.BASE_DOMAIN,
      currentPath: req.url,
      flash,
    }
  })

  // Load all feature plugins
  await app.register(pluginLoader)

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
