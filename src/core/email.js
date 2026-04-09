import config from '../config.js'

export async function sendEmail({ to, subject, html }) {
  console.log(`[resend] ---- sendEmail ----`)
  console.log(`[resend]   to:      ${to}`)
  console.log(`[resend]   subject: ${subject}`)
  console.log(`[resend]   RESEND_API_KEY set: ${!!config.RESEND_API_KEY} (length: ${config.RESEND_API_KEY?.length ?? 0})`)

  if (!config.RESEND_API_KEY) {
    console.log(`[resend]   No API key — email not sent (dev mode)`)
    return { ok: false, devMode: true }
  }

  const from = config.RESEND_FROM_EMAIL || `noreply@${config.BASE_DOMAIN}`
  console.log(`[resend]   from: ${from}`)

  const payload = { from, to, subject, html }
  console.log(`[resend]   payload: ${JSON.stringify({ from, to, subject })}`)

  let res, body, rawText
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
    rawText = await res.text()
    try { body = JSON.parse(rawText) } catch { body = rawText }
  } catch (err) {
    console.error(`[resend]   Network error: ${err.message}`)
    throw err
  }

  console.log(`[resend]   HTTP status: ${res.status}`)
  console.log(`[resend]   Response: ${JSON.stringify(body)}`)

  if (!res.ok) {
    const msg = body?.message || body?.error || rawText
    console.error(`[resend]   FAILED — ${res.status}: ${msg}`)
    throw new Error(`Resend API ${res.status}: ${msg}`)
  }

  console.log(`[resend]   OK — email id: ${body?.id}`)
  return { ok: true, id: body?.id }
}

export async function notifyAdminsNewAccount(db, newUser) {
  const admins = db.all(
    `SELECT email FROM users WHERE role = 'admin' AND notify_new_accounts = 1 AND email IS NOT NULL`
  )
  if (!admins.length) return

  const name = newUser.display_name || newUser.username || '(no name)'
  const email = newUser.email || '(no email)'
  const plan = newUser.subscription_tier || 'free'
  const method = newUser.google_id ? 'Google Sign-In' : 'Email / Password'
  const usersUrl = `https://${config.BASE_DOMAIN}/admin/users?q=${encodeURIComponent(newUser.email || newUser.username)}`

  const html = `
    <p>A new account has been created on <strong>${config.SITE_NAME}</strong>.</p>
    <table style="border-collapse:collapse;font-size:14px;margin:12px 0">
      <tr><td style="padding:4px 16px 4px 0;color:#888;white-space:nowrap">Name</td><td><strong>${name}</strong></td></tr>
      <tr><td style="padding:4px 16px 4px 0;color:#888;white-space:nowrap">Email</td><td>${email}</td></tr>
      <tr><td style="padding:4px 16px 4px 0;color:#888;white-space:nowrap">Plan</td><td>${plan}</td></tr>
      <tr><td style="padding:4px 16px 4px 0;color:#888;white-space:nowrap">Sign-up method</td><td>${method}</td></tr>
    </table>
    <p><a href="${usersUrl}" style="display:inline-block;padding:8px 16px;background:#6366f1;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">View in User Management →</a></p>
    <p style="font-size:12px;color:#999;margin-top:16px">You're receiving this because you enabled new account notifications in your admin profile settings.</p>
  `

  for (const admin of admins) {
    sendEmail({
      to: admin.email,
      subject: `New account: ${email} — ${config.SITE_NAME}`,
      html,
    }).catch(err => console.error(`[notify] Failed to notify admin ${admin.email}:`, err.message))
  }
}
