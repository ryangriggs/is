import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

let _cache = null  // { checkedAt, current, latest, updateAvailable }
let _current = null

function getCurrentVersion() {
  if (_current) return _current
  try {
    const data = JSON.parse(readFileSync(join(__dirname, '../../version.json'), 'utf8'))
    _current = data.version || '0.0.0'
  } catch { _current = '0.0.0' }
  return _current
}

// Reload current version from disk (call after git pull)
export function reloadCurrentVersion() {
  _current = null
  return getCurrentVersion()
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1
    if ((pa[i] || 0) < (pb[i] || 0)) return -1
  }
  return 0
}

function repoToRawUrl(repoUrl) {
  const clean = (repoUrl || '').replace(/\.git$/, '').replace(/\/$/, '')
  const match = clean.match(/github\.com\/([^/]+\/[^/]+)/)
  if (!match) return null
  return `https://raw.githubusercontent.com/${match[1]}/main/version.json`
}

export async function checkForUpdates(repoUrl, { force = false, maxAgeHours = 24 } = {}) {
  if (!force && _cache?.checkedAt) {
    const ageMs = Date.now() - _cache.checkedAt
    if (ageMs < maxAgeHours * 3600 * 1000) return _cache
  }

  const rawUrl = repoToRawUrl(repoUrl || 'https://github.com/ryangriggs/is')
  if (!rawUrl) {
    console.log('[updater] Invalid repo URL, skipping check')
    return null
  }

  console.log(`[updater] Checking for updates at: ${rawUrl}`)
  try {
    const res = await fetch(rawUrl, { signal: AbortSignal.timeout(10000), cache: 'no-store' })
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
