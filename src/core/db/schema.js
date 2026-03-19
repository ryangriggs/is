import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  username: text('username').unique().notNull(),
  email: text('email').unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull().default('user'),
  isBlocked: integer('is_blocked', { mode: 'boolean' }).default(false),
  subscriptionTier: text('subscription_tier').default('free'),
  createdAt: integer('created_at').notNull(),
  lastLogin: integer('last_login'),
})

export const links = sqliteTable('links', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  code: text('code').unique().notNull().default(''),
  type: text('type').notNull().default('url'),
  destination: text('destination'),
  title: text('title'),
  ownerId: integer('owner_id').references(() => users.id, { onDelete: 'set null' }),
  manageTokenHash: text('manage_token_hash'),
  passwordHash: text('password_hash'),
  isActive: integer('is_active', { mode: 'boolean' }).default(true),
  isPrivate: integer('is_private', { mode: 'boolean' }).default(false),
  expiresAt: integer('expires_at'),
  createdAt: integer('created_at').notNull(),
  createdIp: text('created_ip'),
  meta: text('meta'),
})

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }),
  data: text('data').notNull(),
  expiresAt: integer('expires_at').notNull(),
  createdAt: integer('created_at').notNull(),
})

export const apiTokens = sqliteTable('api_tokens', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  label: text('label'),
  lastUsed: integer('last_used'),
  createdAt: integer('created_at').notNull(),
})

export const tracking = sqliteTable('tracking', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  linkId: integer('link_id').notNull().references(() => links.id, { onDelete: 'cascade' }),
  visitedAt: integer('visited_at').notNull(),
  ip: text('ip'),
  userAgent: text('user_agent'),
  referer: text('referer'),
})

export const reports = sqliteTable('reports', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  linkId: integer('link_id').notNull().references(() => links.id, { onDelete: 'cascade' }),
  reporterIp: text('reporter_ip'),
  reason: text('reason'),
  status: text('status').notNull().default('pending'),
  createdAt: integer('created_at').notNull(),
})

export const blockedIps = sqliteTable('blocked_ips', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  cidr: text('cidr').notNull(),
  reason: text('reason'),
  blockedBy: integer('blocked_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: integer('created_at').notNull(),
})

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value'),
  updatedAt: integer('updated_at'),
})

export const dnsRecords = sqliteTable('dns_records', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  subdomain: text('subdomain').unique().notNull(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }),
  ip4: text('ip4'),
  ip6: text('ip6'),
  secretKeyHash: text('secret_key_hash'),
  updatedAt: integer('updated_at').notNull(),
  createdAt: integer('created_at').notNull(),
})
