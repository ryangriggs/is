import { encode, isReserved, normalizeCode } from './shortcode.js'
import { hashToken, generateToken } from './auth.js'
import { getSetting } from './settings-cache.js'

// Shared link creation logic used by all content plugins.
// Returns { link, plainToken } where plainToken is set for anonymous creators.
export async function createLink(db, hooks, { type, destination, title, meta, isPrivate, isEncrypted, burnOnRead, expiresAt, ownerId, req }) {
  const isAnon = !ownerId
  const plainToken = isAnon ? generateToken(32) : null
  const tokenHash = plainToken ? await hashToken(plainToken) : null

  const insertData = {
    type,
    destination,
    ownerId: ownerId || null,
    manageTokenHash: tokenHash,
    title: title || null,
    meta: meta ? JSON.stringify(meta) : null,
    isPrivate: isPrivate ? 1 : 0,
    isEncrypted: isEncrypted ? 1 : 0,
    burnOnRead: burnOnRead ? 1 : 0,
    expiresAt: expiresAt || null,
    createdAt: Date.now(),
    createdIp: req?.ip || '',
  }

  await hooks.run('pre:link:create', { data: insertData, req })

  const link = db.transaction(() => {
    let id, code
    const minLen = parseInt(getSetting('min_shortcode_length') || '0', 10) || 0

    // Insert placeholder rows to burn IDs whose codes are reserved route paths
    // or shorter than the configured minimum length.
    // encode() is a pure bijective base conversion — no collisions possible —
    // so we simply increment past any unwanted ID by marking it as consumed.
    do {
      const tmp = '__tmp_' + Date.now().toString(36) + Math.random().toString(36).slice(2)
      const info = db.run(
        `INSERT INTO links(type, is_active, created_at, code) VALUES('reserved', 0, ?, ?)`,
        insertData.createdAt, tmp
      )
      id = info.lastInsertRowid
      code = normalizeCode(encode(id))
      if (isReserved(code) || (minLen > 0 && code.length < minLen)) {
        // Brand this placeholder with the reserved code so it's permanently consumed
        db.run('UPDATE links SET code = ? WHERE id = ?', code, id)
      }
      // If code is taken by a legacy row (old escape logic left colliding codes),
      // the placeholder keeps its tmp code and we loop to the next ID
    } while (isReserved(code) || (minLen > 0 && code.length < minLen) || db.get('SELECT id FROM links WHERE code = ? AND id != ?', code, id))

    // Update the winning row with the actual link data
    db.run(
      `UPDATE links SET type=?, destination=?, owner_id=?, manage_token_hash=?, title=?, meta=?,
       is_private=?, is_encrypted=?, burn_on_read=?, expires_at=?, is_active=1, created_ip=?, code=? WHERE id=?`,
      insertData.type, insertData.destination, insertData.ownerId,
      insertData.manageTokenHash, insertData.title, insertData.meta,
      insertData.isPrivate, insertData.isEncrypted, insertData.burnOnRead, insertData.expiresAt,
      insertData.createdIp, code, id
    )
    return db.get('SELECT * FROM links WHERE id = ?', id)
  })()

  await hooks.run('post:link:create', { link, req })

  return { link, plainToken }
}
