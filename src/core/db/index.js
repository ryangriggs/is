import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import config from '../../config.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

let _db = null

// Thin DB wrapper that works for both SQLite (node:sqlite) and MySQL (mysql2)
// All methods synchronous for SQLite, async stubs left for future MySQL support.

export async function initDb() {
  if (_db) return _db

  if (config.DB_TYPE === 'mysql') {
    // MySQL: use mysql2 with promise wrapper
    const mysql2 = await import('mysql2/promise')
    const pool = mysql2.default.createPool({
      host: config.MYSQL_HOST,
      port: config.MYSQL_PORT,
      user: config.MYSQL_USER,
      password: config.MYSQL_PASSWORD,
      database: config.MYSQL_DATABASE,
      waitForConnections: true,
      connectionLimit: 10,
    })
    _db = createMysqlDb(pool)
  } else {
    // SQLite via Node.js built-in (Node 22.5+)
    // Requires: NODE_OPTIONS=--experimental-sqlite  (set in server.js)
    const { DatabaseSync } = await import('node:sqlite')
    const sqlite = new DatabaseSync(config.SQLITE_PATH)
    sqlite.exec('PRAGMA journal_mode = WAL')
    sqlite.exec('PRAGMA foreign_keys = ON')

    // Run initial schema (all statements are CREATE ... IF NOT EXISTS, safe to re-run)
    const sql = readFileSync(
      join(__dirname, 'migrations', '001_initial.sql'),
      'utf8'
    )
    sqlite.exec(sql)

    // Additive column migrations — try/catch because SQLite has no ADD COLUMN IF NOT EXISTS
    const addColumns = [
      'ALTER TABLE dns_records ADD COLUMN ttl INTEGER NOT NULL DEFAULT 300',
      "ALTER TABLE blocked_ips ADD COLUMN type TEXT NOT NULL DEFAULT 'block'",
      'ALTER TABLE users ADD COLUMN display_name TEXT',
      'ALTER TABLE users ADD COLUMN reset_token_hash TEXT',
      'ALTER TABLE users ADD COLUMN reset_token_expires INTEGER',
      'ALTER TABLE scan_words ADD COLUMN hits INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE links ADD COLUMN file_size INTEGER',
      'ALTER TABLE bookmark_items ADD COLUMN shortlink_code TEXT',
      'ALTER TABLE account_tiers ADD COLUMN price REAL NOT NULL DEFAULT 0',
      'ALTER TABLE account_tiers ADD COLUMN description TEXT',
      'ALTER TABLE account_tiers ADD COLUMN is_enabled INTEGER NOT NULL DEFAULT 1',
      'ALTER TABLE account_tiers ADD COLUMN allow_watermark INTEGER NOT NULL DEFAULT 1',
      'ALTER TABLE users ADD COLUMN stripe_customer_id TEXT',
      'ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT',
      'ALTER TABLE users ADD COLUMN stripe_subscription_status TEXT',
      'ALTER TABLE users ADD COLUMN stripe_current_period_end INTEGER',
      'ALTER TABLE users ADD COLUMN stripe_subscription_interval TEXT',
      'ALTER TABLE account_tiers ADD COLUMN stripe_price_id_monthly TEXT',
      'ALTER TABLE account_tiers ADD COLUMN stripe_price_id_yearly TEXT',
      'ALTER TABLE account_tiers ADD COLUMN price_yearly REAL NOT NULL DEFAULT 0',
      "ALTER TABLE account_tiers ADD COLUMN allowed_image_types TEXT NOT NULL DEFAULT 'image/jpeg,image/png,image/gif'",
    ]
    for (const stmt of addColumns) {
      try { sqlite.prepare(stmt).run() } catch (_) { /* column already exists */ }
    }

    // New tables (all IF NOT EXISTS — safe to re-run)
    sqlite.exec(`CREATE TABLE IF NOT EXISTS account_tiers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      label TEXT,
      max_links_total INTEGER NOT NULL DEFAULT 0,
      max_images_total INTEGER NOT NULL DEFAULT 0,
      max_text_total INTEGER NOT NULL DEFAULT 0,
      max_links_per_hour INTEGER NOT NULL DEFAULT 0,
      max_ddns_entries INTEGER NOT NULL DEFAULT 5,
      max_file_size_mb INTEGER NOT NULL DEFAULT 10,
      allow_raw_html INTEGER NOT NULL DEFAULT 1,
      show_ads INTEGER NOT NULL DEFAULT 0,
      allow_ad_campaigns INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    )`)

    sqlite.exec(`CREATE TABLE IF NOT EXISTS ad_campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      click_url TEXT NOT NULL DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    )`)

    sqlite.exec(`CREATE TABLE IF NOT EXISTS ad_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
      image_path TEXT NOT NULL,
      alt_text TEXT,
      is_approved INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    )`)

    sqlite.exec(`CREATE TABLE IF NOT EXISTS ad_clicks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      image_id INTEGER NOT NULL REFERENCES ad_images(id) ON DELETE CASCADE,
      ip TEXT,
      clicked_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    )`)

    sqlite.exec(`CREATE TABLE IF NOT EXISTS ad_impressions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      image_id INTEGER NOT NULL REFERENCES ad_images(id) ON DELETE CASCADE,
      shown_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    )`)

    sqlite.exec(`CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      target_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      details TEXT,
      ip TEXT,
      created_at INTEGER NOT NULL
    )`)

    // Seed default account tiers (only if none exist yet)
    const tierCount = sqlite.prepare('SELECT COUNT(*) as n FROM account_tiers').get()
    if (tierCount.n === 0) {
      sqlite.prepare(`INSERT INTO account_tiers(name,label,max_links_per_hour,max_ddns_entries,max_file_size_mb,allow_raw_html,show_ads,allow_ad_campaigns) VALUES(?,?,?,?,?,?,?,?)`)
        .run('free', 'Free', 10, 3, 10, 1, 1, 0)
      sqlite.prepare(`INSERT INTO account_tiers(name,label,max_links_per_hour,max_ddns_entries,max_file_size_mb,allow_raw_html,show_ads,allow_ad_campaigns) VALUES(?,?,?,?,?,?,?,?)`)
        .run('paid', 'Paid', 100, 50, 100, 1, 0, 1)
    }
    // Ensure built-in anonymous tier always exists (may be missing on older installs)
    const anonTier = sqlite.prepare("SELECT id FROM account_tiers WHERE name = 'anonymous'").get()
    if (!anonTier) {
      sqlite.prepare(`INSERT INTO account_tiers(name,label,max_links_per_hour,max_links_total,max_images_total,max_text_total,max_ddns_entries,max_file_size_mb,allow_raw_html,show_ads,allow_ad_campaigns) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
        .run('anonymous', 'Anonymous (not logged in)', 5, 10, 3, 5, 0, 5, 0, 1, 0)
    }

    _db = createSqliteDb(sqlite)
  }

  return _db
}

export function getDb() {
  if (!_db) throw new Error('Database not initialized. Call initDb() first.')
  return _db
}

// ----------------------------------------------------------------
// SQLite wrapper — synchronous, mirrors API used across plugins
// ----------------------------------------------------------------
function createSqliteDb(sqlite) {
  const stmtCache = new Map()

  function prepare(sql) {
    if (!stmtCache.has(sql)) {
      stmtCache.set(sql, sqlite.prepare(sql))
    }
    return stmtCache.get(sql)
  }

  return {
    // Raw client for direct access
    $client: sqlite,

    // Synchronous query helpers
    // get(sql, ...params) → single row or undefined
    get(sql, ...params) {
      return prepare(sql).get(...params)
    },

    // all(sql, ...params) → array of rows
    all(sql, ...params) {
      return prepare(sql).all(...params)
    },

    // run(sql, ...params) → { changes, lastInsertRowid }
    run(sql, ...params) {
      const info = prepare(sql).run(...params)
      return { changes: info.changes, lastInsertRowid: Number(info.lastInsertRowid) }
    },

    // exec(sql) → for multi-statement SQL
    exec(sql) {
      sqlite.exec(sql)
    },

    // transaction(fn) → wraps fn in BEGIN/COMMIT, returns result
    transaction(fn) {
      return (...args) => {
        sqlite.exec('BEGIN')
        try {
          const result = fn(...args)
          sqlite.exec('COMMIT')
          return result
        } catch (err) {
          sqlite.exec('ROLLBACK')
          throw err
        }
      }
    },
  }
}

// ----------------------------------------------------------------
// MySQL wrapper — async (returns Promises)
// Currently a stub; full implementation in v2
// ----------------------------------------------------------------
function createMysqlDb(pool) {
  return {
    $client: pool,
    async get(sql, ...params) {
      const [rows] = await pool.execute(sql, params)
      return rows[0]
    },
    async all(sql, ...params) {
      const [rows] = await pool.execute(sql, params)
      return rows
    },
    async run(sql, ...params) {
      const [result] = await pool.execute(sql, params)
      return { changes: result.affectedRows, lastInsertRowid: result.insertId }
    },
    async exec(sql) {
      await pool.execute(sql)
    },
    async transaction(fn) {
      const conn = await pool.getConnection()
      await conn.beginTransaction()
      try {
        const result = await fn(conn)
        await conn.commit()
        return result
      } catch (err) {
        await conn.rollback()
        throw err
      } finally {
        conn.release()
      }
    },
  }
}
