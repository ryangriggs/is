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
| **Core** | | |
| `NODE_ENV` | `development` or `production` | `development` |
| `BASE_DOMAIN` | Your domain | `is.am` |
| `PORT` | Port the app listens on | `3000` |
| `SESSION_SECRET` | Long random string for session signing — change this in production | — |
| **Database** | | |
| `DB_TYPE` | `sqlite` or `mysql` | `sqlite` |
| `SQLITE_PATH` | Path to SQLite database file | `./data/isam.db` |
| `MYSQL_HOST` | MySQL host (when `DB_TYPE=mysql`) | `127.0.0.1` |
| `MYSQL_PORT` | MySQL port | `3306` |
| `MYSQL_USER` | MySQL user | `isam` |
| `MYSQL_PASSWORD` | MySQL password | — |
| `MYSQL_DATABASE` | MySQL database name | `isam` |
| **Branding** | | |
| `SITE_NAME` | Site name shown in the UI and emails | `is.am` |
| `SITE_TAGLINE` | Tagline shown on the homepage | — |
| `SITE_LOGO_PATH` | Path to a custom logo file (relative to static root) | — |
| `ADMIN_EMAIL` | Email address for the auto-created admin account | — |
| `ADMIN_PASSWORD` | Pre-set admin password; leave blank to auto-generate on first run | — |
| `THEME` | Theme folder name inside `src/themes/` | `default` |
| **Shortlinks** | | |
| `SHORTLINK_CHARS` | Characters used to generate short codes (lowercase recommended) | `abcdefghijklmnopqrstuvwxyz0123456789` |
| `IMAGE_MAX_BYTES` | Maximum image upload size in bytes | `10485760` (10 MB) |
| **Security & rate limiting** | | |
| `BCRYPT_ROUNDS` | bcrypt cost factor for password hashing | `10` |
| `RATE_LIMIT_CREATION_MAX` | Max link creations per window (anonymous) | `10` |
| `RATE_LIMIT_CREATION_WINDOW_MS` | Window for creation rate limit in ms | `60000` |
| `RATE_LIMIT_REGISTER_MAX` | Max registration attempts per window | `5` |
| `RATE_LIMIT_REGISTER_WINDOW_MS` | Window for registration rate limit in ms | `600000` |
| `ANON_TOKEN_COOKIE_DAYS` | Lifetime of anonymous session cookie in days | `30` |
| **Email (Resend)** | | |
| `RESEND_API_KEY` | Resend API key for transactional email (verification, password reset) | — |
| `RESEND_FROM_EMAIL` | From address for outgoing email | `noreply@BASE_DOMAIN` |
| **Google Sign-In** | | |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID — leave blank to disable Google login | — |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret | — |
| **Dynamic DNS** | | |
| `DNS_ENABLED` | Enable the built-in authoritative DNS server | `false` |
| `DNS_PORT` | UDP port the DNS server listens on | `5300` |
| `DNS_UPSTREAM` | Upstream resolver for non-local queries | `8.8.8.8` |
| `DYN_SUBDOMAIN` | Subdomain used for dynamic DNS delegation (records resolve as `name.DYN_SUBDOMAIN.domain`) | `dyn` |

---

## Google Sign-In

Google Sign-In is optional. Leave `GOOGLE_CLIENT_ID` blank and the Google buttons are hidden entirely.

### 1. Create a Google OAuth app

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and create a new project (or select an existing one)
2. In the left sidebar go to **APIs & Services → OAuth consent screen**
3. Choose **External** (allows any Google account to sign in) and click **Create**
4. Fill in the required fields:
   - **App name** — your site name (e.g. `is.am`)
   - **User support email** — your email address
   - **Developer contact information** — your email address
5. Click **Save and Continue** through the Scopes and Test Users screens (no changes needed)
6. Click **Back to Dashboard**

### 2. Create OAuth credentials

1. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**
2. Set **Application type** to **Web application**
3. Set a name (e.g. `is.am web`)
4. Under **Authorised redirect URIs**, click **Add URI** and enter:
   ```
   https://yourdomain.com/auth/google/callback
   ```
   For local development also add:
   ```
   http://localhost:3000/auth/google/callback
   ```
5. Click **Create**
6. Copy the **Client ID** and **Client Secret** from the dialog

### 3. Add to your .env

```env
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
```

Restart the app. The **Continue with Google** button will appear on the login and register pages.

### How it works

- **New user via Google** — an account is created automatically using the Google display name and email. No password is set; `password_hash` is `NULL`.
- **Existing account with matching email** — the Google ID is linked to the existing account on first Google login. No action required from the user.
- **Linking / unlinking** — users can connect or disconnect Google from **Profile → Linked Accounts**. Unlinking is only permitted if a password is already set (to prevent lockout).
- **Password fallback** — Google-only users can add a password at any time via **Profile → Set a Password** or via **Forgot Password**. The reset email will note that Google Sign-In is available and still works.
- **Email verification** — accounts created or verified via Google are marked as email-verified automatically (Google has already confirmed the address).

### Publish the app (remove test-only restriction)

By default a new OAuth app is in **Testing** mode, which limits sign-in to up to 100 manually added test users. To allow anyone to sign in:

1. Go to **APIs & Services → OAuth consent screen**
2. Click **Publish App** → **Confirm**

The app will show a Google consent screen to users on first sign-in regardless of publishing status.

> **Note:** If your app requests only `openid`, `profile`, and `email` (which is all this app uses) Google's verification process is straightforward and usually does not require a formal review.

### Troubleshooting

**`redirect_uri_mismatch`** — The callback URL in Google's console does not exactly match what the app sends. Check that the URI registered in step 2 matches your `BASE_DOMAIN` precisely, including `https://` and no trailing slash.

**`Access blocked: app is in testing mode`** — Add the user's Google account to the **Test users** list in the OAuth consent screen, or publish the app.

**Users can sign in but are not redirected correctly** — Check that `BASE_DOMAIN` in `.env` is set to your public domain (not `localhost`) in production.

---

## Stripe Subscription Payments

Stripe is optional. Leave `STRIPE_SECRET_KEY` blank and the payment UI is hidden entirely.

### 1. Create a restricted API key

Using a restricted key limits the blast radius if the key is ever leaked. Do **not** use your secret key (`sk_live_...`) — create a restricted key with only the permissions this app requires.

In the [Stripe Dashboard](https://dashboard.stripe.com/), go to **Developers → API keys → Create restricted key** and set the following permissions — leave everything else at **None**:

| Resource | Permission |
|---|---|
| Customers | Read + Write |
| Checkout Sessions | Read + Write |
| Subscriptions | Read + Write |
| Customer Portal Sessions | Write |
| Prices | Read |
| Products | Read |

Copy the generated key (`rk_live_...`). Use a `rk_test_...` restricted key during development — create one the same way under test mode.

> **Webhook signature verification** does not require any API permission — it works via the signing secret alone, so no Webhook Endpoints permission is needed.

Stripe keys are stored in the database and managed from **Admin → Settings → Stripe Payments** — no `.env` changes required.

### 2. Create products and prices

For each paid account tier you want to offer, create a **Product** in Stripe with **two Prices** — one monthly and one yearly:

1. Stripe Dashboard → **Products** → **Add product**
2. Set the name (e.g. "Pro")
3. Under **Pricing**, add a recurring monthly price (e.g. $9/month)
4. Add a second recurring yearly price (e.g. $90/year)
5. Copy both `price_xxx` IDs — you'll enter them in the admin panel

### 3. Configure tiers in the admin panel

1. Log in as admin → **Admin** → **Account Tiers**
2. For each paid tier, fill in:
   - **Price ($/month)** — displayed on the pricing page
   - **Price ($/year)** — displayed on the pricing page (set to 0 to show `price × 12`)
   - **Stripe Price ID (monthly)** — `price_xxx` from Stripe
   - **Stripe Price ID (yearly)** — `price_xxx` from Stripe
3. Save changes

### 4. Set up the Stripe webhook

Stripe must notify your app when subscriptions change (new signups, renewals, cancellations).

1. Stripe Dashboard → **Developers** → **Webhooks** → **Add destination**
2. Choose **Webhook endpoint**, set the URL to `https://yourdomain.com/stripe/webhook`
3. Under **Select events**, add exactly these 4 events:
   - `checkout.session.completed`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_failed`
4. Click **Add destination**
5. On the endpoint detail page, find **Signing secret** and click **Reveal** — copy the `whsec_...` value
6. Paste it into the **Webhook Signing Secret** field in Admin → Settings

> The signing secret is unique to each endpoint. If you create separate test and live endpoints, each will have its own `whsec_...` value.

**For local development**, use the Stripe CLI to forward webhooks to localhost — it prints a temporary signing secret to use while developing:

```bash
stripe listen --forward-to localhost:3000/stripe/webhook
# Ready! Your webhook signing secret is whsec_... (^C to quit)
```

### 5. Enable Stripe

In **Admin → Settings → Stripe Payments**, set **Payments** to **Enabled** and save. No restart required.

The `/pricing` page will now show monthly and yearly subscription options for each paid tier.

### Testing with Stripe CLI (development)

```bash
stripe listen --forward-to localhost:3000/stripe/webhook
```

Use Stripe's [test card numbers](https://stripe.com/docs/testing#cards) (e.g. `4242 4242 4242 4242`) in Checkout.

### How subscriptions work

- **Checkout** — users are redirected to Stripe-hosted Checkout; on success, a webhook fires and the account tier is updated immediately
- **Cancellation** — handled via the Stripe Customer Portal (`/stripe/portal`); access continues until the current period ends (no refunds, no mid-period cutoff)
- **Payment failure** — subscription status is set to `past_due`; the tier is not changed until the subscription is fully canceled
- **Admins** — exempt from all tier limits regardless of their subscription status

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

### 3. DNS configuration

#### Required records (all setups)

Add these at your DNS provider:

| Type | Name | Value | Purpose |
|------|------|-------|---------|
| `A` | `yourdomain.com` | `your.server.ip` | Main site |
| `A` | `*.yourdomain.com` | `your.server.ip` | All subdomains — feature subdomains, user subdomains |

The wildcard catches `t.`, `h.`, `i.`, `b.`, `d.`, `q.`, `a.`, `l.` and any other subdomains, routing them all to the server. nginx then redirects feature subdomains to their respective paths.

#### Additional records for Dynamic DNS (optional)

The built-in DNS server handles records under `dyn.yourdomain.com`. For this to work, DNS resolvers must be told to ask your server for those names. This requires two extra records:

| Type | Name | Value | Purpose |
|------|------|-------|---------|
| `A` | `ns.yourdomain.com` | `your.server.ip` | Names your server as a nameserver |
| `NS` | `dyn.yourdomain.com` | `ns.yourdomain.com` | Delegates `*.dyn.yourdomain.com` to your server |

**How it works:** When a resolver looks up `home.dyn.yourdomain.com`, it finds the `NS` record for `dyn.yourdomain.com` and asks `ns.yourdomain.com` (your server) directly. The `*.yourdomain.com` wildcard is bypassed — NS delegation takes priority over wildcard A records.

> **Why `ns.yourdomain.com`?** NS record values must be hostnames, not IP addresses. The A record for `ns.yourdomain.com` tells resolvers where to find that nameserver.

#### Enabling the built-in DNS server

1. Set in `.env`:
   ```
   DNS_ENABLED=true
   DNS_PORT=5300
   DYN_SUBDOMAIN=dyn
   ```

2. Expose UDP port 53 on the host (mapped to 5300 inside the container — see `docker-compose.yml`). If running without Docker, either run Node as root (not recommended) or use a port redirect:
   ```bash
   iptables -t nat -A PREROUTING -p udp --dport 53 -j REDIRECT --to-port 5300
   ```

3. Users add records via the `/d` UI. Dynamic clients update their IP with:
   ```bash
   curl "https://yourdomain.com/d/update?host=myhome&key=SECRET_KEY&ip=$(curl -s https://api.ipify.org)"
   ```
   This resolves as `myhome.dyn.yourdomain.com`.

#### Verifying DNS propagation

Check that the wildcard resolves to your server:
```bash
dig A t.yourdomain.com +short
dig A anything.yourdomain.com +short
```

Check NS delegation for dynamic DNS:
```bash
dig NS dyn.yourdomain.com +short
# should return: ns.yourdomain.com.

dig A home.dyn.yourdomain.com +short
# should return the IP set in the /d UI
```

---

## Running as a service

### Option A — pm2 (recommended)

pm2 is a production process manager for Node.js. It handles restarts on crash, startup on boot, and log management.

```bash
npm install -g pm2
```

An `ecosystem.config.cjs` file is included in the project root. Review it and adjust any values, then start the app:

```bash
pm2 start ecosystem.config.cjs
```

**Save the process list so it restarts on server reboot:**

```bash
pm2 save
pm2 startup   # follow the printed instruction to register the startup hook
```

**Common pm2 commands:**

```bash
pm2 status          # show running processes
pm2 logs is.am      # tail live logs
pm2 restart is.am   # restart after code changes
pm2 stop is.am      # stop
pm2 delete is.am    # remove from pm2
```

**Updating the app:**

```bash
git pull
npm install
pm2 restart is.am
```

---

### UV_THREADPOOL_SIZE

Node.js uses a native thread pool (libuv) for file I/O, image processing (Sharp), and DNS lookups. The default pool size is **4 threads**. Under concurrent image uploads this pool can saturate, causing other I/O to queue behind image processing jobs.

The `ecosystem.config.cjs` file sets `UV_THREADPOOL_SIZE: '8'` in the `env` block, which doubles the pool. This is the correct way to set it when using pm2 — setting it in `.env` or `package.json` scripts has no effect on pm2-managed processes.

**To tune the value:**

| Server vCPUs | Recommended `UV_THREADPOOL_SIZE` |
|---|---|
| 1 | `8` |
| 2 | `12` |
| 4+ | `16` |

Going above 128 has no effect (libuv hard cap). Larger values use more memory (each thread ~8 MB stack) so don't set it higher than needed.

After changing the value in `ecosystem.config.cjs`, apply it with:

```bash
pm2 restart ecosystem.config.cjs
```

Verify it took effect:

```bash
pm2 env is.am | grep UV_THREADPOOL
```

---

### Option B — systemd

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
Environment=UV_THREADPOOL_SIZE=8

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
