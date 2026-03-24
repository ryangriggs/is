// Async write buffer for high-frequency INSERT operations.
// Accumulates rows in memory and flushes to DB every 2 seconds in a single transaction.
// Decouples redirect/response latency from analytics writes.

let _db = null
const _tracking = []
const _impressions = []
const FLUSH_MS = 2000
const MAX_BUF = 1000  // flush early if buffer grows large before the interval fires

export function initWriteBuffer(db) {
  _db = db
  setInterval(_flush, FLUSH_MS).unref()
}

export function bufferTracking({ linkId, visitedAt, ip, userAgent, referer }) {
  _tracking.push({ linkId, visitedAt, ip, userAgent, referer })
  if (_tracking.length >= MAX_BUF) _flush()
}

export function bufferImpression(imageId) {
  _impressions.push({ imageId, shownAt: Date.now() })
  if (_impressions.length >= MAX_BUF) _flush()
}

function _flush() {
  if (!_db) return

  if (_tracking.length > 0) {
    const rows = _tracking.splice(0)
    try {
      const insert = _db.transaction(() => {
        for (const r of rows) {
          _db.run(
            'INSERT INTO tracking(link_id, visited_at, ip, user_agent, referer) VALUES(?,?,?,?,?)',
            r.linkId, r.visitedAt, r.ip, r.userAgent, r.referer
          )
        }
      })
      insert()
    } catch (_) {}
  }

  if (_impressions.length > 0) {
    const rows = _impressions.splice(0)
    try {
      const insert = _db.transaction(() => {
        for (const r of rows) {
          _db.run('INSERT INTO ad_impressions(image_id, shown_at) VALUES(?,?)', r.imageId, r.shownAt)
        }
      })
      insert()
    } catch (_) {}
  }
}
