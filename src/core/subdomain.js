/**
 * Extract the subdomain from a hostname given the base domain.
 * Examples (baseDomain = 'is.am'):
 *   'is.am'          → ''
 *   'www.is.am'      → 'www'
 *   'l.is.am'        → 'l'
 *   'myname.is.am'   → 'myname'
 *   'localhost'      → ''
 */
export function extractSubdomain(hostname, baseDomain) {
  // Strip port
  const host = (hostname || '').split(':')[0].toLowerCase()
  const base = baseDomain.toLowerCase()

  if (host === base || host === `www.${base}`) return ''
  if (host.endsWith(`.${base}`)) {
    return host.slice(0, host.length - base.length - 1)
  }
  // Running locally on localhost — no subdomains
  return ''
}

// Single-letter subdomains reserved for system features
export const FEATURE_SUBDOMAINS = new Set(['l', 't', 'h', 'i', 'b', 'd', 'q', 'a'])

export function isFeatureSubdomain(sub) {
  return sub.length === 1 && FEATURE_SUBDOMAINS.has(sub)
}

export function isUserSubdomain(sub) {
  return sub.length >= 3
}

export function isReservedSubdomain(sub) {
  return sub.length > 0 && sub.length <= 2 && !FEATURE_SUBDOMAINS.has(sub)
}
