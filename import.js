/**
 * import.js — Migration from old PHP is.am (MySQL) to new Node.js (SQLite)
 *
 * Run from the project root:
 *   NODE_OPTIONS=--experimental-sqlite node import.js
 *
 * Place the exported JSON files in ./import/ before running:
 *   import/links.json      — required
 *   import/bookmarks.json  — optional
 *   import/track.json      — optional (visit history)
 *
 * The script is safe to re-run: existing codes are skipped, not duplicated.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { nanoid } from 'nanoid'

// ----------------------------------------------------------------
// Config — override with env vars if needed
// ----------------------------------------------------------------
const DB_PATH    = process.env.SQLITE_PATH || 'data/db.sqlite'
const PASTE_DIR  = join(process.cwd(), 'data', 'pastes')
const IMPORT_DIR = join(process.cwd(), 'import')

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------
function readJson(filename) {
  const p = join(IMPORT_DIR, filename)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch (e) {
    console.error(`Failed to parse ${filename}: ${e.message}`)
    process.exit(1)
  }
}

function log(msg) { console.log(msg) }

function tsToMs(val) {
  if (!val) return Date.now()
  // MySQL datetime string: "2024-03-15 14:22:01"
  if (typeof val === 'string' && val.includes('-')) return new Date(val).getTime() || Date.now()
  // Unix timestamp (seconds)
  const n = Number(val)
  return n > 1e10 ? n : n * 1000
}

// ----------------------------------------------------------------
// Open database
// ----------------------------------------------------------------
if (!existsSync(DB_PATH)) {
  console.error(`Database not found at ${DB_PATH}`)
  console.error('Make sure the app has been started at least once to initialise the DB.')
  process.exit(1)
}

const sqlite = new DatabaseSync(DB_PATH)
sqlite.exec('PRAGMA journal_mode = WAL')
sqlite.exec('PRAGMA foreign_keys = OFF')

mkdirSync(PASTE_DIR, { recursive: true })

log('=== is.am Migration ===\n')

// ----------------------------------------------------------------
// 1. Links — URL shortlinks, text pastes, HTML pastes
// ----------------------------------------------------------------
const links = readJson('links.json')

if (!links) {
  log('⚠  import/links.json not found — skipping links')
} else {
  log(`Processing ${links.length} links...`)

  const checkCode  = sqlite.prepare('SELECT id FROM links WHERE code = ?')
  const insertLink = sqlite.prepare(`
    INSERT OR IGNORE INTO links
      (code, type, destination, is_active, created_at, created_ip, file_size)
    VALUES (?, ?, ?, 1, ?, ?, ?)
  `)

  const counts = { url: 0, text: 0, html: 0, conflict: 0, skipped: 0 }

  sqlite.exec('BEGIN')

  for (const row of links) {
    const code = row.code   // pre-computed by export.php using id_to_key()
    const ip   = row.ip || null
    const now  = Date.now()
    const type = Number(row.type)

    // Skip if code already exists in the new DB (idempotent re-runs)
    if (checkCode.get(code)) {
      counts.conflict++
      continue
    }

    if (type === 0) {
      // ---- URL shortlink ----
      const dest = (row.link || '').trim()
      if (!dest || (!dest.startsWith('http') && !dest.startsWith('ftp'))) {
        counts.skipped++
        continue
      }
      insertLink.run(code, 'url', dest, now, ip, null)
      counts.url++

    } else if (type === 1) {
      // ---- Text paste ----
      const content  = row.content ?? ''
      const filename = nanoid(16) + '.txt'
      writeFileSync(join(PASTE_DIR, filename), content, 'utf8')
      const byteSize = Buffer.byteLength(content, 'utf8')
      insertLink.run(code, 'text', filename, now, ip, byteSize)
      counts.text++

    } else if (type === 2) {
      // ---- HTML paste ----
      const content  = row.content ?? ''
      const filename = nanoid(16) + '.html'
      writeFileSync(join(PASTE_DIR, filename), content, 'utf8')
      const byteSize = Buffer.byteLength(content, 'utf8')
      insertLink.run(code, 'html', filename, now, ip, byteSize)
      counts.html++

    } else {
      counts.skipped++
    }
  }

  sqlite.exec('COMMIT')

  log(`  ✓ URL shortlinks: ${counts.url}`)
  log(`  ✓ Text pastes:    ${counts.text}`)
  log(`  ✓ HTML pastes:    ${counts.html}`)
  if (counts.conflict) log(`  ⚠ Already existed (skipped): ${counts.conflict}`)
  if (counts.skipped)  log(`  - Invalid/unsupported type (skipped): ${counts.skipped}`)
}

// ----------------------------------------------------------------
// 2. Bookmarks — one link per user_code collection
// ----------------------------------------------------------------
const bookmarks = readJson('bookmarks.json')

if (!bookmarks) {
  log('\n⚠  import/bookmarks.json not found — skipping bookmarks')
} else {
  // Group by user_code
  const byUser = {}
  for (const b of bookmarks) {
    const uc = b.user_code || 'unknown'
    ;(byUser[uc] = byUser[uc] || []).push(b)
  }

  const userCount = Object.keys(byUser).length
  log(`\nProcessing ${bookmarks.length} bookmarks across ${userCount} collections...`)

  const checkCode  = sqlite.prepare('SELECT id FROM links WHERE code = ?')
  const insertColl = sqlite.prepare(`
    INSERT INTO links (code, type, destination, title, is_active, created_at)
    VALUES (?, 'bookmark', '', ?, 1, ?)
  `)
  const insertItem = sqlite.prepare(`
    INSERT INTO bookmark_items
      (link_id, url, title, folder, sort_order, created_at, shortlink_code)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)

  let collCount = 0
  let itemCount = 0

  sqlite.exec('BEGIN')

  for (const [userCode, items] of Object.entries(byUser)) {
    // Use user_code as link code; fall back to nanoid if already taken
    let code = userCode
    if (checkCode.get(code)) code = nanoid(8)

    const createdAt = tsToMs(items[0]?.date)
    const result    = insertColl.run(code, userCode, createdAt)
    const linkId    = Number(result.lastInsertRowid)
    if (!linkId) continue
    collCount++

    let order = 0
    for (const item of items) {
      insertItem.run(
        linkId,
        item.url   || '',
        item.title || item.url || '',
        item.category  || null,
        order++,
        tsToMs(item.date),
        item.shortlink || null   // preserves old shortlink code reference
      )
      itemCount++
    }
  }

  sqlite.exec('COMMIT')

  log(`  ✓ Collections: ${collCount}`)
  log(`  ✓ Items:       ${itemCount}`)
}

// ----------------------------------------------------------------
// 3. Tracking — visit history (optional, can be large)
// ----------------------------------------------------------------
const track = readJson('track.json')

if (!track) {
  log('\n  (No import/track.json found — visit history not imported)')
} else {
  log(`\nProcessing ${track.length} tracking records...`)

  // Build code → new link_id lookup from the full links table
  const codeToId = new Map()
  for (const row of sqlite.prepare('SELECT id, code FROM links').all()) {
    codeToId.set(row.code, row.id)
  }

  const insertTrack = sqlite.prepare(`
    INSERT INTO tracking (link_id, visited_at, ip, user_agent, referer)
    VALUES (?, ?, ?, ?, ?)
  `)

  let tracked = 0
  let missed  = 0

  sqlite.exec('BEGIN')

  for (const row of track) {
    const linkId = codeToId.get(row.link)
    if (!linkId) { missed++; continue }

    insertTrack.run(
      linkId,
      tsToMs(row.date),
      row.ip       || null,
      row.browser  || null,
      row.referral || null
    )
    tracked++

    // Commit in batches to avoid holding a huge transaction
    if (tracked % 10000 === 0) {
      sqlite.exec('COMMIT')
      sqlite.exec('BEGIN')
      log(`  ... ${tracked.toLocaleString()} tracking records inserted`)
    }
  }

  sqlite.exec('COMMIT')

  log(`  ✓ Tracking records imported: ${tracked.toLocaleString()}`)
  if (missed) log(`  ⚠ No matching link found:    ${missed.toLocaleString()}`)
}

// ----------------------------------------------------------------
// Done
// ----------------------------------------------------------------
sqlite.exec('PRAGMA foreign_keys = ON')
log('\n✅ Migration complete.\n')
