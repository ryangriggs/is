# is.am

A self-hosted URL shortener, pastebin, image host, bookmarks manager, QR code generator, and dynamic DNS platform — all on one domain.

## Features

- **URL Shortener** — shortest possible codes, grows as DB grows
- **Text & HTML Pastes** — share text or rendered HTML via short code
- **Image Upload** — JPEG, PNG, GIF, WebP
- **Bookmarks** — collections with folders, public or private, shareable via short code
- **QR Codes** — generate QR for any URL, download as PNG
- **Dynamic DNS** — point subdomains to your IP, update via cron/script
- **JSON API** — full API with Bearer token auth
- **Admin panel** — manage users, links, reports, blocked IPs, settings
- **Anonymous links** — no account required, managed via one-time token

---

## Requirements

- Node.js 22.5+ (required for built-in `node:sqlite`)
- nginx (for SSL termination and subdomain redirects)
- A domain with wildcard DNS (`*.yourdomain.com → your server IP`)

---

## Installation

```bash
git clone https://github.com/your-repo/is.am
cd is.am
npm install
cp .env.example .env
# Edit .env with your settings
```

### First run

```bash
node --experimental-sqlite src/server.js
```

On first startup the app will:
- Create the SQLite database and run migrations
- Create an admin account and print a random password to the console — save it

---

## Configuration

Copy `.env.example` to `.env` and edit:

| Variable | Description | Default |
|---|---|---|
| `BASE_DOMAIN` | Your domain | `is.am` |
| `PORT` | Port the app listens on | `3000` |
| `SESSION_SECRET` | Long random string for session signing | — |
| `DB_TYPE` | `sqlite` or `mysql` | `sqlite` |
| `SQLITE_PATH` | Path to SQLite database file | `./data/isam.db` |
| `DNS_ENABLED` | Enable built-in authoritative DNS server | `false` |
| `DNS_PORT` | UDP port for DNS server | `5300` |
| `SHORTLINK_CHARS` | Characters used in short codes (lowercase recommended) | `abcdefghijklmnopqrstuvwxyz0123456789` |
| `IMAGE_MAX_BYTES` | Max image upload size in bytes | `10485760` (10 MB) |
| `SITE_NAME` | Branding name | `is.am` |
| `SITE_TAGLINE` | Branding tagline | — |
| `ADMIN_EMAIL` | Admin account email | — |
| `ADMIN_PASSWORD` | Set to pre-configure admin password; leave blank to auto-generate | — |
| `THEME` | Theme folder name inside `src/themes/` | `default` |

---

## nginx Setup

### 1. Wildcard SSL certificate

A wildcard cert is required to serve feature subdomains (`t.`, `q.`, etc.) over HTTPS. Standard certbot HTTP validation cannot issue wildcard certs — you must use DNS validation:

```bash
certbot certonly --manual \
  -d yourdomain.com \
  -d *.yourdomain.com \
  --preferred-challenges dns
```

Certbot will prompt you to add a `_acme-challenge` TXT record to your DNS. Add it, wait for propagation, then confirm. You can check propagation with:

```bash
dig TXT _acme-challenge.yourdomain.com +short
```

> **Note:** `--manual` certs do not auto-renew. For automated renewal, install a DNS provider plugin (e.g. `certbot-dns-cloudflare`, `certbot-dns-digitalocean`) and re-issue using that plugin instead.

### 2. nginx config

Copy `nginx.conf` from this repo to `/etc/nginx/sites-available/yourdomain` and replace all instances of `optizo.com` with your domain.

```bash
cp nginx.conf /etc/nginx/sites-available/yourdomain
ln -s /etc/nginx/sites-available/yourdomain /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

The config:
- Terminates SSL and proxies all traffic to the Node app
- Redirects `t/h/i/b/d/q/a/l.yourdomain.com` → `yourdomain.com/t` etc.
- Redirects HTTP → HTTPS for apex and all subdomains

### 3. DNS

Point a wildcard `A` record at your server:

```
*.yourdomain.com  →  your.server.ip
yourdomain.com    →  your.server.ip
```

### 4. Dynamic DNS (optional)

If you want to use the built-in authoritative DNS server (for `dyn.yourdomain.com` subdomains):

1. Set `DNS_ENABLED=true` and `DNS_PORT=5300` in `.env`
2. At your registrar, add an NS delegation: `dyn.yourdomain.com NS your.server.hostname`
3. Map host port 53/udp → container port 5300/udp (see `docker-compose.yml`)

Users can then add DNS records via the `/d` UI and update their IP via:

```bash
curl "https://yourdomain.com/d/update?host=myhome&key=SECRET_KEY&ip=$(curl -s https://api.ipify.org)"
```

---

## Running as a service

Create `/etc/systemd/system/isam.service`:

```ini
[Unit]
Description=is.am
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/home/youruser/is.am
ExecStart=/usr/bin/node --experimental-sqlite src/server.js
Restart=on-failure
EnvironmentFile=/home/youruser/is.am/.env

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable isam
systemctl start isam
```

---

## API

The JSON API is available at `/a`. Authenticate with a Bearer token created at `/tokens`.

```bash
# Create a short link
curl -X POST https://yourdomain.com/a/links \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}'
```

See `/a` for the full endpoint list.

---

## Docker

```bash
docker-compose up -d
```

See `docker-compose.yml` for volume and port configuration.
