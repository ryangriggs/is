#!/usr/bin/env node
// Increments the patch (third) segment of package.json version on each commit.
// Major (x) and minor (y) in x.y.z are updated manually.

import { readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkgPath = join(__dirname, '..', 'package.json')

const raw = readFileSync(pkgPath, 'utf8')
const pkg = JSON.parse(raw)

const parts = String(pkg.version || '1.0.0').split('.')
if (parts.length < 3) parts.push('0')
parts[2] = String(parseInt(parts[2], 10) + 1)
pkg.version = parts.join('.')

// Write back preserving 2-space indent and a trailing newline
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
process.stdout.write(`[version] ${parts.slice(0,2).join('.')}.${parseInt(parts[2])-1} → ${pkg.version}\n`)
