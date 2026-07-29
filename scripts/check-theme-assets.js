'use strict'

const assert = require('assert')
const fs = require('fs')
const vm = require('vm')
const path = require('path')

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'theme-assets.js'), 'utf8')

function element(attributes = {}) {
  return {
    attributes: { ...attributes },
    setAttribute(name, value) { this.attributes[name] = value },
    getAttribute(name) { return this.attributes[name] ?? null },
  }
}

function runScenario(theme, systemDark) {
  const logos = [element({ src: 'old-logo.png' }), element({ src: 'old-logo.png' })]
  const appleIcons = [element({ href: 'old-touch.png' })]
  const browserIcons = [
    element({ href: 'old-browser.png' }),
    element({ href: 'old-light-media.png', media: '(prefers-color-scheme: light)' }),
    element({ href: 'old-dark-media.png', media: '(prefers-color-scheme: dark)' }),
  ]
  const manifest = element({ href: 'old-manifest.json' })
  const themeColour = element({ content: '#ffffff' })
  const root = element()
  let runtimeIcon = null
  let colourSchemeListener = null
  let storageListener = null

  const mediaQuery = {
    matches: systemDark,
    addEventListener(type, listener) {
      if (type === 'change') colourSchemeListener = listener
    },
    addListener(listener) {
      colourSchemeListener = listener
    },
  }

  const document = {
    documentElement: {
      setAttribute(name, value) { root.setAttribute(name, value) },
      removeAttribute(name) { delete root.attributes[name] },
    },
    head: {
      appendChild(node) { runtimeIcon = node },
    },
    createElement() { return element() },
    getElementById(id) {
      if (id === 'appManifest') return manifest
      if (id === 'runtimeAppIcon') return runtimeIcon
      return null
    },
    querySelector(selector) {
      if (selector === 'meta[name="theme-color"]') return themeColour
      return null
    },
    querySelectorAll(selector) {
      if (selector === '[data-app-logo]') return logos
      if (selector === 'link[rel="apple-touch-icon"]') return appleIcons
      if (selector.includes('link[rel="icon"]')) return browserIcons
      return []
    },
  }

  const window = {
    document,
    localStorage: { getItem: key => key === 'fs-theme' ? theme : null },
    matchMedia: () => mediaQuery,
    addEventListener(type, listener) {
      if (type === 'storage') storageListener = listener
    },
  }

  vm.runInNewContext(source, { window, document, console })

  const resolvedDark = theme === 'dark' || theme === 'oled' || (theme === 'system' && systemDark)
  const expectedIcon = resolvedDark ? 'app-icon-dark-1024.png' : 'app-icon-light-1024.png'
  const expectedManifest = resolvedDark ? 'manifest-dark.json' : 'manifest-light.json'
  const expectedRootTheme = theme === 'oled' ? 'oled' : resolvedDark ? 'dark' : undefined
  const expectedThemeColour = theme === 'oled' ? '#000000' : resolvedDark ? '#0f172a' : '#4f46e5'

  logos.forEach(logo => assert.match(logo.getAttribute('src'), new RegExp(expectedIcon)))
  appleIcons.forEach(icon => assert.match(icon.getAttribute('href'), new RegExp(expectedIcon)))
  browserIcons.forEach(icon => assert.match(icon.getAttribute('href'), new RegExp(expectedIcon)))
  assert.match(runtimeIcon.getAttribute('href'), new RegExp(expectedIcon))
  assert.match(manifest.getAttribute('href'), new RegExp(expectedManifest))
  assert.strictEqual(root.getAttribute('data-theme') ?? undefined, expectedRootTheme)
  assert.strictEqual(themeColour.getAttribute('content'), expectedThemeColour)

  return {
    logos,
    browserIcons,
    manifest,
    mediaQuery,
    root,
    themeColour,
    window,
    colourSchemeListener,
    storageListener,
  }
}

runScenario('light', false)
runScenario('dark', false)
runScenario('oled', false)
const systemScenario = runScenario('system', false)
runScenario('system', true)

systemScenario.mediaQuery.matches = true
systemScenario.colourSchemeListener()
systemScenario.logos.forEach(logo => assert.match(logo.getAttribute('src'), /app-icon-dark-1024\.png/))
assert.strictEqual(systemScenario.root.getAttribute('data-theme'), 'dark')

systemScenario.storageListener({ key: 'fs-theme', newValue: 'oled' })
systemScenario.browserIcons.forEach(icon => assert.match(icon.getAttribute('href'), /app-icon-dark-1024\.png/))
assert.strictEqual(systemScenario.root.getAttribute('data-theme'), 'oled')
assert.strictEqual(systemScenario.themeColour.getAttribute('content'), '#000000')

console.log('Theme asset contract OK: Light, Dark, OLED, System, OS-change, and cross-tab mappings verified.')
