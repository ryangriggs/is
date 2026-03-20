import config from '../config.js'

const CHARS = config.SHORTLINK_CHARS
const BASE = CHARS.length

export function encode(n) {
  if (n === 0) return CHARS[0]
  let result = ''
  while (n > 0) {
    result = CHARS[n % BASE] + result
    n = Math.floor(n / BASE)
  }
  return result
}

export function normalizeCode(s) {
  return s.toLowerCase()
}

export function decode(s) {
  let result = 0
  for (const c of normalizeCode(s)) {
    const idx = CHARS.indexOf(c)
    if (idx === -1) return null
    result = result * BASE + idx
  }
  return result
}

// Reserved codes that must never be assigned to links
export const RESERVED_CODES = new Set([
  'success', 'manage', 'report', 'login', 'register', 'logout',
  'dashboard', 'admin', 'static', 'uploads', 'favicon.ico', 'robots.txt',
  'q', 't', 'h', 'i', 'b', 'd', 'a', 'l', 'tokens',
  'ad', 'ads', 'profile', 'contact', 'return-to-admin',
])

export function isReserved(code) {
  return RESERVED_CODES.has(normalizeCode(code))
}
