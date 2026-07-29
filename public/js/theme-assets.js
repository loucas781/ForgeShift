/* ForgeShift theme-aware application artwork and browser metadata. */
(function initForgeShiftThemeAssets(global) {
  'use strict'

  const assetVersion = '20260429c'
  const lightIcon = `/icons/app-icon-light-1024.png?v=${assetVersion}`
  const darkIcon = `/icons/app-icon-dark-1024.png?v=${assetVersion}`
  const lightManifest = `/manifest-light.json?v=${assetVersion}`
  const darkManifest = `/manifest-dark.json?v=${assetVersion}`

  function resolve(theme) {
    if (theme === 'system') {
      return global.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    }
    return theme === 'dark' || theme === 'oled' ? 'dark' : 'light'
  }

  function sync(theme) {
    const selectedTheme = theme || 'system'
    const resolvedTheme = resolve(selectedTheme)
    const iconHref = resolvedTheme === 'dark' ? darkIcon : lightIcon
    const manifestHref = resolvedTheme === 'dark' ? darkManifest : lightManifest

    document.querySelectorAll('[data-app-logo]').forEach(image => {
      if (image.getAttribute('src') !== iconHref) image.setAttribute('src', iconHref)
    })

    document.querySelectorAll('link[rel="apple-touch-icon"]').forEach(link => {
      link.setAttribute('href', iconHref)
    })

    document.querySelectorAll('link[rel="icon"], link[rel="shortcut icon"]').forEach(link => {
      link.setAttribute('href', iconHref)
      link.setAttribute('type', 'image/png')
    })

    let runtimeIcon = document.getElementById('runtimeAppIcon')
    if (!runtimeIcon) {
      runtimeIcon = document.createElement('link')
      runtimeIcon.id = 'runtimeAppIcon'
      runtimeIcon.rel = 'icon'
      runtimeIcon.type = 'image/png'
      document.head.appendChild(runtimeIcon)
    }
    runtimeIcon.setAttribute('href', iconHref)

    const manifest = document.getElementById('appManifest')
    if (manifest) manifest.setAttribute('href', manifestHref)

    const themeColour = document.querySelector('meta[name="theme-color"]')
    if (themeColour) {
      themeColour.setAttribute(
        'content',
        selectedTheme === 'oled' ? '#000000' : resolvedTheme === 'dark' ? '#0f172a' : '#4f46e5'
      )
    }

    return { iconHref, manifestHref, resolvedTheme }
  }

  function apply(theme) {
    const selectedTheme = theme || 'system'
    const resolvedTheme = resolve(selectedTheme)
    if (selectedTheme === 'oled') document.documentElement.setAttribute('data-theme', 'oled')
    else if (resolvedTheme === 'dark') document.documentElement.setAttribute('data-theme', 'dark')
    else document.documentElement.removeAttribute('data-theme')
    return sync(selectedTheme)
  }

  function applyStored() {
    let theme = 'system'
    try { theme = global.localStorage.getItem('fs-theme') || 'system' } catch {}
    return apply(theme)
  }

  global.ForgeShiftThemeAssets = Object.freeze({ resolve, sync, apply, applyStored })
  applyStored()

  const colourScheme = global.matchMedia('(prefers-color-scheme: dark)')
  const handleSystemThemeChange = () => {
    let theme = 'system'
    try { theme = global.localStorage.getItem('fs-theme') || 'system' } catch {}
    if (theme === 'system') apply('system')
  }
  if (colourScheme.addEventListener) colourScheme.addEventListener('change', handleSystemThemeChange)
  else if (colourScheme.addListener) colourScheme.addListener(handleSystemThemeChange)

  global.addEventListener('storage', event => {
    if (event.key === 'fs-theme') apply(event.newValue || 'system')
  })
})(window)
