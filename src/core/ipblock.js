import { isIpBlocked } from './cidr.js'

let cache = null
let cacheTime = 0
const TTL = 30000

export function invalidateIpCache() {
  cache = null
}

export function checkIpBlocked(ip, db) {
  const now = Date.now()
  if (!cache || now - cacheTime > TTL) {
    cache = db.all('SELECT cidr, type FROM blocked_ips')
    cacheTime = now
  }
  return isIpBlocked(ip, cache)
}
