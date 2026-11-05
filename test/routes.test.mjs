/**
 * Route contract tests for both Fetch endpoints.
 *
 * `apply` is driven with a fake Host context, so these tests pin the wire
 * contract the browser depends on: both paths are registered on the
 * authenticated `connection.fetch` carrier, the workspace route refuses a body
 * without `deleteSessions: true`, and every refusal keeps its HTTP status.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

const WORKSPACE_ID = '11111111-2222-3333-4444-555555555555'

/** A Host context whose `inject` resolves immediately and records routes. */
function routedContext({ persistence, registry, failWorkspaceRoute = false } = {}) {
  const routes = []
  const services = new Map([
    ['sessionPersistence', persistence],
    ['workspaceRegistry', registry],
  ])
  const scope = {
    get: (name) => services.get(name),
    emit: () => {},
    effect: (callback) => {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : undefined
    },
    connection: {
      fetch: {
        register: (route) => {
          if (failWorkspaceRoute && route.path === '/api/workspace.purge-sessions') throw new Error('route taken')
          routes.push(route)
          return () => {}
        },
      },
    },
  }
  const ctx = {
    get: scope.get,
    emit: scope.emit,
    inject: (deps, callback) => {
      if (deps.includes('sessionPersistence') && deps.includes('connection')) callback(scope)
    },
  }
  return { ctx, routes }
}

/** One persistence stand-in with no Sessions. */
function emptyPersistence() {
  return {
    async list() {
      return []
    },
  }
}

/** A workspace registry stand-in over a fixed record list. */
function registryWith(workspaces) {
  const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]))
  return {
    get: (id) => byId.get(id),
    list: () => [...byId.values()],
    delete: async (id) => byId.delete(id),
  }
}

function request(body) {
  return {
    async json() {
      if (body === undefined) throw new Error('no body')
      return body
    },
  }
}

test('registers both authenticated Fetch routes', () => {
  const { ctx, routes } = routedContext({ persistence: emptyPersistence() })

  apply(ctx)

  assert.deepEqual(routes.map((route) => route.path), ['/api/session.delete', '/api/workspace.purge-sessions'])
  for (const route of routes) {
    assert.deepEqual(route.methods, ['POST'])
    assert.equal(route.requestBody, 'buffered')
  }
})

test('keeps the Session route when the workspace route cannot be registered', async () => {
  const { ctx, routes } = routedContext({
    persistence: emptyPersistence(),
    registry: registryWith([]),
    failWorkspaceRoute: true,
  })

  assert.doesNotThrow(() => apply(ctx))
  assert.deepEqual(routes.map((route) => route.path), ['/api/session.delete'])

  const response = await routes[0].fetch(request({ sessionId: 'session-missing' }))
  assert.equal(response.status, 404, 'the original route still answers')
})

test('refuses a workspace purge without the explicit deleteSessions flag', async () => {
  const { ctx, routes } = routedContext({
    persistence: emptyPersistence(),
    registry: registryWith([]),
  })
  apply(ctx)

  const response = await routes[1].fetch(request({ workspaceId: WORKSPACE_ID }))

  assert.equal(response.status, 400)
  assert.equal((await response.json()).code, 'workspace-invalid-request')
})

test('answers 400 for a malformed workspace id', async () => {
  const { ctx, routes } = routedContext({ persistence: emptyPersistence(), registry: registryWith([]) })
  apply(ctx)

  const response = await routes[1].fetch(request({ workspaceId: '../escape', deleteSessions: true }))

  assert.equal(response.status, 400)
  assert.equal((await response.json()).code, 'workspace-invalid-id')
})

test('answers 404 for an unknown workspace', async () => {
  const { ctx, routes } = routedContext({
    persistence: emptyPersistence(),
    registry: registryWith([
      {
        id: '99999999-8888-7777-6666-555555555555',
        title: 'other',
        path: 'C:/other',
        sessionIds: [],
      },
    ]),
  })
  apply(ctx)

  const response = await routes[1].fetch(request({ workspaceId: WORKSPACE_ID, deleteSessions: true }))

  assert.equal(response.status, 404)
  assert.equal((await response.json()).code, 'workspace-not-found')
})

test('answers 200 with the session report for a valid purge', async () => {
  const { ctx, routes } = routedContext({
    persistence: emptyPersistence(),
    registry: registryWith([
      { id: WORKSPACE_ID, title: 'demo', path: 'C:/demo', sessionIds: [] },
    ]),
  })
  apply(ctx)

  const response = await routes[1].fetch(request({ workspaceId: WORKSPACE_ID, deleteSessions: true }))
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.sessions.total, 0)
  assert.deepEqual(body.sessions.deleted, [])
})
