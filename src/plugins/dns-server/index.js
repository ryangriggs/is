import fp from 'fastify-plugin'
import dns2 from 'dns2'
import { extractSubdomain } from '../../core/subdomain.js'
import config from '../../config.js'

const { Packet } = dns2

async function dnsServerPlugin(fastify) {
  if (!config.DNS_ENABLED) {
    fastify.log.info('DNS server disabled (DNS_ENABLED=false)')
    return
  }

  const db = fastify.db

  // Cache blocked CIDR list in memory
  let cachedRecords = null
  let cacheTime = 0
  const CACHE_TTL = 30000 // 30 seconds

  function getRecord(subdomain) {
    const now = Date.now()
    if (!cachedRecords || now - cacheTime > CACHE_TTL) {
      cachedRecords = Object.fromEntries(
        db.all('SELECT subdomain, ip4, ip6 FROM dns_records')
          .map(r => [r.subdomain, r])
      )
      cacheTime = now
    }
    return cachedRecords[subdomain] || null
  }

  const server = dns2.createServer({
    udp: true,
    handle: async (request, send) => {
      const response = Packet.createResponseFromRequest(request)

      for (const question of request.questions) {
        const name = question.name.toLowerCase()
        const dynApex = `${config.DYN_SUBDOMAIN}.${config.BASE_DOMAIN}`
        const sub = extractSubdomain(name, dynApex)

        if (!sub || sub.length < 1) continue

        const record = getRecord(sub)
        if (!record) continue

        if (question.type === Packet.TYPE.A && record.ip4) {
          response.answers.push({
            name: question.name,
            type: Packet.TYPE.A,
            class: Packet.CLASS.IN,
            ttl: 300,
            address: record.ip4,
          })
        }

        if (question.type === Packet.TYPE.AAAA && record.ip6) {
          response.answers.push({
            name: question.name,
            type: Packet.TYPE.AAAA,
            class: Packet.CLASS.IN,
            ttl: 300,
            address: record.ip6,
          })
        }
      }

      // If no answers found, try upstream forwarding
      if (response.answers.length === 0 && config.DNS_UPSTREAM) {
        try {
          const client = new dns2.UDPClient({ dns: config.DNS_UPSTREAM })
          const upstream = await client.resolve(
            request.questions[0]?.name,
            request.questions[0]?.type === Packet.TYPE.AAAA ? 'AAAA' : 'A'
          )
          if (upstream.answers?.length) {
            response.answers.push(...upstream.answers)
          }
        } catch (_) {
          // Upstream failed — return empty response (NOERROR, no answers)
        }
      }

      send(response)
    }
  })

  server.on('error', (err) => {
    fastify.log.error({ err }, 'DNS server error')
  })

  await new Promise((resolve, reject) => {
    server.listen({ udp: { port: config.DNS_PORT, address: '0.0.0.0' } })
    server.on('listening', () => {
      fastify.log.info(`DNS server listening on UDP :${config.DNS_PORT}`)
      resolve()
    })
    server.on('error', reject)
    // Resolve after short delay if no listening event (dns2 may not emit it)
    setTimeout(resolve, 500)
  })

  // Invalidate cache when a DNS record changes (exposed via fastify decorator)
  fastify.decorate('invalidateDnsCache', () => {
    cachedRecords = null
  })

  fastify.addHook('onClose', async () => {
    server.close()
  })
}

export default fp(dnsServerPlugin, { name: 'dns-server' })
