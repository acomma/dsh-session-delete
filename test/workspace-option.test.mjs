/**
 * Client-half tests for the workspace cascade option.
 *
 * The client bundle is a plain script that hands its factory to
 * `window.__ModuleLoader__`, so these tests load it into a hand-rolled DOM and
 * drive the two things that are easy to get wrong: finding the shipped
 * delete-workspace dialog and taking over `workspaces.delete` only when the
 * injected box is checked. The fake DOM encodes the shipped Modal's structure
 * (`[role="dialog"][aria-modal="true"]` → content div → header/description/body);
 * the Host tests cover the deletion itself.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const SOURCE = await readFile(new URL('../client.js', import.meta.url), 'utf8')
const DIALOG_SELECTOR = '[role="dialog"][aria-modal="true"]'
const WORKSPACE_ID = '11111111-2222-3333-4444-555555555555'
const BUILTIN_TITLE = '删除工作区'

const DICT = {
  'workspace.sessions': 'sessions-option',
  'workspace.sessionsHint': 'sessions-hint',
  'workspace.sessionsHintCount': 'sessions-count-{n}',
  'workspace.attachments': 'attachments-option',
  'workspace.attachmentsHint': 'attachments-hint',
  'error.workspacePartial': 'workspace-partial',
}

function translate(ns, key, params) {
  if (ns === 'workspace' && key === 'delete.workspace') return BUILTIN_TITLE
  if (ns !== 'session-delete') return key
  const template = DICT[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
}

//#region A minimal DOM: tags, attributes, children, connectivity, selectors
class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.parentNode = null
    this.dataset = {}
    this.attributes = new Map()
    this.listeners = new Map()
    this.textContent = ''
    this.className = ''
    this.checked = false
    this.disabled = false
    this.isConnected = false
  }

  get firstElementChild() {
    return this.children.length > 0 ? this.children[0] : null
  }

  append(...nodes) {
    for (const node of nodes) {
      node.parentNode = this
      this.children.push(node)
      markConnected(node)
    }
  }

  appendChild(node) {
    this.append(node)
    return node
  }

  remove() {
    const parent = this.parentNode
    if (parent === null) return
    const index = parent.children.indexOf(this)
    if (index >= 0) parent.children.splice(index, 1)
    this.parentNode = null
    markDisconnected(this)
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value))
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null
  }

  addEventListener(type, listener) {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  dispatch(type) {
    for (const listener of this.listeners.get(type) ?? []) listener({ target: this, currentTarget: this })
  }

  matches(selector) {
    return matchesSelector(this, selector)
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null
  }

  querySelectorAll(selector) {
    const found = []
    collect(this, selector, found)
    return found
  }
}

function markConnected(node) {
  node.isConnected = true
  for (const child of node.children) markConnected(child)
}

function markDisconnected(node) {
  node.isConnected = false
  for (const child of node.children) markDisconnected(child)
}

function collect(root, selector, found) {
  for (const child of root.children) {
    if (matchesSelector(child, selector)) found.push(child)
    collect(child, selector, found)
  }
}

function matchesSelector(element, selector) {
  if (selector === DIALOG_SELECTOR) {
    return element.getAttribute('role') === 'dialog' && element.getAttribute('aria-modal') === 'true'
  }
  return element.tagName === selector.toUpperCase()
}

function makeDocument() {
  const body = new FakeElement('body')
  const head = new FakeElement('head')
  body.isConnected = true
  head.isConnected = true
  return {
    body,
    head,
    createElement: (tag) => new FakeElement(tag),
    querySelectorAll: (selector) => {
      const found = []
      collect(body, selector, found)
      return found
    },
  }
}
//#endregion

//#region Loading the client bundle with stubs for its peer modules
const ReactStub = {
  createElement: () => null,
  Fragment: {},
  useSyncExternalStore: () => undefined,
}
const PrimitivesStub = {
  Button: () => null,
  IconTrashOutlineRegular: () => null,
  MenuItemButton: () => null,
  Modal: () => null,
}

let observerCallback = null

class FakeMutationObserver {
  constructor(callback) {
    observerCallback = callback
  }

  observe() {}

  disconnect() {}
}

/**
 * Run client.js and return its exported client module.
 * @param options.translate - the locale seat handed to the plugin.
 * @returns the loaded module plus its document and a mutation pump.
 */
function loadClient(translateSeat) {
  const document = makeDocument()
  let definition
  globalThis.window = { __ModuleLoader__: { load: (value) => { definition = value } } }
  globalThis.document = document
  globalThis.Element = FakeElement
  globalThis.MutationObserver = FakeMutationObserver
  vm.runInThisContext(SOURCE, { filename: 'client.js' })
  const loaded = definition.factory((name) => {
    if (name === 'react') return ReactStub
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return PrimitivesStub
    throw new Error(`unexpected require: ${name}`)
  })
  return {
    module: loaded,
    document,
    fire(records) {
      observerCallback(records)
    },
  }
}

function makeWorkspaceService({ items, original }) {
  return {
    delete: original,
    list: { getSnapshot: () => ({ items }) },
  }
}

function makeScope({ translateSeat, workspaces }) {
  const locale = { register: () => () => {}, translate: translateSeat }
  return {
    get(name) {
      if (name === 'locale') return locale
      if (name === 'workspaces') return workspaces
      return undefined
    },
    effect(callback) {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : undefined
    },
  }
}

function makeContext({ translateSeat, workspaces }) {
  const locale = { register: () => () => {}, translate: translateSeat }
  return {
    effect(callback) {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : undefined
    },
    locale,
    slots: { inject: () => {}, register: () => {} },
    inject(deps, callback) {
      if (deps.includes('workspaces')) callback(makeScope({ translateSeat, workspaces }))
    },
    get(name) {
      if (name === 'locale') return locale
      if (name === 'workspaces') return workspaces
      return undefined
    },
  }
}
//#endregion

//#region The shipped dialog, rebuilt the way the shipped Modal renders it
/**
 * Build the shipped confirmation: `div.root > div.dialog > (div.content, div.footer)`
 * with the content column holding `div.header` (an `h2`), a `p.description`, and
 * the body div.
 * @param options.title - the dialog's accessible name.
 * @param options.description - the paragraph under the header.
 * @returns the dialog frame and its body.
 */
function shippedDialog({ title = BUILTIN_TITLE, description = '将把“演示”从工作区列表中移除。' } = {}) {
  const root = new FakeElement('div')
  const dialog = new FakeElement('div')
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-label', title)
  const content = new FakeElement('div')
  const header = new FakeElement('div')
  const heading = new FakeElement('h2')
  header.append(heading)
  const text = new FakeElement('p')
  text.textContent = description
  const body = new FakeElement('div')
  content.append(header, text, body)
  const footer = new FakeElement('div')
  dialog.append(content, footer)
  root.append(dialog)
  return { root, dialog, content, body, footer }
}

/** Open a shipped dialog in the fake page and let the observer see it arrive. */
function openDialog(harness) {
  const frame = shippedDialog()
  harness.document.body.append(frame.root)
  harness.fire([{ addedNodes: [frame.root] }])
  return frame
}
//#endregion

/** Restore the globals a client load borrowed. */
function restoreGlobals(t) {
  t.after(() => {
    delete globalThis.window
    delete globalThis.document
    delete globalThis.Element
    delete globalThis.MutationObserver
    delete globalThis.fetch
    observerCallback = null
  })
}

test('mounts the option into the shipped delete-workspace dialog', async (t) => {
  const workspaces = makeWorkspaceService({ items: [], original: async () => {} })
  const harness = loadClient(translate)
  restoreGlobals(t)
  const ctx = makeContext({ translateSeat: translate, workspaces })
  harness.module.apply(ctx)
  const frame = openDialog(harness)

  const option = frame.body.querySelectorAll('label')
  assert.equal(option.length, 2)
  const sessions = frame.body.querySelectorAll('input')[0]
  const attachments = frame.body.querySelectorAll('input')[1]
  assert.equal(sessions.dataset.sessionDelete, 'workspace-sessions')
  assert.equal(sessions.checked, false)
  assert.equal(attachments.checked, true)
  assert.equal(attachments.disabled, true, 'attachment cleanup only matters once sessions go')
  const labels = frame.body.querySelectorAll('span').map((node) => node.textContent)
  assert.ok(labels.includes('sessions-option'))
  assert.ok(labels.includes('attachments-option'))
})

test('names the workspace session count from the shipped description', async (t) => {
  const workspaces = makeWorkspaceService({
    items: [{ workspaceId: WORKSPACE_ID, title: '演示', sessionIds: ['a', 'b', 'c'] }],
    original: async () => {},
  })
  const harness = loadClient(translate)
  restoreGlobals(t)
  harness.module.apply(makeContext({ translateSeat: translate, workspaces }))

  const frame = openDialog(harness)

  const hint = frame.body.querySelectorAll('span').find((node) => node.className === 'dsh-session-delete__optionHint')
  assert.equal(hint.textContent, 'sessions-count-3')
})

test('ignores a dialog that is not the shipped delete-workspace one', async (t) => {
  const workspaces = makeWorkspaceService({ items: [], original: async () => {} })
  const harness = loadClient(translate)
  restoreGlobals(t)
  harness.module.apply(makeContext({ translateSeat: translate, workspaces }))

  const frame = shippedDialog({ title: '永久删除会话？' })
  harness.document.body.append(frame.root)
  harness.fire([{ addedNodes: [frame.root] }])

  assert.equal(frame.body.children.length, 0)
})

test('leaves the shipped delete untouched while the option is unchecked', async (t) => {
  const calls = []
  const original = async (workspaceId) => {
    calls.push(['original', workspaceId])
  }
  const workspaces = makeWorkspaceService({ items: [], original })
  const harness = loadClient(translate)
  restoreGlobals(t)
  globalThis.fetch = async (url, init) => {
    calls.push(['fetch', url, init.body])
    return { ok: true, status: 200, json: async () => ({ ok: true, sessions: { skipped: [] } }) }
  }
  harness.module.apply(makeContext({ translateSeat: translate, workspaces }))
  openDialog(harness)

  await workspaces.delete(WORKSPACE_ID)

  assert.deepEqual(calls, [['original', WORKSPACE_ID]])
})

test('purges the workspace sessions before the shipped delete when checked', async (t) => {
  const calls = []
  const original = async (workspaceId) => {
    calls.push(['original', workspaceId])
  }
  const workspaces = makeWorkspaceService({ items: [], original })
  const harness = loadClient(translate)
  restoreGlobals(t)
  globalThis.fetch = async (url, init) => {
    calls.push(['fetch', url, init.body])
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, sessions: { deleted: ['a'], skipped: [], failed: [] } }),
    }
  }
  harness.module.apply(makeContext({ translateSeat: translate, workspaces }))
  const frame = openDialog(harness)

  const sessions = frame.body.querySelectorAll('input')[0]
  sessions.checked = true
  sessions.dispatch('change')
  assert.equal(frame.body.querySelectorAll('input')[1].disabled, false)

  await workspaces.delete(WORKSPACE_ID)

  assert.equal(calls.length, 2)
  assert.equal(calls[0][0], 'fetch')
  assert.equal(calls[0][1], 'api/workspace.purge-sessions')
  assert.deepEqual(JSON.parse(calls[0][2]), { workspaceId: WORKSPACE_ID, deleteSessions: true, deleteAttachments: true })
  assert.deepEqual(calls[1], ['original', WORKSPACE_ID])
})

test('keeps the registration when the purge fails and surfaces its reason', async (t) => {
  const calls = []
  const workspaces = makeWorkspaceService({ items: [], original: async () => { calls.push('original') } })
  const harness = loadClient(translate)
  restoreGlobals(t)
  globalThis.fetch = async () => ({
    ok: false,
    status: 500,
    json: async () => ({ ok: false, code: 'partial', message: 'boom' }),
  })
  harness.module.apply(makeContext({ translateSeat: translate, workspaces }))
  const frame = openDialog(harness)

  const sessions = frame.body.querySelectorAll('input')[0]
  sessions.checked = true
  sessions.dispatch('change')

  await assert.rejects(() => workspaces.delete(WORKSPACE_ID), /workspace-partial/)
  assert.deepEqual(calls, [])
  assert.equal(sessions.disabled, false, 'a failed purge releases the option again')
})

test('does not mount the option when the shipped title cannot be resolved', async (t) => {
  const workspaces = makeWorkspaceService({ items: [], original: async () => {} })
  const unresolved = (ns, key) => (ns === 'workspace' ? key : (DICT[key] ?? key))
  const harness = loadClient(unresolved)
  restoreGlobals(t)
  harness.module.apply(makeContext({ translateSeat: unresolved, workspaces }))

  const frame = openDialog(harness)

  assert.equal(frame.body.children.length, 0)
})

test('drops the option when the dialog closes', async (t) => {
  const workspaces = makeWorkspaceService({ items: [], original: async () => {} })
  const harness = loadClient(translate)
  restoreGlobals(t)
  harness.module.apply(makeContext({ translateSeat: translate, workspaces }))
  const frame = openDialog(harness)
  assert.equal(frame.body.children.length, 1)

  frame.root.remove()
  harness.fire([{ addedNodes: [], removedNodes: [frame.root] }])

  assert.equal(frame.body.children.length, 0)
})
