// Returns an ad object { imageUrl, clickUrl } if the link owner's tier has ads enabled,
// or null if ads should not be shown.
export function getAdForOwner(ownerId, db) {
  let showAds = false
  try {
    const tierName = ownerId
      ? db.get('SELECT subscription_tier FROM users WHERE id = ?', ownerId)?.subscription_tier || 'free'
      : 'free'
    showAds = Boolean(db.get('SELECT show_ads FROM account_tiers WHERE name = ?', tierName)?.show_ads)
  } catch (_) {}

  if (!showAds) return null

  try {
    const ad = db.get(`
      SELECT ai.id, ai.image_path, ac.click_url
      FROM ad_images ai
      JOIN ad_campaigns ac ON ac.id = ai.campaign_id
      WHERE ai.is_approved = 1 AND ac.is_active = 1
        AND (ac.expires_at IS NULL OR ac.expires_at > ?)
      ORDER BY RANDOM() LIMIT 1
    `, Date.now())
    if (!ad) return null
    try { db.run('INSERT INTO ad_impressions(image_id, shown_at) VALUES(?,?)', ad.id, Date.now()) } catch (_) {}
    return { imageUrl: `/uploads/ads/${ad.image_path}`, clickUrl: `/ad/c/${ad.id}` }
  } catch (_) { return null }
}
