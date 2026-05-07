'use strict'
// ForgeShift email module — SMTP config stored in .runtime-overrides.json, never committed.
// All functions return { ok, error } and never throw, so callers degrade gracefully.

const { loadOverrides } = require('./utils/overrides')
const logger = require('./utils/logger')

function getSmtpConfig() {
  const o = loadOverrides()
  return {
    host:     o.SMTP_HOST      || '',
    port:     parseInt(o.SMTP_PORT || '587', 10),
    secure:   o.SMTP_SECURE    === 'true',
    user:     o.SMTP_USER      || '',
    pass:     o.SMTP_PASS      || '',
    fromName: o.SMTP_FROM_NAME || process.env.APP_NAME || 'ForgeShift',
    fromAddr: o.SMTP_FROM_ADDR || o.SMTP_USER || '',
    replyTo:  o.SMTP_REPLY_TO  || '',
    enabled:  !!(o.SMTP_HOST && o.SMTP_USER),
  }
}

async function createTransport() {
  const nodemailer = require('nodemailer')
  const cfg = getSmtpConfig()
  if (!cfg.enabled) return null
  return nodemailer.createTransport({
    host: cfg.host, port: cfg.port, secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    tls: { rejectUnauthorized: process.env.NODE_ENV !== 'development' },
  })
}

async function sendMail({ to, subject, html, text, replyTo }) {
  try {
    const transport = await createTransport()
    if (!transport) return { ok: false, error: 'SMTP not configured' }
    const cfg = getSmtpConfig()
    const mail = { from: `"${cfg.fromName}" <${cfg.fromAddr}>`, to, subject, html, text }
    const resolvedReplyTo = String(replyTo || cfg.replyTo || '').trim()
    if (resolvedReplyTo) mail.replyTo = resolvedReplyTo
    await transport.sendMail(mail)
    return { ok: true }
  } catch (err) {
    logger.error('[email] send error:', err.message)
    return { ok: false, error: err.message }
  }
}

async function testConnection() {
  try {
    const transport = await createTransport()
    if (!transport) return { ok: false, error: 'SMTP not configured' }
    await transport.verify()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

// ── Email templates ────────────────────────────────────────────────────────────
function baseTemplate(title, bodyHtml, appName = 'ForgeShift') {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${title}</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:40px 0">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px">
        <tr><td style="background:#4f46e5;border-radius:8px 8px 0 0;padding:24px 32px">
          <span style="color:#fff;font-size:18px;font-weight:700;letter-spacing:-.02em">${appName}</span>
        </td></tr>
        <tr><td style="background:#fff;padding:32px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb">
          ${bodyHtml}
        </td></tr>
        <tr><td style="background:#f3f4f6;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;padding:16px 32px;text-align:center">
          <span style="font-size:11px;color:#6b7280">Sent by ${appName}. If you didn't request this, you can safely ignore it.</span>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`
}

async function sendPasswordReset({ to, name, resetUrl }) {
  const appName = getSmtpConfig().fromName
  const html = baseTemplate('Reset your password', `
    <div style="margin-bottom:18px">
      <h2 style="margin:0 0 8px;font-size:24px;line-height:1.25;color:#111827;letter-spacing:-.02em">Reset your password</h2>
      <p style="color:#4b5563;font-size:15px;line-height:1.55;margin:0">Hi ${name}, we received a request to reset your ${appName} password.</p>
    </div>

    <div style="margin:0 0 24px;padding:14px 16px;background:#eef2ff;border:1px solid #c7d2fe;border-radius:10px;color:#3730a3;font-size:13px;line-height:1.5">
      For your security, this link expires in <strong>15 minutes</strong> and can only be used once.
    </div>

    <table cellpadding="0" cellspacing="0" style="margin:0 0 24px">
      <tr>
        <td style="background:#4f46e5;border-radius:8px;padding:0">
          <a href="${resetUrl}" style="display:inline-block;padding:13px 26px;color:#ffffff;font-size:15px;font-weight:700;letter-spacing:.01em;text-decoration:none">
            Reset Password
          </a>
        </td>
      </tr>
    </table>

    <div style="margin:0 0 22px;padding:14px;border:1px solid #e5e7eb;border-radius:10px;background:#f9fafb">
      <p style="margin:0 0 8px;color:#6b7280;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.04em">Manual link</p>
      <p style="margin:0;color:#4f46e5;font-size:12px;line-height:1.5;word-break:break-all">${resetUrl}</p>
    </div>

    <p style="margin:0;color:#6b7280;font-size:12px;line-height:1.55;border-top:1px solid #e5e7eb;padding-top:16px">
      If you didn't request a password reset, you can safely ignore this email.
    </p>
  `, appName)
  return sendMail({ to, subject: `Reset your ${appName} password`, html,
    text: `Hi ${name},\n\nReset your password here:\n${resetUrl}\n\nThis link expires in 15 minutes.\n\n— ${appName}` })
}

async function sendWelcome({ to, name, loginUrl }) {
  const appName = getSmtpConfig().fromName
  const html = baseTemplate(`Welcome to ${appName}`, `
    <h2 style="margin:0 0 8px;font-size:22px;color:#111827">Welcome to ${appName}, ${name}!</h2>
    <p style="color:#6b7280;font-size:14px;margin:0 0 24px">Your account has been created. Click below to sign in.</p>
    <table cellpadding="0" cellspacing="0" style="margin-bottom:24px">
      <tr><td style="background:#4f46e5;border-radius:6px;padding:12px 28px">
        <a href="${loginUrl}" style="color:#fff;font-size:14px;font-weight:600;text-decoration:none">Sign In</a>
      </td></tr>
    </table>
  `, appName)
  return sendMail({ to, subject: `Welcome to ${appName}`, html,
    text: `Welcome to ${appName}, ${name}!\n\nSign in here:\n${loginUrl}\n\n— ${appName}` })
}

async function sendAdminInvite({ to, name, tempPassword, loginUrl }) {
  const appName = getSmtpConfig().fromName
  const html = baseTemplate(`You've been invited to ${appName}`, `
    <h2 style="margin:0 0 8px;font-size:22px;color:#111827">You've been invited</h2>
    <p style="color:#6b7280;font-size:14px;margin:0 0 24px">An admin has created a ${appName} account for you, ${name}.</p>
    <table style="width:100%;margin-bottom:24px;border-collapse:collapse">
      <tr><td style="padding:8px 12px;background:#f3f4f6;color:#6b7280;font-size:13px;width:120px;border:1px solid #e5e7eb">Email</td>
          <td style="padding:8px 12px;background:#fff;font-size:13px;border:1px solid #e5e7eb">${to}</td></tr>
      <tr><td style="padding:8px 12px;background:#f3f4f6;color:#6b7280;font-size:13px;border:1px solid #e5e7eb">Password</td>
          <td style="padding:8px 12px;background:#fff;font-size:13px;font-family:monospace;border:1px solid #e5e7eb">${tempPassword}</td></tr>
    </table>
    <table cellpadding="0" cellspacing="0" style="margin-bottom:16px">
      <tr><td style="background:#4f46e5;border-radius:6px;padding:12px 28px">
        <a href="${loginUrl}" style="color:#fff;font-size:14px;font-weight:600;text-decoration:none">Sign In Now</a>
      </td></tr>
    </table>
    <p style="color:#dc2626;font-size:12px;margin:0">Please change your password after signing in.</p>
  `, appName)
  return sendMail({ to, subject: `You've been invited to ${appName}`, html,
    text: `You've been invited to ${appName}.\n\nEmail: ${to}\nPassword: ${tempPassword}\n\nSign in: ${loginUrl}\n\nPlease change your password after signing in.\n\n— ${appName}` })
}

async function sendEmailChangeVerification({ to, name, verifyUrl }) {
  const appName = getSmtpConfig().fromName
  const html = baseTemplate('Verify your new email address', `
    <h2 style="margin:0 0 8px;font-size:22px;color:#111827">Verify your new email</h2>
    <p style="color:#6b7280;font-size:14px;margin:0 0 24px">Hi ${name}, click the button below to confirm this as your new ${appName} email address.</p>
    <table cellpadding="0" cellspacing="0" style="margin-bottom:24px">
      <tr><td style="background:#4f46e5;border-radius:6px;padding:12px 28px">
        <a href="${verifyUrl}" style="color:#fff;font-size:14px;font-weight:600;text-decoration:none">Confirm new email</a>
      </td></tr>
    </table>
    <p style="color:#6b7280;font-size:13px;margin:0 0 8px">Or copy this link into your browser:</p>
    <p style="color:#4f46e5;font-size:12px;word-break:break-all;margin:0 0 24px">${verifyUrl}</p>
    <p style="color:#6b7280;font-size:12px;margin:0;border-top:1px solid #e5e7eb;padding-top:16px">This link expires in <strong>1 hour</strong>. If you didn't request this, you can safely ignore it.</p>
  `, appName)
  return sendMail({ to, subject: `Verify your new ${appName} email address`, html,
    text: `Hi ${name},\n\nConfirm your new email address here:\n${verifyUrl}\n\nThis link expires in 1 hour.\n\nIf you didn't request this, you can safely ignore it.\n\n— ${appName}` })
}

module.exports = { getSmtpConfig, testConnection, sendMail, sendPasswordReset, sendWelcome, sendAdminInvite, sendEmailChangeVerification }
