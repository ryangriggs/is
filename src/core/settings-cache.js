// In-memory settings cache — loads all settings once at startup, refreshes every 60s.
// Eliminates per-request DB queries for global config values.

let _cache = new Map()
let _db = null

export function initSettingsCache(db) {
  _db = db
  _load()
  setInterval(_load, 60_000).unref()
}

function _load() {
  if (!_db) return
  try {
    const rows = _db.all('SELECT key, value FROM settings')
    const next = new Map()
    for (const r of rows) next.set(r.key, r.value ?? null)
    _cache = next
  } catch (_) {}
}

/** Get a single setting value, or defaultValue if not found. */
export function getSetting(key, defaultValue = null) {
  return _cache.has(key) ? _cache.get(key) : defaultValue
}

/** Return all settings as a plain object. */
export function getAllSettings() {
  return Object.fromEntries(_cache)
}

/** Force an immediate reload — call after any admin settings save. */
export function invalidateSettingsCache() {
  _load()
}
