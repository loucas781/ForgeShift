'use strict'
// Dependency-free checks; never opens the application database or changes accounts.
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const assert = require('assert/strict')
const root = path.resolve(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
let scripts = 0
function syntax(dir) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) syntax(file)
    else if (file.endsWith('.js')) { new vm.Script(read(file), { filename: file }); scripts++ }
    else if (file.endsWith('.html')) {
      for (const match of read(file).matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
        if (/application\/(?:ld\+)?json/.test(match[1])) continue
        new vm.Script(match[2], { filename: file }); scripts++
      }
    }
  }
}
function extract(source, start, end) {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from + start.length)
  assert(from >= 0 && to > from, `Missing test boundary: ${start}`)
  return source.slice(from, to)
}
async function main() {
  syntax('public'); syntax('server')
  const settings = read('public/settings.html')
  const elements = new Map()
  const element = id => {
    if (!elements.has(id)) elements.set(id, { innerHTML: '' })
    return elements.get(id)
  }
  let renders = 0
  const ctx = vm.createContext({
    document: { getElementById: element },
    api: async () => ({ feature_tasks: true }),
    hasPermission: () => false,
    loadTaskLists: async () => {},
    renderTaskListOrgTabs: () => {},
    renderTaskListLabelTabs: () => {},
    renderTaskListsTable: () => { renders++ },
  })
  vm.runInContext(extract(settings, 'async function renderFeaturesPanel()', 'let activeTaskListOrgTab'), ctx)
  await ctx.renderFeaturesPanel()
  assert.equal(renders, 1, 'Enabled features must render task lists')
  assert.match(element('panel-features').innerHTML, /id="taskListsSection"/)
  assert.match(element('panel-features').innerHTML, /id="featureTasksToggle"[^>]*disabled/)
  ctx.api = async () => ({ feature_tasks: false })
  await ctx.renderFeaturesPanel()
  assert.equal(renders, 2)
  assert.match(element('panel-features').innerHTML, /id="taskListsSection" style="display:none"/)
  ctx.api = async () => { throw Error('Offline') }
  await assert.rejects(ctx.renderFeaturesPanel(), /Offline/)

  const roles = vm.createContext({
    PERMISSION_CATALOG: [{ key: 'assign_own_tasks' }],
    parsePermissions: value => value,
    normalizeColorInput: value => value,
  })
  vm.runInContext(extract(read('server/routes/roles.js'), 'function validatePayload(', "router.get('/catalog'"), roles)
  const body = { name: 'Custom', color: '#123456', permissions: ['assign_own_tasks'] }
  assert.equal(roles.validatePayload(body).permissions[0], 'assign_own_tasks')
  assert(roles.validatePayload({ ...body, permissions: ['unknown'] }).error)
  assert(roles.validatePayload({ ...body, permissions: 'assign_own_tasks' }).error)

  // Exercise actual confirmation code with a minimal DOM, including keyboard handling.
  const document = { activeElement: null }
  let overlay
  class Element {
    constructor() { this.events = {}; this.children = {}; this.isConnected = true; this.style = {} }
    querySelector(key) { return this.children[key] ||= new Element() }
    addEventListener(key, fn) { this.events[key] = fn }
    setAttribute() {}
    appendChild(child) { this.child = child }
    focus() { document.activeElement = this }
    remove() { this.isConnected = false }
  }
  document.createElement = () => new Element()
  document.body = { appendChild: node => { overlay = node } }
  const previous = new Element(); previous.focus()
  const dialog = vm.createContext({ document })
  vm.runInContext(extract(read('public/js/shell.js'), 'let activeConfirmation', '// ── Collapsible card sections'), dialog)
  const first = dialog.confirmAction('Delete?')
  assert.equal(await dialog.confirmAction('Duplicate'), false)
  overlay.querySelector('[data-accept]').events.click()
  assert.equal(await first, true)
  assert.equal(document.activeElement, previous)
  const cancelled = dialog.confirmAction('Cancel?')
  overlay.events.keydown({ key: 'Escape', preventDefault() {}, stopPropagation() {} })
  assert.equal(await cancelled, false)
  const prompt = dialog.confirmAction('Name', { inputValue: 'Team' })
  overlay.querySelector('[data-accept]').events.click()
  assert.equal(await prompt, 'Team')
  console.log(`Passed: ${scripts} scripts parsed; task-list visibility, role validation, confirmation and focus regressions.`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
