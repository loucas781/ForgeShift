/* shell.js — shared layout, theme, toast, nav helpers */
'use strict'

// ── Config ─────────────────────────────────────────────────────────────────────
let _config = null

async function loadConfig() {
  if (_config) return _config
  const r = await fetch('/api/config')
  _config = await r.json()
  if (!_config.user) { window.location.href = '/login.html'; return null }
  return _config
}

// ── Theme ──────────────────────────────────────────────────────────────────────
function applyTheme(theme) {
  if (theme === 'light') {
    document.documentElement.removeAttribute('data-theme')
  } else {
    document.documentElement.setAttribute('data-theme', theme)
  }
  localStorage.setItem('fs-theme', theme)
}

function getTheme() {
  return localStorage.getItem('fs-theme') || 'light'
}

// Apply theme immediately (inline so no flash)
;(function() {
  const t = localStorage.getItem('fs-theme') || 'light'
  if (t !== 'light') document.documentElement.setAttribute('data-theme', t)
})()

// ── Toast notifications ────────────────────────────────────────────────────────
function toast(message, type = 'default', duration = 3500) {
  let container = document.getElementById('toast-container')
  if (!container) {
    container = document.createElement('div')
    container.id = 'toast-container'
    container.className = 'toast-container'
    document.body.appendChild(container)
  }
  const t = document.createElement('div')
  t.className = `toast${type !== 'default' ? ' ' + type : ''}`

  const icons = {
    success: '<svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16" style="flex-shrink:0"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>',
    error:   '<svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16" style="flex-shrink:0"><path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>',
    warning: '<svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16" style="flex-shrink:0"><path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>',
  }
  t.innerHTML = `${icons[type] || ''}${message}`
  container.appendChild(t)
  setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateY(8px)'; t.style.transition = '200ms'; setTimeout(() => t.remove(), 200) }, duration)
}

// ── Avatar helper ──────────────────────────────────────────────────────────────
function avatarEl(user, size = '') {
  const el = document.createElement('div')
  el.className = `avatar${size ? ' avatar-' + size : ''}`
  el.style.background = user.color || '#4f46e5'
  if (user.avatar) {
    const img = document.createElement('img')
    img.src = user.avatar; img.alt = user.name
    el.appendChild(img)
  } else {
    el.textContent = user.initials || (user.name || '?').slice(0,2).toUpperCase()
  }
  return el
}

// ── Shell render ───────────────────────────────────────────────────────────────
function renderShell(cfg, activePage) {
  // Topbar
  const topbar = document.getElementById('topbar')
  if (!topbar) return

  const envClass = cfg.appEnv || 'development'

  topbar.innerHTML = `
    <button class="topbar-menu-btn" id="menuToggle" aria-label="Menu">
      <svg viewBox="0 0 20 20" fill="currentColor" width="20" height="20"><path fill-rule="evenodd" d="M3 5h14a1 1 0 110 2H3a1 1 0 110-2zm0 4h14a1 1 0 110 2H3a1 1 0 110-2zm0 4h14a1 1 0 110 2H3a1 1 0 110-2z" clip-rule="evenodd"/></svg>
    </button>
    <a href="/" class="topbar-logo">
      <svg viewBox="0 0 36 36" fill="none"><rect width="36" height="36" rx="9" fill="#4f46e5"/>
        <path d="M10 26V10h10l6 6v10H10z" fill="rgba(255,255,255,.25)"/>
        <path d="M20 10l6 6h-6V10z" fill="rgba(255,255,255,.5)"/>
        <rect x="13" y="16" width="10" height="1.5" rx=".75" fill="white"/>
        <rect x="13" y="19" width="7" height="1.5" rx=".75" fill="white"/>
        <rect x="13" y="22" width="8" height="1.5" rx=".75" fill="white"/></svg>
      <span class="topbar-logo-text">ForgeShift</span>
    </a>
    <span class="env-badge ${envClass}" title="v${cfg.version}">${envClass} <span style="opacity:.7;font-weight:500;letter-spacing:0">v${cfg.version}</span></span>
    <div class="topbar-spacer"></div>
    <nav class="topbar-nav">
      <a href="/" class="topbar-nav-btn${activePage==='calendar'?' active':''}">
        <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M6 2a1 1 0 00-1 1v1H4a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-1V3a1 1 0 10-2 0v1H7V3a1 1 0 00-1-1zm0 5a1 1 0 000 2h8a1 1 0 100-2H6z" clip-rule="evenodd"/></svg>
        Calendar
      </a>
      <a href="/templates.html" class="topbar-nav-btn${activePage==='templates'?' active':''}">
        <svg viewBox="0 0 20 20" fill="currentColor"><path d="M9 2a2 2 0 00-2 2v8a2 2 0 002 2h6a2 2 0 002-2V6.414A2 2 0 0016.414 5L14 2.586A2 2 0 0012.586 2H9z"/><path d="M3 8a2 2 0 012-2h2a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z"/></svg>
        Templates
      </a>
      ${cfg.user.role === 'admin' ? `<a href="/settings.html" class="topbar-nav-btn${activePage==='settings'?' active':''}">
        <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clip-rule="evenodd"/></svg>
        Settings
      </a>` : ''}
    </nav>
    <div class="dropdown-wrapper" id="userDropdown">
      <button class="topbar-user-btn" onclick="toggleUserMenu()">
        ${avatarEl(cfg.user).outerHTML}
        <span>${cfg.user.name.split(' ')[0]}</span>
        <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14"><path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd"/></svg>
      </button>
      <div class="dropdown-menu" id="userMenu">
        <a href="/profile.html" class="dropdown-item">
          <svg viewBox="0 0 20 20" fill="currentColor" width="15" height="15"><path fill-rule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clip-rule="evenodd"/></svg>
          My Profile
        </a>
        <div class="dropdown-sep"></div>
        <button class="dropdown-item" onclick="setTheme('light')">☀️ Light mode</button>
        <button class="dropdown-item" onclick="setTheme('dark')">🌙 Dark mode</button>
        <button class="dropdown-item" onclick="setTheme('oled')">⬛ OLED Black</button>
        <div class="dropdown-sep"></div>
        <button class="dropdown-item danger" onclick="doLogout()">
          <svg viewBox="0 0 20 20" fill="currentColor" width="15" height="15"><path fill-rule="evenodd" d="M3 3a1 1 0 00-1 1v12a1 1 0 102 0V4a1 1 0 00-1-1zm10.293 9.293a1 1 0 001.414 1.414l3-3a1 1 0 000-1.414l-3-3a1 1 0 10-1.414 1.414L14.586 9H7a1 1 0 100 2h7.586l-1.293 1.293z" clip-rule="evenodd"/></svg>
          Sign out
        </button>
      </div>
    </div>
  `

  // Sidebar
  const sidebar = document.getElementById('sidebar')
  if (sidebar) {
    sidebar.innerHTML = `
      <div class="sidebar-section">
        <div class="sidebar-label">Rota</div>
        <a href="/" class="sidebar-item${activePage==='calendar'?' active':''}">
          <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M6 2a1 1 0 00-1 1v1H4a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-1V3a1 1 0 10-2 0v1H7V3a1 1 0 00-1-1zm0 5a1 1 0 000 2h8a1 1 0 100-2H6z" clip-rule="evenodd"/></svg>
          Calendar
        </a>
        <a href="/templates.html" class="sidebar-item${activePage==='templates'?' active':''}">
          <svg viewBox="0 0 20 20" fill="currentColor"><path d="M9 2a2 2 0 00-2 2v8a2 2 0 002 2h6a2 2 0 002-2V6.414A2 2 0 0016.414 5L14 2.586A2 2 0 0012.586 2H9z"/></svg>
          Templates
        </a>
      </div>
      ${cfg.user.role === 'admin' ? `
      <div class="sidebar-section">
        <div class="sidebar-label">Admin</div>
        <a href="/settings.html#users" class="sidebar-item${activePage==='users'?' active':''}">
          <svg viewBox="0 0 20 20" fill="currentColor"><path d="M9 6a3 3 0 11-6 0 3 3 0 016 0zM17 6a3 3 0 11-6 0 3 3 0 016 0zM12.93 17c.046-.327.07-.66.07-1a6.97 6.97 0 00-1.5-4.33A5 5 0 0119 16v1h-6.07zM6 11a5 5 0 015 5v1H1v-1a5 5 0 015-5z"/></svg>
          Users
        </a>
        <a href="/settings.html" class="sidebar-item${activePage==='settings'?' active':''}">
          <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clip-rule="evenodd"/></svg>
          Settings
        </a>
      </div>` : ''}
    `
  }

  // Mobile overlay
  const overlay = document.getElementById('sidebarOverlay')
  const menuBtn = document.getElementById('menuToggle')
  const sidebarEl = document.getElementById('sidebar')
  if (menuBtn && sidebarEl && overlay) {
    menuBtn.addEventListener('click', () => {
      sidebarEl.classList.toggle('open')
      overlay.classList.toggle('open')
    })
    overlay.addEventListener('click', () => {
      sidebarEl.classList.remove('open')
      overlay.classList.remove('open')
    })
  }

  // Close dropdown on outside click
  document.addEventListener('click', e => {
    const dd = document.getElementById('userDropdown')
    if (dd && !dd.contains(e.target)) {
      document.getElementById('userMenu')?.classList.remove('open')
    }
  })
}

function toggleUserMenu() {
  document.getElementById('userMenu')?.classList.toggle('open')
}

function setTheme(t) {
  applyTheme(t)
  document.getElementById('userMenu')?.classList.remove('open')
  toast(`Theme set to ${t}`, 'success', 1800)
}

async function doLogout() {
  await fetch('/api/auth/logout', { method: 'POST' })
  window.location.href = '/login.html'
}

// ── API helpers ────────────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const r = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const d = await r.json()
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
  return d
}

// ── Date helpers ───────────────────────────────────────────────────────────────
const DAY_NAMES  = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']
const DAY_ABBR   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December']

function toDateStr(d) {
  return d.toISOString().slice(0, 10)
}

function parseDate(s) {
  // Parse YYYY-MM-DD without timezone conversion
  const [y, m, dd] = s.split('-').map(Number)
  return new Date(y, m - 1, dd)
}

function startOfWeek(date, startDay = 1) {
  const d = new Date(date)
  const day = d.getDay()
  const diff = (day - startDay + 7) % 7
  d.setDate(d.getDate() - diff)
  d.setHours(0, 0, 0, 0)
  return d
}

// ── Colour swatches ────────────────────────────────────────────────────────────
const NOTE_COLOURS = [
  { value: '#4f46e5', label: 'Indigo' },
  { value: '#059669', label: 'Green' },
  { value: '#d97706', label: 'Amber' },
  { value: '#dc2626', label: 'Red' },
  { value: '#7c3aed', label: 'Purple' },
  { value: '#0891b2', label: 'Cyan' },
  { value: '#db2777', label: 'Pink' },
  { value: '#6b7280', label: 'Gray' },
]

function renderColourPicker(container, value, onChange) {
  container.className = 'colour-picker'
  NOTE_COLOURS.forEach(c => {
    const sw = document.createElement('div')
    sw.className = `colour-swatch${value === c.value ? ' selected' : ''}`
    sw.style.background = c.value
    sw.title = c.label
    sw.addEventListener('click', () => {
      container.querySelectorAll('.colour-swatch').forEach(s => s.classList.remove('selected'))
      sw.classList.add('selected')
      onChange(c.value)
    })
    container.appendChild(sw)
  })
}
