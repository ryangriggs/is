import config from '../config.js'
import { encode, isReserved, normalizeCode } from './shortcode.js'

const ESCAPE_CHAR = config.SHORTLINK_CHARS[0]
import { hashToken, generateToken } from './auth.js'

// Shared link creation logic used by all content plugins.
// Returns { link, plainToken } where plainToken is set for anonymous creators.
export async function createLink(db, hooks, { type, destination, title, meta, isPrivate, ownerId, req }) {
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
    createdAt: Date.now(),
    createdIp: req?.ip || '',
  }

  await hooks.run('pre:link:create', { data: insertData, req })

  const link = db.transaction(() => {
    const info = db.run(
      `INSERT INTO links(type, destination, owner_id, manage_token_hash, title, meta, is_private, is_active, created_at, created_ip, code)
       VALUES(?,?,?,?,?,?,?,1,?,?,'')`,
      insertData.type, insertData.destination, insertData.ownerId,
      insertData.manageTokenHash, insertData.title, insertData.meta,
      insertData.isPrivate, insertData.createdAt, insertData.createdIp
    )
    const id = info.lastInsertRowid
    let code = encode(id)
    // Escape reserved codes by appending a char
    if (isReserved(code)) code = code + ESCAPE_CHAR
    db.run('UPDATE links SET code = ? WHERE id = ?', normalizeCode(code), id)
    return db.get('SELECT * FROM links WHERE id = ?', id)
  })()

  await hooks.run('post:link:create', { link, req })

  return { link, plainToken }
}
