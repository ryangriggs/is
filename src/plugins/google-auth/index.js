import oauthPlugin from '@fastify/oauth2'
import { requireAuth, setSessionFromUser, claimPendingLink } from '../../core/auth.js'
import config from '../../config.js'

function buildCallbackUri() {
  if (config.IS_PROD) return `https://${config.BASE_DOMAIN}/auth/google/callback`
  const port = config.PORT !== 80 && config.PORT !== 443 ? `:${config.PORT}` : ''
  return `http://${config.BASE_DOMAIN}${port}/auth/google/callback`
}

function usernameFromEmail(email) {
  return email.split('@')[0]
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 20) || 'user'
}

async function googleAuthPlugin(fastify) {
  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) {
    fastify.log.warn('[google-auth] GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET not set — Google login disabled')
    return
  }

  await fastify.register(oauthPlugin, {
    name: 'googleOAuth2',
    credentials: {
      client: { id: config.GOOGLE_CLIENT_ID, secret: config.GOOGLE_CLIENT_SECRET },
      auth: oauthPlugin.GOOGLE_CONFIGURATION,
    },
    callbackUri: buildCallbackUri(),
    scope: ['openid', 'profile', 'email'],
  })

  // ----------------------------------------------------------------
  // GET /auth/google — start login/register flow
  // ----------------------------------------------------------------
  fastify.get('/auth/google', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    if (req.session.userId) return reply.redirect('/dashboard')
    req.session.oauthIntent = 'login'
    const uri = await fastify.googleOAuth2.generateAuthorizationUri(req, reply)
    return reply.redirect(uri)
  })

  // ----------------------------------------------------------------
  // GET /auth/google/link — start link flow (must be logged in)
  // ----------------------------------------------------------------
  fastify.get('/auth/google/link', { preHandler: requireAuth }, async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    req.session.oauthIntent = 'link'
    const uri = await fastify.googleOAuth2.generateAuthorizationUri(req, reply)
    return reply.redirect(uri)
  })

  // ----------------------------------------------------------------
  // GET /auth/google/callback — handles both login and link flows
  // ----------------------------------------------------------------
  fastify.get('/auth/google/callback', async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()

    const intent = req.session.oauthIntent || 'login'
    delete req.session.oauthIntent

    // User denied access or Google returned an error
    if (req.query.error) {
      req.session.flash = { type: 'error', message: 'Google sign-in was cancelled.' }
      return reply.redirect(intent === 'link' ? '/profile' : '/login')
    }

    // Exchange code for token (also validates state parameter)
    let token
    try {
      token = await fastify.googleOAuth2.getAccessTokenFromAuthorizationCodeFlow(req, reply)
    } catch (err) {
      fastify.log.error({ err }, '[google-auth] Token exchange failed')
      req.session.flash = { type: 'error', message: 'Google sign-in failed. Please try again.' }
      return reply.redirect(intent === 'link' ? '/profile' : '/login')
    }

    // Fetch Google user info
    let googleUser
    try {
      const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${token.token.access_token}` },
      })
      if (!res.ok) throw new Error(`userinfo ${res.status}`)
      googleUser = await res.json()
    } catch (err) {
      fastify.log.error({ err }, '[google-auth] Failed to fetch userinfo')
      req.session.flash = { type: 'error', message: 'Failed to retrieve Google account info. Please try again.' }
      return reply.redirect(intent === 'link' ? '/profile' : '/login')
    }

    const { sub: googleId, email: googleEmail, email_verified: googleEmailVerified, name: googleName, given_name: googleGivenName } = googleUser

    if (!googleEmail || !googleEmailVerified) {
      req.session.flash = { type: 'error', message: 'Your Google account does not have a verified email address.' }
      return reply.redirect(intent === 'link' ? '/profile' : '/login')
    }

    const googleEmailLc = googleEmail.toLowerCase()
    const db = fastify.db

    // ----------------------------------------------------------------
    // LINK FLOW — attach Google to an existing logged-in account
    // ----------------------------------------------------------------
    if (intent === 'link') {
      if (!req.session.userId) return reply.redirect('/login')

      const currentUser = db.get('SELECT * FROM users WHERE id = ?', req.session.userId)
      if (!currentUser) return reply.redirect('/login')

      // Email must match — accounts are keyed by email
      if (googleEmailLc !== (currentUser.email || '').toLowerCase()) {
        req.session.flash = {
          type: 'error',
          message: `Cannot link: the Google account's email (${googleEmail}) does not match this account's email (${currentUser.email}). Only Google accounts with a matching email address can be linked.`,
        }
        return reply.redirect('/profile')
      }

      // Sanity check: google_id not already linked to a different user
      const existing = db.get('SELECT id FROM users WHERE google_id = ?', googleId)
      if (existing && existing.id !== currentUser.id) {
        req.session.flash = { type: 'error', message: 'This Google account is already linked to a different user.' }
        return reply.redirect('/profile')
      }

      db.run('UPDATE users SET google_id = ?, email_verified = 1 WHERE id = ?', googleId, currentUser.id)
      req.session.flash = { type: 'success', message: 'Google account linked successfully.' }
      return reply.redirect('/profile')
    }

    // ----------------------------------------------------------------
    // LOGIN / REGISTER FLOW
    // ----------------------------------------------------------------

    // 1. Look up by google_id (returning Google user)
    let user = db.get('SELECT * FROM users WHERE google_id = ?', googleId)

    // 2. Look up by email (existing account signing in with Google for the first time)
    if (!user) {
      user = db.get('SELECT * FROM users WHERE email = ?', googleEmailLc)
      if (user) {
        db.run('UPDATE users SET google_id = ?, email_verified = 1 WHERE id = ?', googleId, user.id)
        user = db.get('SELECT * FROM users WHERE id = ?', user.id)
      }
    }

    // 3. Create a new account
    if (!user) {
      const displayName = (googleGivenName || googleName || '').trim() || null
      let baseUsername = usernameFromEmail(googleEmailLc)
      let username = baseUsername
      let suffix = 1
      while (db.get('SELECT id FROM users WHERE username = ?', username)) {
        username = baseUsername + suffix++
      }

      const info = db.run(
        `INSERT INTO users(username, email, display_name, password_hash, role, email_verified, google_id, created_at)
         VALUES(?,?,?,NULL,?,1,?,?)`,
        username, googleEmailLc, displayName, 'user', googleId, Date.now()
      )
      user = db.get('SELECT * FROM users WHERE id = ?', info.lastInsertRowid)
    }

    if (!user) {
      req.session.flash = { type: 'error', message: 'Failed to sign in with Google. Please try again.' }
      return reply.redirect('/login')
    }

    if (user.is_blocked) {
      req.session.flash = { type: 'error', message: 'Your account has been suspended.' }
      return reply.redirect('/login')
    }

    // Ensure email is marked verified (Google has confirmed it)
    if (!user.email_verified) {
      db.run('UPDATE users SET email_verified = 1 WHERE id = ?', user.id)
    }

    db.run('UPDATE users SET last_login = ? WHERE id = ?', Date.now(), user.id)

    // TODO: 2FA check point — if user has 2FA enabled, set req.session.pending2faUserId
    //       and redirect to /2fa/verify instead of completing login here.

    const pendingCode = req.session.pendingClaimCode || null
    await new Promise((res, rej) => req.session.regenerate(e => e ? rej(e) : res()))
    if (pendingCode) req.session.pendingClaimCode = pendingCode
    setSessionFromUser(req, user)
    claimPendingLink(db, req)

    req.session.flash = { type: 'success', message: `Welcome${user.display_name ? ', ' + user.display_name : ''}!` }
    return reply.redirect('/dashboard')
  })
}

export default googleAuthPlugin
