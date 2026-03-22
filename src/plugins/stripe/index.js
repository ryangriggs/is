import Stripe from 'stripe'
import config from '../../config.js'
import { requireAuth } from '../../core/auth.js'

async function stripePlugin(fastify) {
  const db = fastify.db

  // Raw body parser for webhook signature verification (scoped to this plugin only)
  fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    try {
      req.rawBody = body
      done(null, JSON.parse(body.toString()))
    } catch (err) {
      done(err)
    }
  })

  // Read Stripe config from DB settings
  function getStripeConfig() {
    const rows = db.all(
      "SELECT key, value FROM settings WHERE key IN ('stripe_enabled','stripe_secret_key','stripe_webhook_secret')"
    )
    const s = Object.fromEntries(rows.map(r => [r.key, r.value]))
    return {
      enabled: s.stripe_enabled === 'true',
      secretKey: s.stripe_secret_key || '',
      webhookSecret: s.stripe_webhook_secret || '',
    }
  }

  // ----------------------------------------------------------------
  // POST /stripe/checkout — start a Stripe Checkout Session
  // ----------------------------------------------------------------
  fastify.post('/stripe/checkout', { preHandler: requireAuth }, async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const cfg = getStripeConfig()
    if (!cfg.enabled || !cfg.secretKey) {
      req.session.flash = { type: 'error', message: 'Payments are not currently enabled.' }
      return reply.redirect('/pricing')
    }

    const { tier: tierName, interval } = req.body || {}
    if (!tierName || !['monthly', 'yearly'].includes(interval)) {
      req.session.flash = { type: 'error', message: 'Invalid plan selection.' }
      return reply.redirect('/pricing')
    }

    const tier = db.get('SELECT * FROM account_tiers WHERE name = ? AND is_enabled = 1', tierName)
    if (!tier || tier.price <= 0) {
      req.session.flash = { type: 'error', message: 'Invalid tier.' }
      return reply.redirect('/pricing')
    }

    const priceId = interval === 'yearly' ? tier.stripe_price_id_yearly : tier.stripe_price_id_monthly
    if (!priceId) {
      req.session.flash = { type: 'error', message: 'Payment not configured for this plan. Please contact support.' }
      return reply.redirect('/pricing')
    }

    const user = db.get('SELECT * FROM users WHERE id = ?', req.session.userId)
    if (!user) return reply.redirect('/login')

    const stripe = new Stripe(cfg.secretKey)

    // Create or retrieve Stripe customer
    let customerId = user.stripe_customer_id
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: user.display_name || user.username,
        metadata: { user_id: String(user.id) },
      })
      customerId = customer.id
      db.run('UPDATE users SET stripe_customer_id = ? WHERE id = ?', customerId, user.id)
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `https://${config.BASE_DOMAIN}/pricing?checkout=success`,
      cancel_url: `https://${config.BASE_DOMAIN}/pricing?checkout=cancelled`,
      subscription_data: {
        metadata: { user_id: String(user.id), tier: tierName },
      },
    })

    return reply.redirect(303, session.url)
  })

  // ----------------------------------------------------------------
  // POST /stripe/portal — open Stripe Customer Portal
  // ----------------------------------------------------------------
  fastify.post('/stripe/portal', { preHandler: requireAuth }, async (req, reply) => {
    if (req.subdomain !== '') return reply.callNotFound()
    const cfg = getStripeConfig()
    if (!cfg.enabled || !cfg.secretKey) {
      req.session.flash = { type: 'error', message: 'Payments are not currently enabled.' }
      return reply.redirect('/profile')
    }

    const user = db.get('SELECT stripe_customer_id FROM users WHERE id = ?', req.session.userId)
    if (!user?.stripe_customer_id) {
      req.session.flash = { type: 'error', message: 'No active subscription found.' }
      return reply.redirect('/pricing')
    }

    const stripe = new Stripe(cfg.secretKey)
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: `https://${config.BASE_DOMAIN}/profile`,
    })

    return reply.redirect(303, portalSession.url)
  })

  // ----------------------------------------------------------------
  // POST /stripe/webhook — handle Stripe events
  // ----------------------------------------------------------------
  fastify.post('/stripe/webhook', async (req, reply) => {
    const cfg = getStripeConfig()
    if (!cfg.secretKey || !cfg.webhookSecret) {
      return reply.code(503).send({ error: 'Stripe not configured' })
    }

    const sig = req.headers['stripe-signature']
    const stripe = new Stripe(cfg.secretKey)
    let event

    try {
      event = stripe.webhooks.constructEvent(req.rawBody, sig, cfg.webhookSecret)
    } catch (err) {
      fastify.log.warn({ err }, 'Stripe webhook signature verification failed')
      return reply.code(400).send({ error: 'Invalid signature' })
    }

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object
        if (session.mode !== 'subscription') break
        const sub = await stripe.subscriptions.retrieve(session.subscription)
        applySubscription(sub)
        break
      }
      case 'customer.subscription.updated': {
        applySubscription(event.data.object)
        break
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object
        const user = db.get('SELECT id FROM users WHERE stripe_subscription_id = ?', sub.id)
        if (user) {
          db.run(
            `UPDATE users SET subscription_tier = 'free', stripe_subscription_status = 'canceled',
             stripe_subscription_id = NULL, stripe_current_period_end = NULL,
             stripe_subscription_interval = NULL WHERE id = ?`,
            user.id
          )
        }
        break
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object
        if (invoice.subscription) {
          const user = db.get('SELECT id FROM users WHERE stripe_subscription_id = ?', invoice.subscription)
          if (user) {
            db.run("UPDATE users SET stripe_subscription_status = 'past_due' WHERE id = ?", user.id)
          }
        }
        break
      }
    }

    return reply.send({ received: true })
  })

  function applySubscription(sub) {
    const tierName = sub.metadata?.tier
    const userId = sub.metadata?.user_id
      ? Number(sub.metadata.user_id)
      : db.get('SELECT id FROM users WHERE stripe_customer_id = ?', sub.customer)?.id

    if (!userId) return

    const interval = sub.items?.data?.[0]?.price?.recurring?.interval === 'year' ? 'yearly' : 'monthly'
    const periodEnd = sub.current_period_end ? sub.current_period_end * 1000 : null
    const activeStatuses = ['active', 'trialing']
    const newTier = activeStatuses.includes(sub.status) && tierName ? tierName : 'free'

    db.run(
      `UPDATE users SET subscription_tier = ?, stripe_subscription_id = ?,
       stripe_subscription_status = ?, stripe_current_period_end = ?,
       stripe_subscription_interval = ? WHERE id = ?`,
      newTier, sub.id, sub.status, periodEnd, interval, userId
    )
  }
}

export default stripePlugin
