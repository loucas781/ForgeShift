/* shell.js — shared layout, theme, toast, nav helpers */

// ── Collapsible card sections ──────────────────────────────────────────────────
// containerSelector: optional CSS selector to scope which .card-header elements
// are made collapsible (e.g. '.settings-panel'). Defaults to all .card-header.
function initCollapsibleSections(containerSelector) {
  const STORAGE_KEY = 'fs-settings-collapsed'
  let collapsed = {}
  try { collapsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') } catch {}

  const selector = containerSelector ? `${containerSelector} .card-header` : '.card-header'

  document.querySelectorAll(selector).forEach(header => {
    if (header.querySelector('.section-collapse-btn')) return

    const card = header.closest('.card')
    if (!card) return
    const body = card.querySelector('.card-body')
    if (!body) return

    const title = header.querySelector('.card-title')?.textContent?.trim() || header.textContent.trim()
    const key   = title.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')

    const btn = document.createElement('button')
    btn.className = 'section-collapse-btn'
    btn.setAttribute('aria-label', 'Toggle section')
    btn.setAttribute('type', 'button')
    btn.innerHTML = '<svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16"><path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd"/></svg>'

    // If the header already has action buttons, group them with the chevron so
    // they all sit neatly on the right side without crushing the title.
    const existingBtns = [...header.querySelectorAll('button:not(.section-collapse-btn)')]
    if (existingBtns.length > 0) {
      const group = document.createElement('div')
      group.style.cssText = 'display:flex;align-items:center;gap:8px;margin-left:auto;flex-shrink:0'
      existingBtns.forEach(b => group.appendChild(b))
      group.appendChild(btn)
      header.appendChild(group)
    } else {
      header.appendChild(btn)
    }

    header.style.cursor = 'pointer'

    function applyState(isCollapsed, animate) {
      card.classList.toggle('section-collapsed', isCollapsed)
      btn.classList.toggle('section-collapse-rotated', isCollapsed)
      if (!animate) { body.style.transition = 'none'; requestAnimationFrame(() => body.style.transition = '') }
    }

    if (collapsed[key]) applyState(true, false)

    header.addEventListener('click', e => {
      if (e.target.closest('button:not(.section-collapse-btn), input, select, a')) return
      const now  = card.classList.contains('section-collapsed')
      const next = !now
      applyState(next, true)
      if (next) { collapsed[key] = true } else { delete collapsed[key] }
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(collapsed)) } catch {}
    })
  })
}
'use strict'

function safeLocalStorageGet(key, fallback = null) {
  try {
    const value = localStorage.getItem(key)
    return value == null ? fallback : value
  } catch {
    return fallback
  }
}

function safeLocalStorageSet(key, value) {
  try { localStorage.setItem(key, value) } catch {}
}

function fetchWithTimeout(path, opts = {}, timeoutMs = 12000) {
  if (typeof AbortController !== 'function') return fetch(path, opts)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const request = { ...opts, signal: controller.signal }
  return fetch(path, request).finally(() => clearTimeout(timer))
}

// ── Config ─────────────────────────────────────────────────────────────────────
let _config = null

function _isStandaloneApp() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true
}

function _syncStandaloneClass() {
  document.documentElement.classList.toggle('standalone-app', _isStandaloneApp())
}

function _resolvedTheme(theme) {
  if (window.ForgeShiftThemeAssets) return window.ForgeShiftThemeAssets.resolve(theme)
  if (theme === 'system') return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  return theme === 'dark' || theme === 'oled' ? 'dark' : 'light'
}

function _applyAppIconTheme(theme) {
  if (window.ForgeShiftThemeAssets) {
    window.ForgeShiftThemeAssets.sync(theme)
    return
  }
  const mode = _resolvedTheme(theme)
  const iconHref = mode === 'dark' ? '/icons/app-icon-dark-1024.png?v=20260429c' : '/icons/app-icon-light-1024.png?v=20260429c'
  const manifestHref = mode === 'dark' ? '/manifest-dark.json?v=20260429c' : '/manifest-light.json?v=20260429c'

  const manifest = document.getElementById('appManifest')
  if (manifest) manifest.setAttribute('href', manifestHref)

  const appleTouch = document.querySelector('link[rel="apple-touch-icon"]')
  if (appleTouch) appleTouch.setAttribute('href', iconHref)

  let runtimeIcon = document.getElementById('runtimeAppIcon')
  if (!runtimeIcon) {
    runtimeIcon = document.createElement('link')
    runtimeIcon.id = 'runtimeAppIcon'
    runtimeIcon.rel = 'icon'
    runtimeIcon.type = 'image/png'
    document.head.appendChild(runtimeIcon)
  }
  runtimeIcon.setAttribute('href', iconHref)

  const topbarLogo = document.getElementById('topbarLogoImg')
  if (topbarLogo) topbarLogo.setAttribute('src', iconHref)
}

async function loadConfig() {
  if (_config) return _config
  const r = await fetchWithTimeout('/api/config')
  _config = await r.json()
  if (!_config.user) { window.location.href = '/login.html'; return null }
  return _config
}

// ── Theme ──────────────────────────────────────────────────────────────────────
function applyTheme(theme) {
  safeLocalStorageSet('fs-theme', theme)
  if (window.ForgeShiftThemeAssets) {
    window.ForgeShiftThemeAssets.apply(theme)
    return
  }
  if (theme === 'system') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : '')
    if (!prefersDark) document.documentElement.removeAttribute('data-theme')
  } else if (theme === 'light') {
    document.documentElement.removeAttribute('data-theme')
  } else {
    document.documentElement.setAttribute('data-theme', theme)
  }
  _applyAppIconTheme(theme)
}

function getTheme() {
  return safeLocalStorageGet('fs-theme', 'system') || 'system'
}

// Apply theme immediately (called inline on every page — no flash)
;(function() {
  _syncStandaloneClass()
  const t = getTheme()
  if (t === 'system') {
    if (window.matchMedia('(prefers-color-scheme: dark)').matches)
      document.documentElement.setAttribute('data-theme', 'dark')
  } else if (t === 'light') {
    document.documentElement.removeAttribute('data-theme')
  } else {
    document.documentElement.setAttribute('data-theme', t)
  }
  _applyAppIconTheme(t)
  // Watch for OS-level changes when in system mode
  if (!window.ForgeShiftThemeAssets) {
    const colourSchemeMq = window.matchMedia('(prefers-color-scheme: dark)')
    const handleColourSchemeChange = e => {
      if (getTheme() === 'system') {
        document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : '')
        if (!e.matches) document.documentElement.removeAttribute('data-theme')
        _applyAppIconTheme('system')
      }
    }
    if (colourSchemeMq.addEventListener) colourSchemeMq.addEventListener('change', handleColourSchemeChange)
    else if (colourSchemeMq.addListener) colourSchemeMq.addListener(handleColourSchemeChange)
  }
  const standaloneMq = window.matchMedia('(display-mode: standalone)')
  const handleStandaloneChange = () => _syncStandaloneClass()
  if (standaloneMq.addEventListener) standaloneMq.addEventListener('change', handleStandaloneChange)
  else if (standaloneMq.addListener) standaloneMq.addListener(handleStandaloneChange)
  window.addEventListener('pageshow', handleStandaloneChange)
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
  const toastMessage = String(message)
  const duplicate = [...container.children].find(item => item.dataset.toastMessage === toastMessage && item.dataset.toastType === type)
  if (duplicate) duplicate.remove()
  const t = document.createElement('div')
  t.className = `toast${type !== 'default' ? ' ' + type : ''}`
  t.dataset.toastMessage = toastMessage
  t.dataset.toastType = type

  const icons = {
    success: '<svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16" style="flex-shrink:0"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>',
    error:   '<svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16" style="flex-shrink:0"><path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>',
    warning: '<svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16" style="flex-shrink:0"><path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>',
  }
  if (icons[type]) {
    const iconSpan = document.createElement('span')
    iconSpan.innerHTML = icons[type] // icons are hardcoded SVG — safe
    if (iconSpan.firstElementChild) t.appendChild(iconSpan.firstElementChild)
  }
  t.appendChild(document.createTextNode(toastMessage))
  container.appendChild(t)
  setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateY(8px)'; t.style.transition = '200ms'; setTimeout(() => t.remove(), 200) }, duration)
}

// ── HTML escaping utility ──────────────────────────────────────────────────────
function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

// Render rich-text description HTML safely (allows only formatting tags, strips attributes/scripts)
function sanitizeDescHtml(html) {
  if (!html) return ''
  const allowed = new Set(['B','STRONG','U','EM','UL','OL','LI','P','BR','DIV','SPAN'])
  const tmp = document.createElement('div')
  tmp.innerHTML = html
  ;(function clean(node) {
    Array.from(node.childNodes).forEach(child => {
      if (child.nodeType === 1) {
        if (!allowed.has(child.tagName)) {
          while (child.firstChild) node.insertBefore(child.firstChild, child)
          child.remove()
        } else {
          Array.from(child.attributes).forEach(a => child.removeAttribute(a.name))
          clean(child)
        }
      }
    })
  })(tmp)
  return tmp.innerHTML
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

function _cfgHasPermission(cfg, permission) {
  if (cfg?.user?.role === 'admin') return true
  let permissions = cfg?.user?.permissions || []
  if (typeof permissions === 'string') {
    try { permissions = JSON.parse(permissions) } catch { permissions = [] }
  }
  return Array.isArray(permissions) && permissions.includes(permission)
}

// ── Shell render ───────────────────────────────────────────────────────────────
function renderShell(cfg, activePage) {
  // Topbar
  const topbar = document.getElementById('topbar')
  if (!topbar) return

  const envClass = String(cfg.appEnv || 'development').replace(/[^a-z0-9_-]/gi, '') || 'development'
  const safeVersion = escHtml(cfg.version)
  const safeName = escHtml(cfg.user?.name)
  const safeEmail = escHtml(cfg.user?.email)
  const safeRoleName = escHtml(cfg.user?.role_name || ({ shift_lead:'Shift Lead', manager:'Manager', admin:'Admin', member:'Member' }[cfg.user?.role] || 'Member'))
  const roleColour = resolveColourValue(cfg.user?.role_color, '#64748b')
  const rolePill = `<span style="display:inline-flex;align-items:center;gap:5px;margin-top:6px;border:1px solid color-mix(in srgb,${roleColour} 55%,var(--border));border-radius:999px;padding:3px 7px;color:var(--text-2);background:color-mix(in srgb,${roleColour} 12%,var(--surface));font-size:9px;font-weight:750;line-height:1;text-transform:uppercase;letter-spacing:.04em"><span style="width:6px;height:6px;border-radius:50%;background:${roleColour}"></span>${safeRoleName}</span>`
  const mobileRolePill = `<span style="display:inline-flex;align-items:center;gap:5px;margin-top:6px;border:1px solid rgba(255,255,255,.2);border-radius:999px;padding:3px 7px;color:#fff;background:rgba(255,255,255,.07);font-size:9px;font-weight:750;line-height:1;text-transform:uppercase;letter-spacing:.04em"><span style="width:6px;height:6px;border-radius:50%;background:${roleColour};box-shadow:0 0 0 1px rgba(255,255,255,.35)"></span>${safeRoleName}</span>`
  const showCalendar = cfg.user?.role === 'admin'
    || _cfgHasPermission(cfg, 'view_calendar')
    || _cfgHasPermission(cfg, 'view_shifts')
    || _cfgHasPermission(cfg, 'view_own_rota')
    || _cfgHasPermission(cfg, 'view_team_rotas')
    || _cfgHasPermission(cfg, 'view_all_rotas')
  const showTemplates = cfg.user?.role === 'admin'
    || _cfgHasPermission(cfg, 'view_templates')
    || _cfgHasPermission(cfg, 'manage_templates')
    || _cfgHasPermission(cfg, 'add_own_shifts')
    || _cfgHasPermission(cfg, 'add_other_shifts')
  const showSettings = cfg.user?.role === 'admin' || _cfgHasPermission(cfg, 'view_settings') || _cfgHasPermission(cfg, 'manage_settings')
  const showEnvBadges = envClass !== 'production'

  topbar.innerHTML = `
    <button class="topbar-menu-btn" id="menuToggle" aria-label="Menu">
      <svg viewBox="0 0 20 20" fill="currentColor" width="20" height="20"><path fill-rule="evenodd" d="M3 5h14a1 1 0 110 2H3a1 1 0 110-2zm0 4h14a1 1 0 110 2H3a1 1 0 110-2zm0 4h14a1 1 0 110 2H3a1 1 0 110-2z" clip-rule="evenodd"/></svg>
    </button>
    <a href="/" class="topbar-logo">
      <img id="topbarLogoImg" class="topbar-logo-img" data-app-logo src="${_resolvedTheme(getTheme()) === 'dark' ? '/icons/app-icon-dark-1024.png?v=20260429c' : '/icons/app-icon-light-1024.png?v=20260429c'}" alt="ForgeShift">
      <span class="topbar-logo-text">ForgeShift</span>
    </a>
    ${showEnvBadges ? `<span class="env-topbar-badge ${envClass}" title="v${cfg.version}">${envClass}</span>` : ''}
    <span class="version-badge">v${cfg.version}</span>
    <nav class="topbar-nav">
      ${showCalendar ? `<a href="/" class="topbar-nav-btn${activePage==='calendar'?' active':''}">
        <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M6 2a1 1 0 00-1 1v1H4a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-1V3a1 1 0 10-2 0v1H7V3a1 1 0 00-1-1zm0 5a1 1 0 000 2h8a1 1 0 100-2H6z" clip-rule="evenodd"/></svg>
        Calendar
      </a>` : ''}
      ${showTemplates ? `<a href="/templates.html" class="topbar-nav-btn${activePage==='templates'?' active':''}">
        <svg viewBox="0 0 20 20" fill="currentColor"><path d="M9 2a2 2 0 00-2 2v8a2 2 0 002 2h6a2 2 0 002-2V6.414A2 2 0 0016.414 5L14 2.586A2 2 0 0012.586 2H9z"/><path d="M3 8a2 2 0 012-2h2a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z"/></svg>
        Templates
      </a>` : ''}
    </nav>
    <div class="topbar-spacer"></div>

    ${showSettings ? `
    <!-- Settings icon button (all users) -->
    <a href="/settings.html" class="topbar-icon-btn${activePage==='settings'?' active-icon':''}" title="Settings" aria-label="Settings">
      <svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18"><path fill-rule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clip-rule="evenodd"/></svg>
    </a>` : ''}

    <!-- Theme picker button -->
    <div class="dropdown-wrapper" id="themeDropdown">
      <button class="topbar-icon-btn" id="themeBtn" onclick="toggleThemeMenu(event)" aria-label="Change theme" title="Change theme">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" width="18" height="18">
          <rect x="2" y="3" width="20" height="14" rx="2"/>
          <path d="M8 21h8M12 17v4"/>
        </svg>
      </button>
      <div class="dropdown-menu" id="themeMenu" style="min-width:200px;right:0">
        <button class="theme-option" id="themeOpt-system" onclick="setTheme('system')">
          <span class="theme-option-icon">
            <svg viewBox="0 0 16 16" fill="currentColor" width="11" height="11"><path d="M8 2a6 6 0 100 12A6 6 0 008 2zm0 1.5A4.5 4.5 0 018 13V3.5z"/></svg>
          </span>
          System
          <span class="theme-option-check"><svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg></span>
        </button>
        <button class="theme-option" id="themeOpt-light" onclick="setTheme('light')">
          <span class="theme-option-icon" style="background:#f3f4f6;border-color:#e5e7eb">
            <svg viewBox="0 0 16 16" fill="#374151" width="11" height="11"><circle cx="8" cy="8" r="3.5"/><path stroke="#374151" stroke-width="1.5" stroke-linecap="round" d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3.22 3.22l1.06 1.06M11.72 11.72l1.06 1.06M11.72 4.28l-1.06 1.06M4.28 11.72l-1.06 1.06" fill="none"/></svg>
          </span>
          Light
          <span class="theme-option-check"><svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg></span>
        </button>
        <button class="theme-option" id="themeOpt-dark" onclick="setTheme('dark')">
          <span class="theme-option-icon" style="background:#1e293b;border-color:#334155">
            <svg viewBox="0 0 16 16" fill="#94a3b8" width="11" height="11"><path d="M9.598 1.591a.75.75 0 01.785-.175 7 7 0 11-8.967 8.967.75.75 0 01.961-.96 5.5 5.5 0 007.046-7.046.75.75 0 01.175-.786z"/></svg>
          </span>
          Dark
          <span class="theme-option-check"><svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg></span>
        </button>
        <button class="theme-option" id="themeOpt-oled" onclick="setTheme('oled')">
          <span class="theme-option-icon" style="background:#000;border-color:#222">
            <svg viewBox="0 0 16 16" fill="white" width="9" height="9"><rect x="2" y="2" width="12" height="12" rx="2"/></svg>
          </span>
          OLED Black
          <span class="theme-option-check"><svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg></span>
        </button>
      </div>
    </div>

    <!-- User menu -->
    <div class="dropdown-wrapper" id="userDropdown">
      <button class="topbar-user-btn" onclick="toggleUserMenu(event)" aria-label="Account menu">
        ${avatarEl(cfg.user).outerHTML}
      </button>
      <div class="dropdown-menu" id="userMenu" style="min-width:220px">
        <div class="dropdown-user-header">
          <div class="dropdown-user-name">${safeName}</div>
          <div class="dropdown-user-email">${safeEmail}</div>
          ${rolePill}
        </div>
        <a href="/profile.html" class="dropdown-item">
          <svg viewBox="0 0 20 20" fill="currentColor" width="15" height="15"><path fill-rule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clip-rule="evenodd"/></svg>
          Your Profile
        </a>
        ${showSettings ? `<a href="/settings.html" class="dropdown-item">
          <svg viewBox="0 0 20 20" fill="currentColor" width="15" height="15"><path fill-rule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clip-rule="evenodd"/></svg>
          Settings
        </a>` : ''}
        <div class="dropdown-sep"></div>
        <button class="dropdown-item danger" onclick="doLogout()">
          <svg viewBox="0 0 20 20" fill="currentColor" width="15" height="15"><path fill-rule="evenodd" d="M3 3a1 1 0 00-1 1v12a1 1 0 102 0V4a1 1 0 00-1-1zm10.293 9.293a1 1 0 001.414 1.414l3-3a1 1 0 000-1.414l-3-3a1 1 0 10-1.414 1.414L14.586 9H7a1 1 0 100 2h7.586l-1.293 1.293z" clip-rule="evenodd"/></svg>
          Sign Out
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
    <div class="mobile-nav-user-header">
      ${avatarEl(cfg.user, 'lg').outerHTML}
      <div style="min-width:0">
        <div style="font-size:13px;font-weight:700;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${safeName}</div>
        <div style="font-size:11px;color:rgba(255,255,255,.5);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${safeEmail}</div>
        ${mobileRolePill}
      </div>
    </div>
    <div class="mobile-nav-sep"></div>
    ${showCalendar ? `<a href="/" class="topbar-nav-btn${activePage==='calendar'?' active':''}" onclick="document.getElementById('mobileNavDropdown').classList.remove('open')">
      <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M6 2a1 1 0 00-1 1v1H4a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-1V3a1 1 0 10-2 0v1H7V3a1 1 0 00-1-1zm0 5a1 1 0 000 2h8a1 1 0 100-2H6z" clip-rule="evenodd"/></svg>
      Calendar
    </a>` : ''}
    ${showTemplates ? `<a href="/templates.html" class="topbar-nav-btn${activePage==='templates'?' active':''}" onclick="document.getElementById('mobileNavDropdown').classList.remove('open')">
      <svg viewBox="0 0 20 20" fill="currentColor"><path d="M9 2a2 2 0 00-2 2v8a2 2 0 002 2h6a2 2 0 002-2V6.414A2 2 0 0012.586 2H9z"/><path d="M3 8a2 2 0 012-2h2a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z"/></svg>
      Templates
    </a>` : ''}
    ${showSettings ? `<a href="/settings.html" class="topbar-nav-btn${activePage==='settings'?' active':''}" onclick="document.getElementById('mobileNavDropdown').classList.remove('open')">
      <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clip-rule="evenodd"/></svg>
      Settings
    </a>` : ''}
    <a href="/profile.html" class="topbar-nav-btn" onclick="document.getElementById('mobileNavDropdown').classList.remove('open')">
      <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clip-rule="evenodd"/></svg>
      Your Profile
    </a>
    <div class="mobile-nav-sep"></div>
    <button class="topbar-nav-btn" style="color:rgba(255,100,100,.9)" onclick="doLogout()">
      <svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18"><path fill-rule="evenodd" d="M3 3a1 1 0 00-1 1v12a1 1 0 102 0V4a1 1 0 00-1-1zm10.293 9.293a1 1 0 001.414 1.414l3-3a1 1 0 000-1.414l-3-3a1 1 0 10-1.414 1.414L14.586 9H7a1 1 0 100 2h7.586l-1.293 1.293z" clip-rule="evenodd"/></svg>
      Sign Out
    </button>
  `

  // Inject fixed bottom-right env pill for non-production only.
  let envPill = document.getElementById('envCornerPill')
  if (showEnvBadges) {
    if (!envPill) {
      envPill = document.createElement('span')
      envPill.id = 'envCornerPill'
      document.body.appendChild(envPill)
    }
    envPill.className = `env-badge ${envClass}`
    envPill.textContent = envClass
  } else if (envPill) {
    envPill.remove()
  }

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

// ── Inactivity timeout watcher ─────────────────────────────────────────────────
;(function () {
  const WARN_BEFORE_MS = 60 * 1000   // show warning 60s before logout
  const MIN_WARN_MS    = 20 * 1000   // minimum warning window

  let timeoutMs       = 0
  let lastActivity    = Date.now()
  let warnTimer       = null
  let logoutTimer     = null
  let countdownIv     = null
  let warningShown    = false

  function scheduleTimers() {
    clearTimeout(warnTimer)
    clearTimeout(logoutTimer)
    if (!timeoutMs) return
    const warnIn = timeoutMs - Math.max(Math.min(WARN_BEFORE_MS, timeoutMs - MIN_WARN_MS), MIN_WARN_MS)
    warnTimer   = setTimeout(showWarning, Math.max(warnIn, 0))
    logoutTimer = setTimeout(performLogout, timeoutMs)
  }

  function onActivity() {
    if (warningShown) return   // only the "Stay signed in" button dismisses the warning
    lastActivity = Date.now()
    scheduleTimers()
  }

  function showWarning() {
    warningShown = true
    const warnMs = Math.max(Math.min(WARN_BEFORE_MS, timeoutMs - MIN_WARN_MS), MIN_WARN_MS)
    let secsLeft = Math.ceil(warnMs / 1000)

    let modal = document.getElementById('fs-inactivity-modal')
    if (!modal) {
      modal = document.createElement('div')
      modal.id = 'fs-inactivity-modal'
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:10000;display:flex;align-items:center;justify-content:center'
      modal.innerHTML = `
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r-xl);padding:28px 32px;max-width:360px;width:90%;text-align:center;box-shadow:var(--shadow-xl)">
          <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="var(--brand)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom:12px"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          <h3 style="font-size:16px;font-weight:700;margin-bottom:8px;color:var(--text)">Still there?</h3>
          <p style="font-size:13px;color:var(--text-2);margin-bottom:4px;line-height:1.6">
            You'll be signed out in <strong id="fs-inactivity-countdown" style="color:var(--text)"></strong> due to inactivity.
          </p>
          <button id="fs-inactivity-stay" class="btn btn-primary" style="margin-top:18px;width:100%">Stay signed in</button>
        </div>`
      document.body.appendChild(modal)
      document.getElementById('fs-inactivity-stay').addEventListener('click', keepAlive)
    } else {
      modal.style.display = 'flex'
    }

    function tick() {
      const el = document.getElementById('fs-inactivity-countdown')
      if (el) el.textContent = secsLeft >= 60 ? `${Math.ceil(secsLeft / 60)} min` : `${secsLeft}s`
    }
    tick()
    clearInterval(countdownIv)
    countdownIv = setInterval(() => { if (--secsLeft <= 0) clearInterval(countdownIv); else tick() }, 1000)
  }

  function keepAlive() {
    warningShown = false
    clearInterval(countdownIv)
    clearTimeout(logoutTimer)
    const modal = document.getElementById('fs-inactivity-modal')
    if (modal) modal.style.display = 'none'
    lastActivity = Date.now()
    scheduleTimers()
    // Ping server to refresh last_used_at
    fetch('/api/auth/me').catch(() => {})
  }

  async function performLogout() {
    clearInterval(countdownIv)
    try { await fetch('/api/auth/logout', { method: 'POST' }) } catch {}
    window.location.href = '/login.html?reason=inactivity'
  }

  const events = ['mousemove', 'keydown', 'mousedown', 'touchstart', 'scroll', 'click']

  document.addEventListener('DOMContentLoaded', async () => {
    events.forEach(e => document.addEventListener(e, onActivity, { passive: true }))
    try {
      const r = await fetchWithTimeout('/api/config')
      if (!r.ok) return
      const data = await r.json()
      if (!data.user) return  // not authenticated
      const mins = data.inactivityTimeout
      if (mins && mins > 0) {
        timeoutMs = mins * 60 * 1000
        scheduleTimers()
      }
    } catch {}
  })
})()

// ── API helpers ────────────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const r = await fetchWithTimeout(path, {
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
  // Use local date components to avoid UTC offset shifting the date (e.g. BST UTC+1)
  const y  = d.getFullYear()
  const m  = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
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
  { value: '#2563eb', label: 'Blue' },
  { value: '#0284c7', label: 'Sky' },
  { value: '#0891b2', label: 'Cyan' },
  { value: '#0f766e', label: 'Teal' },
  { value: '#059669', label: 'Emerald' },
  { value: '#65a30d', label: 'Lime' },
  { value: '#d97706', label: 'Amber' },
  { value: '#ea580c', label: 'Orange' },
  { value: '#dc2626', label: 'Red' },
  { value: '#e11d48', label: 'Rose' },
  { value: '#db2777', label: 'Pink' },
  { value: '#7c3aed', label: 'Purple' },
  { value: '#9333ea', label: 'Violet' },
  { value: '#6b7280', label: 'Gray' },
  { value: '#78716c', label: 'Stone' },
]
const HEX_COLOUR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

function normalizeOptionalColourValue(value) {
  const colour = typeof value === 'string' ? value.trim() : ''
  if (!colour) return ''
  return HEX_COLOUR_RE.test(colour) ? colour : ''
}

function resolveColourValue(value, fallback = '') {
  return value === undefined || value === null
    ? fallback
    : normalizeOptionalColourValue(value)
}

function pickColourValue(...values) {
  for (const value of values) {
    const colour = normalizeOptionalColourValue(value)
    if (colour) return colour
  }
  return ''
}

function getAccentPresentation(value, options = {}) {
  const {
    alpha = '18',
    neutralBackground = 'var(--surface-2)',
    neutralBorder = 'var(--border)',
    neutralText = 'var(--text-2)',
  } = options
  const colour = pickColourValue(value)
  if (!colour) {
    return {
      background: neutralBackground,
      border: neutralBorder,
      color: neutralText,
    }
  }
  return {
    background: `${colour}${alpha}`,
    border: colour,
    color: colour,
  }
}

function renderInlineColourSwatch(value, options = {}) {
  const {
    size = 20,
    round = true,
    title = '',
    className = '',
  } = options
  const colour = pickColourValue(value)
  const classes = ['inline-colour-swatch']
  if (round) classes.push('is-round')
  if (!colour) classes.push('is-none')
  if (className) classes.push(className)
  const styles = [
    `width:${size}px`,
    `height:${size}px`,
    `border-radius:${round ? '50%' : '6px'}`,
  ]
  if (colour) styles.push(`background:${colour}`, `--swatch-colour:${colour}`)
  const titleAttr = title ? ` title="${escHtml(title)}"` : ''
  return `<span class="${classes.join(' ')}" style="${styles.join(';')}"${titleAttr}></span>`
}

// ── PWA — Service Worker registration ──────────────────────────────────────────
if ('serviceWorker' in navigator) {
  ;(async () => {
    try {
      const cfg = await loadConfig()
      const env = (cfg?.appEnv || '').toLowerCase()
      if (env === 'development') {
        const regs = await navigator.serviceWorker.getRegistrations()
        await Promise.all(regs.map(r => r.unregister()))
        return
      }
      navigator.serviceWorker.register('/sw.js').catch(() => {})
    } catch {
      navigator.serviceWorker.register('/sw.js').catch(() => {})
    }
  })()
}

function renderColourPicker(container, value, onChange, options = {}) {
  const { allowNone = false } = options
  const selectedValue = resolveColourValue(value)
  const swatches = allowNone
    ? [{ value: '', label: 'No colour' }, ...NOTE_COLOURS]
    : NOTE_COLOURS
  container.className = 'colour-picker'
  container.innerHTML = ''
  swatches.forEach(c => {
    const sw = document.createElement('button')
    sw.type = 'button'
    sw.className = `colour-swatch${selectedValue === c.value ? ' selected' : ''}${c.value ? '' : ' is-none'}`
    if (c.value) {
      sw.style.background = c.value
      sw.style.setProperty('--swatch-colour', c.value)
    }
    sw.title = c.label
    sw.setAttribute('aria-label', c.label)
    sw.setAttribute('aria-pressed', String(selectedValue === c.value))
    sw.addEventListener('click', () => {
      container.querySelectorAll('.colour-swatch').forEach(s => {
        s.classList.remove('selected')
        s.setAttribute('aria-pressed', 'false')
      })
      sw.classList.add('selected')
      sw.setAttribute('aria-pressed', 'true')
      onChange(c.value)
    })
    container.appendChild(sw)
  })
}
