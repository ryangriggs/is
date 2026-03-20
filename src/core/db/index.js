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
      'ALTER TABLE blocked_ips ADD COLUMN type TEXT NOT NULL DEFAULT \'block\'',
    ]
    for (const stmt of addColumns) {
      try { sqlite.prepare(stmt).run() } catch (_) { /* column already exists */ }
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
