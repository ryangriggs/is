// Tier limit enforcement helpers

export function getTierForUser(userId, db) {
  let tierName = 'free'
  if (userId) {
    const user = db.get('SELECT subscription_tier FROM users WHERE id = ?', userId)
    tierName = user?.subscription_tier || 'free'
  }
  return db.get('SELECT * FROM account_tiers WHERE name = ?', tierName) || { name: 'free', max_links_per_hour: 10, max_file_size_mb: 10, allow_raw_html: 1, show_ads: 1, max_ddns_entries: 3, max_links_total: 0, max_images_total: 0, max_text_total: 0 }
}

// Called from pre:link:create hook — throws if limit exceeded
export function checkLinkLimits(data, db) {
  const { ownerId, type } = data
  if (!ownerId) return  // anonymous limits handled by settings.max_links_anonymous

  const tier = getTierForUser(ownerId, db)

  // Hourly rate limit
  if (tier.max_links_per_hour > 0) {
    const since = Date.now() - 3600000
    const { n } = db.get('SELECT COUNT(*) as n FROM links WHERE owner_id = ? AND created_at > ?', ownerId, since)
    if (n >= tier.max_links_per_hour) {
      throw Object.assign(
        new Error(`Hourly limit reached (${tier.max_links_per_hour}/hr). Try again later or upgrade your plan.`),
        { statusCode: 429 }
      )
    }
  }

  // Total links
  if (tier.max_links_total > 0) {
    const { n } = db.get('SELECT COUNT(*) as n FROM links WHERE owner_id = ?', ownerId)
    if (n >= tier.max_links_total) {
      throw Object.assign(
        new Error(`Total link limit reached (${tier.max_links_total}). Upgrade your plan to create more.`),
        { statusCode: 422 }
      )
    }
  }

  // Images
  if (type === 'image' && tier.max_images_total > 0) {
    const { n } = db.get(`SELECT COUNT(*) as n FROM links WHERE owner_id = ? AND type = 'image'`, ownerId)
    if (n >= tier.max_images_total) {
      throw Object.assign(
        new Error(`Image limit reached (${tier.max_images_total}). Upgrade your plan.`),
        { statusCode: 422 }
      )
    }
  }

  // Text/HTML pastes
  if ((type === 'text' || type === 'html') && tier.max_text_total > 0) {
    const { n } = db.get(`SELECT COUNT(*) as n FROM links WHERE owner_id = ? AND type IN ('text','html')`, ownerId)
    if (n >= tier.max_text_total) {
      throw Object.assign(
        new Error(`Text paste limit reached (${tier.max_text_total}). Upgrade your plan.`),
        { statusCode: 422 }
      )
    }
  }

  // HTML pastes allowed?
  if (type === 'html' && !tier.allow_raw_html) {
    throw Object.assign(
      new Error('HTML pastes are not available on your current plan. Upgrade to enable this feature.'),
      { statusCode: 403 }
    )
  }
}
