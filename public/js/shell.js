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
  localStorage.setItem('fs-theme', theme)
  if (theme === 'system') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : '')
    if (!prefersDark) document.documentElement.removeAttribute('data-theme')
  } else if (theme === 'light') {
    document.documentElement.removeAttribute('data-theme')
  } else {
    document.documentElement.setAttribute('data-theme', theme)
  }
}

function getTheme() {
  return localStorage.getItem('fs-theme') || 'system'
}

// Apply theme immediately (called inline on every page — no flash)
;(function() {
  const t = localStorage.getItem('fs-theme') || 'system'
  if (t === 'system') {
    if (window.matchMedia('(prefers-color-scheme: dark)').matches)
      document.documentElement.setAttribute('data-theme', 'dark')
  } else if (t === 'light') {
    document.documentElement.removeAttribute('data-theme')
  } else {
    document.documentElement.setAttribute('data-theme', t)
  }
  // Watch for OS-level changes when in system mode
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
    if ((localStorage.getItem('fs-theme') || 'system') === 'system') {
      document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : '')
      if (!e.matches) document.documentElement.removeAttribute('data-theme')
    }
  })
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
    <span class="env-topbar-badge ${envClass}" title="v${cfg.version}">${envClass}</span>
    <span class="version-badge">v${cfg.version}</span>
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
    <div class="topbar-spacer"></div>

    <!-- Standalone theme picker button -->
    <div class="dropdown-wrapper" id="themeDropdown">
      <button class="topbar-icon-btn" id="themeBtn" onclick="toggleThemeMenu(event)" aria-label="Change theme" title="Change theme">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
          <rect x="2" y="3" width="20" height="14" rx="2"/>
          <path d="M8 21h8M12 17v4"/>
        </svg>
      </button>
      <div class="dropdown-menu" id="themeMenu" style="min-width:190px">
        <div style="padding:6px 12px 4px;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3)">Appearance</div>
        <button class="theme-option" id="themeOpt-system" onclick="setTheme('system')">
          <span class="theme-option-icon">
            <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12"><path d="M8 2a6 6 0 100 12A6 6 0 008 2zm0 1.5A4.5 4.5 0 018 13V3.5z"/></svg>
          </span>
          System
          <span class="theme-option-check"><svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg></span>
        </button>
        <button class="theme-option" id="themeOpt-light" onclick="setTheme('light')">
          <span class="theme-option-icon">
            <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12"><path d="M8 11a3 3 0 100-6 3 3 0 000 6zm0 1.5a4.5 4.5 0 110-9 4.5 4.5 0 010 9zM8 0a.75.75 0 01.75.75v1.5a.75.75 0 01-1.5 0V.75A.75.75 0 018 0zm0 13a.75.75 0 01.75.75v1.5a.75.75 0 01-1.5 0v-1.5A.75.75 0 018 13zM0 8a.75.75 0 01.75-.75h1.5a.75.75 0 010 1.5H.75A.75.75 0 010 8zm13 0a.75.75 0 01.75-.75h1.5a.75.75 0 010 1.5h-1.5A.75.75 0 0113 8z"/></svg>
          </span>
          Light
          <span class="theme-option-check"><svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg></span>
        </button>
        <button class="theme-option" id="themeOpt-dark" onclick="setTheme('dark')">
          <span class="theme-option-icon">
            <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12"><path d="M9.598 1.591a.75.75 0 01.785-.175 7 7 0 11-8.967 8.967.75.75 0 01.961-.96 5.5 5.5 0 007.046-7.046.75.75 0 01.175-.786z"/></svg>
          </span>
          Dark
          <span class="theme-option-check"><svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg></span>
        </button>
        <button class="theme-option" id="themeOpt-oled" onclick="setTheme('oled')">
          <span class="theme-option-icon" style="background:#000;border-color:#333">
            <svg viewBox="0 0 16 16" fill="white" width="10" height="10"><rect x="2" y="2" width="12" height="12" rx="2"/></svg>
          </span>
          OLED Black
          <span class="theme-option-check"><svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg></span>
        </button>
      </div>
    </div>

    <!-- User menu — Profile + Sign out only -->
    <div class="dropdown-wrapper" id="userDropdown">
      <button class="topbar-user-btn" onclick="toggleUserMenu(event)">
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
        <button class="dropdown-item danger" onclick="doLogout()">
          <svg viewBox="0 0 20 20" fill="currentColor" width="15" height="15"><path fill-rule="evenodd" d="M3 3a1 1 0 00-1 1v12a1 1 0 102 0V4a1 1 0 00-1-1zm10.293 9.293a1 1 0 001.414 1.414l3-3a1 1 0 000-1.414l-3-3a1 1 0 10-1.414 1.414L14.586 9H7a1 1 0 100 2h7.586l-1.293 1.293z" clip-rule="evenodd"/></svg>
          Sign out
        </button>
      </div>
    </div>
  `

  // Inject mobile nav dropdown element directly after topbar
  let mobileNav = document.getElementById('mobileNavDropdown')
  if (!mobileNav) {
    mobileNav = document.createElement('nav')
    mobileNav.id = 'mobileNavDropdown'
    mobileNav.className = 'mobile-nav-dropdown'
    topbar.parentNode.insertBefore(mobileNav, topbar.nextSibling)
  }
  mobileNav.innerHTML = `
    <a href="/" class="topbar-nav-btn${activePage==='calendar'?' active':''}" onclick="document.getElementById('mobileNavDropdown').classList.remove('open')">
      <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M6 2a1 1 0 00-1 1v1H4a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-1V3a1 1 0 10-2 0v1H7V3a1 1 0 00-1-1zm0 5a1 1 0 000 2h8a1 1 0 100-2H6z" clip-rule="evenodd"/></svg>
      Calendar
    </a>
    <a href="/templates.html" class="topbar-nav-btn${activePage==='templates'?' active':''}" onclick="document.getElementById('mobileNavDropdown').classList.remove('open')">
      <svg viewBox="0 0 20 20" fill="currentColor"><path d="M9 2a2 2 0 00-2 2v8a2 2 0 002 2h6a2 2 0 002-2V6.414A2 2 0 0016.414 5L14 2.586A2 2 0 0012.586 2H9z"/><path d="M3 8a2 2 0 012-2h2a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z"/></svg>
      Templates
    </a>
    ${cfg.user.role === 'admin' ? `<a href="/settings.html" class="topbar-nav-btn${activePage==='settings'?' active':''}" onclick="document.getElementById('mobileNavDropdown').classList.remove('open')">
      <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clip-rule="evenodd"/></svg>
      Settings
    </a>` : ''}
    <div class="mobile-nav-sep"></div>
    <div class="mobile-nav-label">Appearance</div>
    <button class="topbar-nav-btn" onclick="setTheme('system');document.getElementById('mobileNavDropdown').classList.remove('open')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" width="18" height="18"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
      System
    </button>
    <button class="topbar-nav-btn" onclick="setTheme('light');document.getElementById('mobileNavDropdown').classList.remove('open')">
      <svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18"><path fill-rule="evenodd" d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z" clip-rule="evenodd"/></svg>
      Light
    </button>
    <button class="topbar-nav-btn" onclick="setTheme('dark');document.getElementById('mobileNavDropdown').classList.remove('open')">
      <svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18"><path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z"/></svg>
      Dark
    </button>
    <button class="topbar-nav-btn" onclick="setTheme('oled');document.getElementById('mobileNavDropdown').classList.remove('open')">
      <svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18"><rect x="3" y="3" width="14" height="14" rx="2"/></svg>
      OLED Black
    </button>
  `

  // Inject fixed bottom-right env pill (ForgeTrack style)
  let envPill = document.getElementById('envCornerPill')
  if (!envPill) {
    envPill = document.createElement('span')
    envPill.id = 'envCornerPill'
    envPill.className = `env-badge ${envClass}`
    document.body.appendChild(envPill)
  }
  envPill.textContent = envClass

  // Set initial theme active state on option rows
  _updateThemeOptions(getTheme())

  // Hamburger toggles mobile nav dropdown
  const menuBtn = document.getElementById('menuToggle')
  const mobileNavEl = document.getElementById('mobileNavDropdown')
  if (menuBtn && mobileNavEl) {
    menuBtn.addEventListener('click', e => {
      e.stopPropagation()
      // Close other menus before toggling mobile nav
      document.getElementById('userMenu')?.classList.remove('open')
      document.getElementById('themeMenu')?.classList.remove('open')
      mobileNavEl.classList.toggle('open')
    })
  }

  // Close all dropdowns on outside click
  document.addEventListener('click', e => {
    const ud = document.getElementById('userDropdown')
    if (ud && !ud.contains(e.target)) document.getElementById('userMenu')?.classList.remove('open')
    const td = document.getElementById('themeDropdown')
    if (td && !td.contains(e.target)) document.getElementById('themeMenu')?.classList.remove('open')
    const mn = document.getElementById('mobileNavDropdown')
    const mb = document.getElementById('menuToggle')
    if (mn && mb && !mn.contains(e.target) && !mb.contains(e.target)) mn.classList.remove('open')
  })
}

function _updateThemeOptions(t) {
  ;['system','light','dark','oled'].forEach(id => {
    const el = document.getElementById('themeOpt-' + id)
    if (el) el.classList.toggle('active', id === t)
  })
}

function toggleThemeMenu(e) {
  if (e) e.stopPropagation()
  // Close user menu if open
  document.getElementById('userMenu')?.classList.remove('open')
  document.getElementById('themeMenu')?.classList.toggle('open')
}

function toggleUserMenu(e) {
  if (e) e.stopPropagation()
  // Close theme menu and mobile nav if open
  document.getElementById('themeMenu')?.classList.remove('open')
  document.getElementById('mobileNavDropdown')?.classList.remove('open')
  document.getElementById('userMenu')?.classList.toggle('open')
}

function setTheme(t) {
  applyTheme(t)
  document.getElementById('themeMenu')?.classList.remove('open')
  _updateThemeOptions(t)
  toast(`Theme: ${t}`, 'success', 1500)
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
