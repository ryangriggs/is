import 'dotenv/config'
import { mkdirSync } from 'fs'
import { dirname } from 'path'

import config from './config.js'

// Ensure data and uploads directories exist before DB init
if (config.DB_TYPE === 'sqlite') {
  mkdirSync(dirname(config.SQLITE_PATH), { recursive: true })
}
mkdirSync('uploads', { recursive: true })
mkdirSync('data/pastes', { recursive: true })

import { initDb } from './core/db/index.js'
import { seed } from './core/db/seed.js'
import { buildApp } from './app.js'

async function start() {
  try {
    // Init database
    await initDb()

    // Seed defaults and admin user
    await seed()

    // Build Fastify app
    const app = await buildApp()

    // Start listening
    await app.listen({ port: config.PORT, host: '0.0.0.0' })

    console.log(`\n🚀 is.am running at http://localhost:${config.PORT}`)
    console.log(`   Domain: ${config.BASE_DOMAIN}`)
    console.log(`   DB: ${config.DB_TYPE === 'sqlite' ? config.SQLITE_PATH : config.MYSQL_DATABASE}`)

    // Graceful shutdown
    const shutdown = async (signal) => {
      console.log(`\n${signal} received. Shutting down...`)
      await app.close()
      process.exit(0)
    }
    process.on('SIGTERM', () => shutdown('SIGTERM'))
    process.on('SIGINT', () => shutdown('SIGINT'))

  } catch (err) {
    console.error('Failed to start:', err)
    process.exit(1)
  }
}

start()
