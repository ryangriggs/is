// Scan text or URL against a list of scan_words DB entries
// scope: 'url' = check URL string, 'domain' = check domain only, 'content' = fetch + scan

export function extractDomain(url) {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return url.toLowerCase()
  }
}

export function stripTags(str) {
  return (str || '').replace(/<[^>]*>/g, '').trim()
}

// Returns the matched word if blocked, null if clean
export function scanText(text, words) {
  const lower = (text || '').toLowerCase()
  for (const entry of words) {
    if (!entry.active) continue
    const w = entry.word.toLowerCase()
    if (lower.includes(w)) return entry.word
  }
  return null
}

// Scan a URL (checks url string for 'url' scope, domain for 'domain' scope)
export function scanUrl(url, words) {
  const lower = url.toLowerCase()
  const domain = extractDomain(url)
  for (const entry of words) {
    if (!entry.active) continue
    const w = entry.word.toLowerCase()
    if (entry.scope === 'domain' && domain.includes(w)) return entry.word
    if (entry.scope === 'url' && lower.includes(w)) return entry.word
  }
  return null
}

// Fetch URL content (first maxBytes) and scan it
// Returns matched word or null
export async function scanUrlContent(url, words, maxBytes = 32768) {
  const contentWords = words.filter(e => e.active && e.scope === 'content')
  if (!contentWords.length) return null
  try {
    const ctrl = new AbortController()
    const timeout = setTimeout(() => ctrl.abort(), 5000)
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } })
    clearTimeout(timeout)
    const reader = res.body.getReader()
    let buf = ''
    let received = 0
    while (received < maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      buf += new TextDecoder().decode(value)
      received += value.byteLength
    }
    reader.cancel()
    return scanText(stripTags(buf), contentWords)
  } catch {
    return null
  }
}
