export function ipToInt(ip) {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  return parts.reduce((acc, oct) => ((acc << 8) | (parseInt(oct, 10) & 0xff)) >>> 0, 0) >>> 0
}

export function ipMatchesCidr(ip, cidr) {
  if (!cidr.includes('/')) return ip === cidr
  const [addr, bitsStr] = cidr.split('/')
  const bits = parseInt(bitsStr, 10)
  if (isNaN(bits) || bits < 0 || bits > 32) return false
  const ipInt = ipToInt(ip)
  const addrInt = ipToInt(addr)
  if (ipInt === null || addrInt === null) return false
  if (bits === 0) return true
  const mask = (~0 << (32 - bits)) >>> 0
  return (ipInt & mask) >>> 0 === (addrInt & mask) >>> 0
}

// entries: [{cidr, type}] where type is 'block' or 'unblock'
// Order: netmask blocks → individual IP blocks → unblocks (unblocks win)
export function isIpBlocked(ip, entries) {
  if (!ip || !entries || !entries.length) return false
  let blocked = false
  for (const e of entries) {
    if (e.type === 'block' && e.cidr.includes('/') && ipMatchesCidr(ip, e.cidr)) blocked = true
  }
  for (const e of entries) {
    if (e.type === 'block' && !e.cidr.includes('/') && ip === e.cidr) blocked = true
  }
  for (const e of entries) {
    if (e.type === 'unblock' && ipMatchesCidr(ip, e.cidr)) blocked = false
  }
  return blocked
}
