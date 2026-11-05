/**
 * Workspace cascade tests.
 *
 * `purgeWorkspaceSessions` is driven directly, like the single-Session tests:
 * a temporary DSH home supplies the Session directories and attachment objects,
 * and fake Workspace-registry / Session-persistence services stand in for the
 * Host seams. The registry is a stub because the shipped one is a storage-backed
 * service whose only relevant surface here is `get(id)` plus the record shape.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { purgeWorkspaceSessions } from '../index.js'

const DIGEST_A = 'a'.repeat(64)
const DIGEST_B = 'b'.repeat(64)
const WORKSPACE_ID = '11111111-2222-3333-4444-555555555555'
const OTHER_WORKSPACE_ID = '99999999-8888-7777-6666-555555555555'

/** A fresh DSH home; the purge resolves every root from this variable. */
async function makeHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-workspace-purge-'))
  process.env.DSH_HOME = home
  t.after(async () => {
    await rm(home, { recursive: true, force: true })
  })
  return home
}

/** One stored Session directory under `<home>/sessions/<project>/<id>`. */
async function addSessionDirectory(home, id, project = '--work--') {
  const directory = join(home, 'sessions', project, id)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'session.v4.jsonl.zstd'), '')
  return directory
}

function header(id, extra = {}) {
  return { id, version: 4, createdAt: 1, cwd: 'C:/work', ...extra }
}

function headerEvent() {
  return { seq: 0, type: 'session/header', data: {} }
}

function imageEvent(seq, digest) {
  return {
    seq,
    type: 'message',
    data: {
      message: {
        role: 'user',
        content: [{ type: 'image', attachment: { attachmentId: `sha256:${digest}`, mediaType: 'image/png', bytes: 3, width: 1, height: 1 } }],
      },
    },
  }
}

/** Minimal `sessionPersistence` stand-in: listing, reading, and failure switches. */
function persistenceOf(sessions) {
  const byId = new Map(sessions.map((session) => [session.header.id, session]))
  return {
    async list() {
      return [...byId.values()].map((session) => ({
        header: session.header,
        revision: `rev-${session.header.id}`,
        eventCount: session.events.length,
        sizeBytes: 16,
      }))
    },
    async open(id, access) {
      const session = byId.get(id)
      if (session === undefined) throw new Error(`missing session ${id}`)
      if (session.unreadable === true) throw new Error(`unreadable session ${id}`)
      return {
        id,
        header: session.header,
        access,
        inheritedEventCount: 0,
        async read(offset = 0, length = Number.MAX_SAFE_INTEGER) {
          return { events: session.events.filter((event) => event.seq >= offset).slice(0, length), eventState: 'shared-frozen' }
        },
        async append() {},
        async flush() {},
        async close() {},
      }
    },
  }
}

/** The Workspace registry seam: `get(id)` over a fixed record list. */
function registryOf(workspaces) {
  const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]))
  return {
    get: (id) => byId.get(id),
    list: () => [...byId.values()],
    delete: async (id) => byId.delete(id),
  }
}

function workspaceOf(id, sessionIds, title = 'dsh-session-delete') {
  return { id, title, path: 'C:/work', sessionIds, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
}

function ctxWith({ persistence, registry, agents, sessions, jobs, emitted = [] }) {
  const services = new Map([
    ['sessionPersistence', persistence],
    ['workspaceRegistry', registry],
    ['agents', agents],
    ['sessions', sessions],
    ['jobs', jobs],
  ])
  return {
    emitted,
    get(name) {
      return services.get(name)
    },
    emit(name, ...args) {
      emitted.push([name, ...args])
    },
  }
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function addImageObject(home, digest, contents = 'png-bytes') {
  const directory = join(home, 'attachments', 'v1', 'objects', digest.slice(0, 2))
  await mkdir(directory, { recursive: true })
  const path = join(directory, digest)
  await writeFile(path, contents)
  return path
}

test('purges every Session the workspace owns and leaves the others', async (t) => {
  const home = await makeHome(t)
  const a = await addSessionDirectory(home, 'session-a')
  const b = await addSessionDirectory(home, 'session-b')
  const outside = await addSessionDirectory(home, 'session-c')
  const emitted = []
  const ctx = ctxWith({
    persistence: persistenceOf([
      { header: header('session-a'), events: [headerEvent()] },
      { header: header('session-b'), events: [headerEvent()] },
      { header: header('session-c'), events: [headerEvent()] },
    ]),
    registry: registryOf([workspaceOf(WORKSPACE_ID, ['session-a', 'session-b'])]),
    emitted,
  })

  const result = await purgeWorkspaceSessions(ctx, WORKSPACE_ID)

  assert.equal(result.ok, true)
  assert.equal(result.workspaceId, WORKSPACE_ID)
  assert.equal(result.sessions.total, 2)
  assert.deepEqual(result.sessions.rootsDeleted, ['session-a', 'session-b'])
  assert.deepEqual(result.sessions.skipped, [])
  assert.equal(await exists(a), false)
  assert.equal(await exists(b), false)
  assert.equal(await exists(outside), true)
  assert.deepEqual(emitted, [['api-session/removed', 'session-a'], ['api-session/removed', 'session-b']])
})

test('deletes the subagent tree a workspace Session owns', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  const child = await addSessionDirectory(home, 'session-child')
  const ctx = ctxWith({
    persistence: persistenceOf([
      { header: header('session-a'), events: [headerEvent()] },
      { header: header('session-child', { origin: 'subagent', parentSession: 'session-a' }), events: [headerEvent()] },
      { header: header('session-c'), events: [headerEvent()] },
    ]),
    registry: registryOf([workspaceOf(WORKSPACE_ID, ['session-a'])]),
  })

  const result = await purgeWorkspaceSessions(ctx, WORKSPACE_ID)

  assert.equal(result.ok, true)
  assert.deepEqual(result.sessions.deleted, ['session-a', 'session-child'])
  assert.deepEqual(result.sessions.rootsDeleted, ['session-a'])
  assert.equal(result.sessions.descendantsDeleted, 1)
  assert.equal(await exists(child), false)
})

test('skips a live Session and still purges the rest of the workspace', async (t) => {
  const home = await makeHome(t)
  const a = await addSessionDirectory(home, 'session-a')
  const b = await addSessionDirectory(home, 'session-b')
  const ctx = ctxWith({
    persistence: persistenceOf([
      { header: header('session-a'), events: [headerEvent()] },
      { header: header('session-b'), events: [headerEvent()] },
    ]),
    registry: registryOf([workspaceOf(WORKSPACE_ID, ['session-a', 'session-b'])]),
    agents: { get: (id) => (id === 'session-b' ? { id } : undefined) },
  })

  const result = await purgeWorkspaceSessions(ctx, WORKSPACE_ID)

  assert.equal(result.ok, true)
  assert.deepEqual(result.sessions.rootsDeleted, ['session-a'])
  assert.deepEqual(result.sessions.skipped, [{ sessionId: 'session-b', reason: 'agent', liveSessionId: 'session-b' }])
  assert.equal(await exists(a), false)
  assert.equal(await exists(b), true)
})

test('skips a whole tree when one of its subagents is live', async (t) => {
  const home = await makeHome(t)
  const parent = await addSessionDirectory(home, 'session-a')
  await addSessionDirectory(home, 'session-child')
  const b = await addSessionDirectory(home, 'session-b')
  const ctx = ctxWith({
    persistence: persistenceOf([
      { header: header('session-a'), events: [headerEvent()] },
      { header: header('session-child', { origin: 'subagent', parentSession: 'session-a' }), events: [headerEvent()] },
      { header: header('session-b'), events: [headerEvent()] },
    ]),
    registry: registryOf([workspaceOf(WORKSPACE_ID, ['session-a', 'session-b'])]),
    sessions: { get: (id) => (id === 'session-child' ? { id } : undefined) },
  })

  const result = await purgeWorkspaceSessions(ctx, WORKSPACE_ID)

  assert.equal(result.ok, true)
  assert.deepEqual(result.sessions.rootsDeleted, ['session-b'])
  assert.deepEqual(result.sessions.skipped, [{ sessionId: 'session-a', reason: 'session', liveSessionId: 'session-child' }])
  assert.equal(await exists(parent), true)
  assert.equal(await exists(b), false)
})

test('reports a directory that is already gone without failing the purge', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  const ctx = ctxWith({
    persistence: persistenceOf([
      { header: header('session-a'), events: [headerEvent()] },
      { header: header('session-gone'), events: [headerEvent()] },
    ]),
    registry: registryOf([workspaceOf(WORKSPACE_ID, ['session-a', 'session-gone'])]),
  })

  const result = await purgeWorkspaceSessions(ctx, WORKSPACE_ID)

  assert.equal(result.ok, true)
  assert.deepEqual(result.sessions.deleted, ['session-a'])
  assert.deepEqual(result.sessions.missing, [{ sessionId: 'session-gone' }])
  assert.deepEqual(result.sessions.rootsDeleted, ['session-a'])
})

test('still removes a Session directory the catalog no longer lists', async (t) => {
  const home = await makeHome(t)
  const ghost = await addSessionDirectory(home, 'session-ghost')
  const ctx = ctxWith({
    persistence: persistenceOf([]),
    registry: registryOf([workspaceOf(WORKSPACE_ID, ['session-ghost'])]),
  })

  const result = await purgeWorkspaceSessions(ctx, WORKSPACE_ID)

  assert.equal(result.ok, true)
  assert.deepEqual(result.sessions.deleted, ['session-ghost'])
  assert.equal(await exists(ghost), false)
})

test('refuses an unknown Workspace without touching any directory', async (t) => {
  const home = await makeHome(t)
  const a = await addSessionDirectory(home, 'session-a')
  const ctx = ctxWith({
    persistence: persistenceOf([{ header: header('session-a'), events: [headerEvent()] }]),
    registry: registryOf([workspaceOf(OTHER_WORKSPACE_ID, ['session-a'])]),
  })

  const result = await purgeWorkspaceSessions(ctx, WORKSPACE_ID)

  assert.equal(result.ok, false)
  assert.equal(result.code, 'workspace-not-found')
  assert.equal(result.message, 'No Workspace registration has that id.')
  assert.equal(await exists(a), true)
})

test('refuses a malformed workspace id', async () => {
  const ctx = ctxWith({ persistence: persistenceOf([]), registry: registryOf([]) })
  const result = await purgeWorkspaceSessions(ctx, '../../etc')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'workspace-invalid-id')
})

test('refuses when the Workspace registry is not mounted', async () => {
  const ctx = ctxWith({ persistence: persistenceOf([]), registry: undefined })
  const result = await purgeWorkspaceSessions(ctx, WORKSPACE_ID)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'workspace-unavailable')
})

test('deletes an attachment only the purged workspace referenced', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  const outside = await addSessionDirectory(home, 'session-c')
  const image = await addImageObject(home, DIGEST_A)
  const ctx = ctxWith({
    persistence: persistenceOf([
      { header: header('session-a'), events: [headerEvent(), imageEvent(1, DIGEST_A)] },
      { header: header('session-c'), events: [headerEvent()] },
    ]),
    registry: registryOf([workspaceOf(WORKSPACE_ID, ['session-a'])]),
  })

  const result = await purgeWorkspaceSessions(ctx, WORKSPACE_ID, { deleteAttachments: true })

  assert.equal(result.ok, true)
  assert.deepEqual(result.attachments, { status: 'applied', deleted: 1, kept: 0, failed: 0, missing: 0, bytes: 9 })
  assert.equal(await exists(image), false)
  assert.equal(await exists(outside), true)
})

test('keeps an object a Session outside the workspace still references', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  await addSessionDirectory(home, 'session-c')
  const image = await addImageObject(home, DIGEST_A)
  const ctx = ctxWith({
    persistence: persistenceOf([
      { header: header('session-a'), events: [headerEvent(), imageEvent(1, DIGEST_A)] },
      { header: header('session-c'), events: [headerEvent(), imageEvent(1, DIGEST_A)] },
    ]),
    registry: registryOf([workspaceOf(WORKSPACE_ID, ['session-a'])]),
  })

  const result = await purgeWorkspaceSessions(ctx, WORKSPACE_ID, { deleteAttachments: true })

  assert.equal(result.ok, true)
  assert.deepEqual(result.attachments, { status: 'applied', deleted: 0, kept: 1, failed: 0, missing: 0, bytes: 0 })
  assert.equal(await exists(image), true)
})

test('keeps a skipped live Session as a reference source for attachments', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  await addSessionDirectory(home, 'session-b')
  const image = await addImageObject(home, DIGEST_A)
  const ctx = ctxWith({
    persistence: persistenceOf([
      { header: header('session-a'), events: [headerEvent(), imageEvent(1, DIGEST_A)] },
      { header: header('session-b'), events: [headerEvent(), imageEvent(1, DIGEST_A)] },
    ]),
    registry: registryOf([workspaceOf(WORKSPACE_ID, ['session-a', 'session-b'])]),
    agents: { get: (id) => (id === 'session-b' ? { id } : undefined) },
  })

  const result = await purgeWorkspaceSessions(ctx, WORKSPACE_ID, { deleteAttachments: true })

  assert.equal(result.ok, true)
  assert.deepEqual(result.sessions.skipped, [{ sessionId: 'session-b', reason: 'agent', liveSessionId: 'session-b' }])
  assert.deepEqual(result.attachments, { status: 'applied', deleted: 0, kept: 1, failed: 0, missing: 0, bytes: 0 })
  assert.equal(await exists(image), true)
})

test('keeps every object when a purged Session log cannot be read', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  const image = await addImageObject(home, DIGEST_B)
  const ctx = ctxWith({
    persistence: persistenceOf([
      { header: header('session-a'), events: [headerEvent(), imageEvent(1, DIGEST_B)], unreadable: true },
    ]),
    registry: registryOf([workspaceOf(WORKSPACE_ID, ['session-a'])]),
  })

  const result = await purgeWorkspaceSessions(ctx, WORKSPACE_ID, { deleteAttachments: true })

  assert.equal(result.ok, true)
  assert.equal(result.attachments.status, 'unverified')
  assert.equal(await exists(image), true)
})

test('treats an empty workspace as a successful no-op', async () => {
  const ctx = ctxWith({
    persistence: persistenceOf([]),
    registry: registryOf([workspaceOf(WORKSPACE_ID, [])]),
  })

  const result = await purgeWorkspaceSessions(ctx, WORKSPACE_ID)

  assert.equal(result.ok, true)
  assert.equal(result.sessions.total, 0)
  assert.deepEqual(result.sessions.deleted, [])
})
