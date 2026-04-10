import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

let _cache = null  // { checkedAt, current, latest, updateAvailable }
let _current = null

function getCurrentVersion() {
  if (_current) return _current
  try {
    const data = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'))
    _current = data.version || '0.0.0'
  } catch { _current = '0.0.0' }
  return _current
}

// Reload current version from disk (call after git pull)
export function reloadCurrentVersion() {
  _current = null
  return getCurrentVersion()
}

// Compare two x.y.z version strings treating each segment as an integer.
// Returns 1 if a > b, -1 if a < b, 0 if equal.
function compareVersions(a, b) {
  const pa = String(a || '0.0.0').split('.').map(s => parseInt(s, 10) || 0)
  const pb = String(b || '0.0.0').split('.').map(s => parseInt(s, 10) || 0)
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1
    if (pa[i] < pb[i]) return -1
  }
  return 0
}

function repoToRawUrl(repoUrl) {
  const clean = (repoUrl || '').replace(/\.git$/, '').replace(/\/$/, '')
  const match = clean.match(/github\.com\/([^/]+\/[^/]+)/)
  if (!match) return null
  return `https://raw.githubusercontent.com/${match[1]}/main/package.json`
}

export async function checkForUpdates(repoUrl, { force = false, maxAgeHours = 24 } = {}) {
  if (!force && _cache?.checkedAt) {
    const ageMs = Date.now() - _cache.checkedAt
    if (ageMs < maxAgeHours * 3600 * 1000) return _cache
  }

  const baseUrl = repoToRawUrl(repoUrl || 'https://github.com/ryangriggs/is')
  if (!baseUrl) {
    console.log('[updater] Invalid repo URL, skipping check')
    return null
  }

  // Append a cache-busting timestamp so GitHub's CDN always returns the latest file
  const rawUrl = `${baseUrl}?cb=${Date.now()}`

  console.log(`[updater] Checking for updates at: ${baseUrl}`)
  try {
    const res = await fetch(rawUrl, {
      signal: AbortSignal.timeout(10000),
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' },
    })
    if (!res.ok) {
      console.log(`[updater] Remote check failed: HTTP ${res.status}`)
      return null
    }
    const data = await res.json()
    const latest = data.version
    const current = getCurrentVersion()
    const updateAvailable = compareVersions(latest, current) > 0
    _cache = { checkedAt: Date.now(), current, latest, updateAvailable }
    console.log(`[updater] Current: ${current}, Latest: ${latest}, Update available: ${updateAvailable}`)
    return _cache
  } catch (err) {
    console.log('[updater] Check error:', err.message)
    return null
  }
}

export function getUpdateStatus() {
  const current = getCurrentVersion()
  if (!_cache) return { current, latest: null, updateAvailable: false, checkedAt: null }
  return { ..._cache, current }
}

export function invalidateCache() {
  _cache = null
}
