/**
 * Client-half tests for the error path and permission gate.
 *
 * The browser half is a module-loader factory, not an importable ES module.
 * This harness evaluates it with minimal React, DOM, and ui-primitives stubs,
 * then drives the registered context-menu contribution and overlay component
 * through the same public seams the Web shell uses.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const SOURCE = await readFile(new URL('../client.js', import.meta.url), 'utf8')

/** Evaluate the bundle once and return its registration. */
function loadClient() {
  let registration
  const window = {
    __ModuleLoader__: {
      load(value) {
        registration = value
      },
    },
  }
  const document = {
    createElement() {
      return { dataset: {}, textContent: '', remove() {} }
    },
    head: { appendChild() {} },
  }
  const context = vm.createContext({
    window,
    document,
    console,
    setTimeout,
    clearTimeout,
    AbortController,
    fetch: async () => {
      throw new Error('fetch was not configured')
    },
    JSON,
    String,
    Number,
    Array,
    Object,
    Promise,
    Error,
  })
  vm.runInContext(SOURCE, context, { filename: 'client.js' })
  assert.equal(registration?.id, '@acomma/dsh-session-delete')
  return { registration, context }
}

/** Minimal React.createElement tree used for inspection. */
function createElement(type, props, ...children) {
  const next = props === null || props === undefined ? {} : { ...props }
  next.children = children
  return { type, props: next }
}

/** Render text from an element tree. */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node.props !== 'object' || node.props === null) return ''
  return textOf(node.props.children)
}

/** Visit every element in a tree. */
function elementsOf(node, output = []) {
  if (node === null || node === undefined || typeof node === 'string' || typeof node === 'number') return output
  if (Array.isArray(node)) {
    for (const child of node) elementsOf(child, output)
    return output
  }
  if (typeof node === 'object' && 'props' in node) {
    output.push(node)
    elementsOf(node.props.children, output)
    elementsOf(node.props.footer, output)
  }
  return output
}

/** Build one fake React/primitive/client-context environment. */
function makeHarness() {
  const React = {
    Fragment: Symbol('Fragment'),
    createElement,
    useSyncExternalStore(_subscribe, snapshot) {
      return snapshot()
    },
  }
  const Button = function Button() {}
  const Modal = function Modal() {}
  const IconTrashOutlineRegular = function IconTrashOutlineRegular() {}
  let translateCatalog = new Map()
  let allow = true
  let menu
  const slots = new Map()
  const dictionaries = []
  const makeTranslate = (ns) => (key, params) => {
    const template = translateCatalog.get(`${ns}:${key}`) ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match)
  }
  const ctx = {
    get(name) {
      if (name === 'remoteAccess') return ctx.remoteAccess
      return undefined
    },
    effect(callback) {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: {
      register(ns, dicts) {
        dictionaries.push([ns, dicts])
        for (const [locale, dictionary] of Object.entries(dicts)) {
          for (const [key, value] of Object.entries(dictionary)) translateCatalog.set(`${locale}:${key}`, value)
        }
        return () => {}
      },
      bind: makeTranslate,
    },
    slots: {
      inject(_name, callback) {
        return callback()
      },
      register(options, component) {
        slots.set(`${options.name}:${options.id ?? options.key}`, { options, component })
        return () => {}
      },
    },
    contextMenus: {
      register(contribution) {
        menu = contribution
        return () => {}
      },
    },
    remoteAccess: {
      source: (_kind, _id, _action) => ({ getSnapshot: () => allow }),
    },
  }
  return {
    ctx,
    Button,
    Modal,
    IconTrashOutlineRegular,
    slots,
    get menu() { return menu },
    dictionaries,
    get translateCatalog() { return translateCatalog },
    setTranslateCatalog(value) {
      translateCatalog = value
      ctx.locale.bind = makeTranslate
    },
    setAllow(value) { allow = value },
  }
}

/** Return a translator for one namespace from registered dictionaries. */
function translatorFor(harness, ns, locale = 'en') {
  const entry = harness.dictionaries.find(([name]) => name === ns)
  assert.ok(entry, `missing dictionary for ${ns}`)
  const dictionary = entry[1][locale]
  assert.ok(dictionary, `missing ${locale} dictionary for ${ns}`)
  return (key, params) => {
    const template = dictionary[key] ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match)
  }
}

/** Load and apply the client bundle against one harness. */
function applyClient(harness) {
  const { registration, context } = loadClient()
  const client = registration.factory((specifier) => {
    if (specifier === 'react') {
      return {
        createElement,
        Fragment: Symbol('Fragment'),
        useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
      }
    }
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') {
      return {
        Button: harness.Button,
        Modal: harness.Modal,
        IconTrashOutlineRegular: harness.IconTrashOutlineRegular,
      }
    }
    throw new Error(`unexpected require ${specifier}`)
  })
  client.apply(harness.ctx)
  return { client, context }
}

/** Resolve the registered dialog component for one open confirmation. */
function renderDialog(harness, t) {
  const entry = harness.slots.get('shell.overlay:session-delete.dialog')
  assert.ok(entry, 'missing overlay dialog registration')
  return entry.component({ t })
}

/** Find the Delete button in a rendered dialog tree. */
function confirmButton(tree, Button, t) {
  const expected = t('dialog.confirm')
  return elementsOf(tree).find((element) => element.type === Button && textOf(element) === expected)
}

/** Return a Request-shaped Response stub. */
function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body },
  }
}

test('preserves the Host live reason so a running job gets the job message', async () => {
  const harness = makeHarness()
  const { registration, context } = loadClient()
  const client = registration.factory((specifier) => {
    if (specifier === 'react') {
      return {
        createElement,
        Fragment: Symbol('Fragment'),
        useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
      }
    }
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') {
      return {
        Button: harness.Button,
        Modal: harness.Modal,
        IconTrashOutlineRegular: harness.IconTrashOutlineRegular,
      }
    }
    throw new Error(`unexpected require ${specifier}`)
  })
  client.apply(harness.ctx)

  const action = harness.menu.resolve({ sessionId: 'session-a', displayTitle: 'A' })[0]
  assert.ok(action)
  await action.run()
  const t = translatorFor(harness, 'session-delete')
  context.fetch = async () => response({ ok: false, code: 'live', reason: 'job', message: 'host message' }, 409)
  const tree = renderDialog(harness, t)
  const confirm = confirmButton(tree, harness.Button, t)
  assert.ok(confirm, 'missing confirm button')
  await confirm.props.onClick()

  const next = renderDialog(harness, t)
  assert.match(textOf(next), /running background jobs/)
})

test('maps list-failed to a localized message instead of the raw Host message', async () => {
  const harness = makeHarness()
  const { registration, context } = loadClient()
  const client = registration.factory((specifier) => {
    if (specifier === 'react') {
      return {
        createElement,
        Fragment: Symbol('Fragment'),
        useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
      }
    }
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') {
      return {
        Button: harness.Button,
        Modal: harness.Modal,
        IconTrashOutlineRegular: harness.IconTrashOutlineRegular,
      }
    }
    throw new Error(`unexpected require ${specifier}`)
  })
  client.apply(harness.ctx)
  const action = harness.menu.resolve({ sessionId: 'session-a', displayTitle: 'A' })[0]
  await action.run()
  const t = translatorFor(harness, 'session-delete')
  context.fetch = async () => response({ ok: false, code: 'list-failed', message: 'host message' }, 500)
  const tree = renderDialog(harness, t)
  await confirmButton(tree, harness.Button, t).props.onClick()
  assert.match(textOf(renderDialog(harness, t)), /stored session list could not be read/)
  assert.doesNotMatch(textOf(renderDialog(harness, t)), /host message/)
})

test('hides the delete action when the current peer lacks the delete resource action', async () => {
  const harness = makeHarness()
  const { registration, context } = loadClient()
  const client = registration.factory((specifier) => {
    if (specifier === 'react') {
      return {
        createElement,
        Fragment: Symbol('Fragment'),
        useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
      }
    }
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') {
      return {
        Button: harness.Button,
        Modal: harness.Modal,
        IconTrashOutlineRegular: harness.IconTrashOutlineRegular,
      }
    }
    throw new Error(`unexpected require ${specifier}`)
  })
  client.apply(harness.ctx)
  harness.setAllow(false)
  assert.equal(harness.menu.resolve({ sessionId: 'session-a', displayTitle: 'A' }).length, 0)
  harness.setAllow(true)
  assert.equal(harness.menu.resolve({ sessionId: 'session-a', displayTitle: 'A' }).length, 1)
})

test('describes that ordinary forks are not deleted', async () => {
  const harness = makeHarness()
  const { registration, context } = loadClient()
  const client = registration.factory((specifier) => {
    if (specifier === 'react') {
      return {
        createElement,
        Fragment: Symbol('Fragment'),
        useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
      }
    }
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') {
      return {
        Button: harness.Button,
        Modal: harness.Modal,
        IconTrashOutlineRegular: harness.IconTrashOutlineRegular,
      }
    }
    throw new Error(`unexpected require ${specifier}`)
  })
  client.apply(harness.ctx)
  const action = harness.menu.resolve({ sessionId: 'session-a', displayTitle: 'A' })[0]
  await action.run()
  const t = translatorFor(harness, 'session-delete')
  const tree = renderDialog(harness, t)
  const modal = elementsOf(tree).find((element) => element.type === harness.Modal)
  assert.ok(modal)
  assert.match(modal.props.description, /Forked sessions are not deleted/)
})

test('reports a timeout when the response body outlives the request budget', async () => {
  const harness = makeHarness()
  const { context } = applyClient(harness)
  const action = harness.menu.resolve({ sessionId: 'session-a', displayTitle: 'A' })[0]
  await action.run()
  const t = translatorFor(harness, 'session-delete')
  const outerSetTimeout = setTimeout
  // The abort fires after fetch resolves but while response.json() is pending.
  context.setTimeout = (callback, _milliseconds) => outerSetTimeout(callback, 1)
  context.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      await new Promise((_resolve, reject) => outerSetTimeout(() => reject(new Error('body aborted')), 25))
    },
  })

  await confirmButton(renderDialog(harness, t), harness.Button, t).props.onClick()

  assert.match(textOf(renderDialog(harness, t)), /timed out/)
})

test('warns when reminders were removed before a later failure', async () => {
  const harness = makeHarness()
  const { context } = applyClient(harness)
  const action = harness.menu.resolve({ sessionId: 'session-a', displayTitle: 'A' })[0]
  await action.run()
  const t = translatorFor(harness, 'session-delete')
  context.fetch = async () => response({
    ok: false,
    code: 'live',
    reason: 'agent',
    schedules: 2,
    message: 'host message',
  }, 409)
  await confirmButton(renderDialog(harness, t), harness.Button, t).props.onClick()
  assert.match(textOf(renderDialog(harness, t)), /Removed 2 reminders/)
})

test('registers identical English and Chinese dictionary key sets', () => {
  const harness = makeHarness()
  applyClient(harness)
  const entry = harness.dictionaries.find(([name]) => name === 'session-delete')
  assert.ok(entry)
  const [en, zh] = [entry[1].en, entry[1].zh]
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())
})

test('maps the subagent-session refusal to its localized message', async () => {
  const harness = makeHarness()
  const { context } = applyClient(harness)
  const action = harness.menu.resolve({ sessionId: 'session-a', displayTitle: 'A' })[0]
  await action.run()
  const t = translatorFor(harness, 'session-delete')
  context.fetch = async () => response({ ok: false, code: 'subagent-session', message: 'host message' }, 409)
  await confirmButton(renderDialog(harness, t), harness.Button, t).props.onClick()
  assert.match(textOf(renderDialog(harness, t)), /subagent sub-session cannot be deleted/)
})

test('maps tree-incomplete to its localized message', async () => {
  const harness = makeHarness()
  const { context } = applyClient(harness)
  const action = harness.menu.resolve({ sessionId: 'session-a', displayTitle: 'A' })[0]
  await action.run()
  const t = translatorFor(harness, 'session-delete')
  context.fetch = async () => response({ ok: false, code: 'tree-incomplete', message: 'host message' }, 409)
  await confirmButton(renderDialog(harness, t), harness.Button, t).props.onClick()
  assert.match(textOf(renderDialog(harness, t)), /session tree is incomplete/)
})
