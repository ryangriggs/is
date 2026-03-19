import { readdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default async function pluginLoader(fastify) {
  const entries = readdirSync(__dirname, { withFileTypes: true })

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const indexPath = join(__dirname, entry.name, 'index.js')
    if (!existsSync(indexPath)) continue

    try {
      const mod = await import(pathToFileURL(indexPath).href)
      const plugin = mod.default
      if (typeof plugin === 'function') {
        await fastify.register(plugin)
        fastify.log.debug(`Loaded plugin: ${entry.name}`)
      }
    } catch (err) {
      fastify.log.error({ err, plugin: entry.name }, 'Failed to load plugin')
      throw err
    }
  }
}
