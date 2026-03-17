/* password-policy.js — live password strength indicator, shared across all pages.
   Depends on: APP_POLICY being set (loaded from /api/config by each page).
   Usage:
     const indicator = createPasswordIndicator()
     input.parentElement.after(indicator)
     input.addEventListener('input', () => updatePasswordIndicator(indicator, input.value))
*/
'use strict'

// Global policy — set by each page after calling /api/config
let APP_POLICY = {
  minLength: 8, requireUpper: true, requireLower: true,
  requireNumber: true, requireSpecial: false, noSequential: false,
}

function setPasswordPolicy(policy) {
  if (policy) APP_POLICY = { ...APP_POLICY, ...policy }
}

function validatePasswordClient(password) {
  const p = APP_POLICY
  const errors = []
  if (!password) return { ok: false, errors: ['Password is required.'] }
  if (p.minLength      && password.length < p.minLength)   errors.push(`At least ${p.minLength} characters.`)
  if (p.requireUpper   && !/[A-Z]/.test(password))         errors.push('At least one uppercase letter (A–Z).')
  if (p.requireLower   && !/[a-z]/.test(password))         errors.push('At least one lowercase letter (a–z).')
  if (p.requireNumber  && !/[0-9]/.test(password))         errors.push('At least one number (0–9).')
  if (p.requireSpecial && !/[^A-Za-z0-9]/.test(password))  errors.push('At least one special character (!@#$%…).')
  if (p.noSequential) {
    if (/(.)\1{2,}/.test(password)) errors.push('No 3+ identical characters in a row (aaa, 111).')
    let run = 1
    for (let i = 1; i < password.length; i++) {
      if (password.charCodeAt(i) - password.charCodeAt(i - 1) === 1) { run++; if (run >= 3) break }
      else run = 1
    }
    if (run >= 3) errors.push('No sequential characters in a row (abc, 123).')
  }
  return { ok: errors.length === 0, errors }
}

function createPasswordIndicator() {
  const wrap = document.createElement('div')
  wrap.className = 'pw-policy-indicator'
  wrap.style.cssText = 'margin-top:8px;display:flex;flex-wrap:wrap;gap:5px;'
  return wrap
}

function updatePasswordIndicator(wrap, value) {
  const p = APP_POLICY
  const rules = []
  if (p.minLength)      rules.push({ label: `${p.minLength}+ chars`,  ok: value.length >= p.minLength })
  if (p.requireUpper)   rules.push({ label: 'A–Z',                    ok: /[A-Z]/.test(value) })
  if (p.requireLower)   rules.push({ label: 'a–z',                    ok: /[a-z]/.test(value) })
  if (p.requireNumber)  rules.push({ label: '0–9',                    ok: /[0-9]/.test(value) })
  if (p.requireSpecial) rules.push({ label: '!@#…',                   ok: /[^A-Za-z0-9]/.test(value) })
  if (p.noSequential) {
    const noRepeat = !(/(.)\1{2,}/.test(value))
    let run = 1, noSeq = true
    for (let i = 1; i < value.length; i++) {
      if (value.charCodeAt(i) - value.charCodeAt(i - 1) === 1) { run++; if (run >= 3) { noSeq = false; break } }
      else run = 1
    }
    rules.push({ label: 'no aaa/123', ok: value.length === 0 || (noRepeat && noSeq) })
  }

  const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" width="10" height="10"><polyline points="20 6 9 17 4 12"/></svg>'
  wrap.innerHTML = rules.map(r => `
    <span style="display:inline-flex;align-items:center;gap:3px;font-size:11px;font-weight:500;
      padding:2px 8px;border-radius:10px;transition:all .15s;
      background:${r.ok ? 'rgba(5,150,105,.12)' : 'var(--gray-100,#f3f4f6)'};
      color:${r.ok ? '#059669' : 'var(--text-3,#9ca3af)'}">
      ${r.ok ? CHECK : ''}${r.label}
    </span>`).join('')
}
