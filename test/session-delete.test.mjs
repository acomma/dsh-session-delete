/**
 * Reference-counting tests for the attachment cleanup option.
 *
 * The Host half is plain ESM with no Harness import at module scope, so these
 * tests drive `deleteSession` directly: a temporary DSH home supplies the
 * Session directories and attachment objects, and a fake Session-persistence
 * service supplies the event logs. Session logs on a real machine are
 * compressed and read through that same seam, which is why the fake service is
 * the right seam to stand in for.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { deleteSession } from '../index.js'

const DIGEST_A = 'a'.repeat(64)
const DIGEST_B = 'b'.repeat(64)
const DIGEST_C = 'c'.repeat(64)
const DIGEST_D = 'd'.repeat(64)

/** A fresh DSH home; `deleteSession` resolves the roots from this variable. */
async function makeHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-session-delete-'))
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
  await writeFile(join(directory, 'session.v3.jsonl'), '{}\n')
  return directory
}

function snapshot(id) {
  return { header: { id, version: 3, createdAt: 1, cwd: '/work' }, revision: `rev-${id}`, sizeBytes: 16 }
}

/** Encode one Session id the way the JSONL backend names its directory. */
function encodeSessionId(raw) {
  let encoded = ''
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index)
    const character = String.fromCharCode(code)
    encoded += character !== '~' && /^[A-Za-z0-9._-]$/u.test(character)
      ? character
      : `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return encoded
}

/** The local spill backend's stable per-Session directory name. */
function spillKey(id) {
  return `session-${createHash('sha256').update(id).digest('hex').slice(0, 12)}`
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

function fileEvent(seq, digest, name) {
  return {
    seq,
    type: 'message',
    data: {
      message: {
        role: 'user',
        content: [{ type: 'file', attachment: { attachmentId: `sha256:${digest}`, name, bytes: 3 } }],
      },
    },
  }
}

function headerEvent() {
  return { seq: 0, type: 'session/header', data: {} }
}

/** Minimal `sessionPersistence` stand-in: listing, reading, and failure switches. */
function persistenceOf(sessions) {
  const byId = new Map(sessions.map((session) => [session.header.id, session]))
  return {
    name: 'session-persistence-jsonl',
    root: process.env.DSH_HOME === undefined ? undefined : join(process.env.DSH_HOME, 'sessions'),
    hasPendingSession() {
      return false
    },
    async list() {
      return [...byId.values()].map((session) => ({
        header: session.header,
        revision: `rev-${session.header.id}`,
        eventCount: session.events.length,
        sizeBytes: 16,
        ...(session.formatStatus === undefined ? {} : { formatStatus: session.formatStatus }),
        ...(session.location === undefined ? {} : { location: session.location }),
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
          if (session.readError === true) throw new Error(`read failed for ${id}`)
          return { events: session.events.filter((event) => event.seq >= offset).slice(0, length), eventState: 'shared-frozen' }
        },
        async append() {},
        async flush() {},
        async close() {},
      }
    },
  }
}

function ctxOf(persistence) {
  return ctxWith(persistence)
}

function ctxWith(persistence, overrides = {}) {
  const emitted = []
  const defaultAttachments = process.env.DSH_HOME === undefined
    ? undefined
    : { root: join(process.env.DSH_HOME, 'attachments', 'v1') }
  const defaultStorage = process.env.DSH_HOME === undefined
    ? undefined
    : { backend: { get: () => ({ root: join(process.env.DSH_HOME, 'storages') }) } }
  return {
    emitted,
    get(name) {
      if (name === 'sessionPersistence') return persistence
      if (name === 'attachments' && !('attachments' in overrides)) return defaultAttachments
      if (name === 'storage' && !('storage' in overrides)) return defaultStorage
      return overrides[name]
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

async function addFileObject(home, digest, name, contents = 'file-bytes') {
  const objectDirectory = join(home, 'attachments', 'v1', 'file-objects', digest.slice(0, 2))
  await mkdir(objectDirectory, { recursive: true })
  const objectPath = join(objectDirectory, digest)
  await writeFile(objectPath, contents)
  const aliasDirectory = join(home, 'attachments', 'v1', 'files', digest.slice(0, 2), digest)
  await mkdir(aliasDirectory, { recursive: true })
  const aliasPath = join(aliasDirectory, name)
  await writeFile(aliasPath, contents)
  return { objectPath, aliasDirectory, aliasPath }
}

test('leaves attachments alone unless the option is true', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  const imagePath = await addImageObject(home, DIGEST_A)
  const ctx = ctxOf(persistenceOf([
    { header: snapshot('session-a').header, events: [headerEvent(), imageEvent(1, DIGEST_A)] },
  ]))

  const result = await deleteSession(ctx, 'session-a')

  assert.equal(result.ok, true)
  assert.equal('attachments' in result, false)
  assert.equal(await exists(imagePath), true)
})

test('deletes an image only the deleted session referenced', async (t) => {
  const home = await makeHome(t)
  const directory = await addSessionDirectory(home, 'session-a')
  const imagePath = await addImageObject(home, DIGEST_A)
  const ctx = ctxOf(persistenceOf([
    { header: snapshot('session-a').header, events: [headerEvent(), imageEvent(1, DIGEST_A)] },
  ]))

  const result = await deleteSession(ctx, 'session-a', { deleteAttachments: true })

  assert.equal(result.ok, true)
  assert.deepEqual(result.attachments, { status: 'applied', deleted: 1, kept: 0, failed: 0, missing: 0, bytes: 9, staging: 0 })
  assert.equal(await exists(directory), false)
  assert.equal(await exists(imagePath), false)
})

test('keeps an image another session still references', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  await addSessionDirectory(home, 'session-b')
  const imagePath = await addImageObject(home, DIGEST_A)
  const ctx = ctxOf(persistenceOf([
    { header: snapshot('session-a').header, events: [headerEvent(), imageEvent(1, DIGEST_A)] },
    { header: snapshot('session-b').header, events: [headerEvent(), imageEvent(1, DIGEST_A)] },
  ]))

  const result = await deleteSession(ctx, 'session-a', { deleteAttachments: true })

  assert.equal(result.ok, true)
  assert.equal(result.attachments.deleted, 0)
  assert.equal(result.attachments.kept, 1)
  assert.equal(await exists(imagePath), true)
})

test('deletes a file object together with its alias directory', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  const paths = await addFileObject(home, DIGEST_B, 'report.txt')
  const ctx = ctxOf(persistenceOf([
    { header: snapshot('session-a').header, events: [headerEvent(), fileEvent(1, DIGEST_B, 'report.txt')] },
  ]))

  const result = await deleteSession(ctx, 'session-a', { deleteAttachments: true })

  assert.equal(result.attachments.deleted, 1)
  assert.equal(result.attachments.bytes, 10)
  assert.equal(await exists(paths.objectPath), false)
  assert.equal(await exists(paths.aliasDirectory), false)
})

test('deletes the read-only objects and aliases the store publishes', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  const paths = await addFileObject(home, DIGEST_B, 'report.txt')
  // The local store publishes every object and alias with mode 0o400.
  await chmod(paths.objectPath, 0o400)
  await chmod(paths.aliasPath, 0o400)
  const ctx = ctxOf(persistenceOf([
    { header: snapshot('session-a').header, events: [headerEvent(), fileEvent(1, DIGEST_B, 'report.txt')] },
  ]))

  const result = await deleteSession(ctx, 'session-a', { deleteAttachments: true })

  assert.equal(result.attachments.deleted, 1)
  assert.equal(await exists(paths.objectPath), false)
  assert.equal(await exists(paths.aliasDirectory), false)
})

test('keeps a file whose digest another session references under another name', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  await addSessionDirectory(home, 'session-b')
  const paths = await addFileObject(home, DIGEST_C, 'first.txt')
  const ctx = ctxOf(persistenceOf([
    { header: snapshot('session-a').header, events: [headerEvent(), fileEvent(1, DIGEST_C, 'first.txt')] },
    { header: snapshot('session-b').header, events: [headerEvent(), fileEvent(1, DIGEST_C, 'second.txt')] },
  ]))

  const result = await deleteSession(ctx, 'session-a', { deleteAttachments: true })

  assert.equal(result.attachments.kept, 1)
  assert.equal(result.attachments.deleted, 0)
  assert.equal(await exists(paths.objectPath), true)
  assert.equal(await exists(paths.aliasDirectory), true)
})

test('keeps every object when a surviving session cannot be read', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  await addSessionDirectory(home, 'session-b')
  const imagePath = await addImageObject(home, DIGEST_A)
  const ctx = ctxOf(persistenceOf([
    { header: snapshot('session-a').header, events: [headerEvent(), imageEvent(1, DIGEST_A)] },
    { header: snapshot('session-b').header, events: [headerEvent()], unreadable: true },
  ]))

  const result = await deleteSession(ctx, 'session-a', { deleteAttachments: true })

  assert.equal(result.ok, true)
  assert.equal(result.attachments.status, 'unverified')
  assert.equal(result.attachments.reason, 'unreadable')
  assert.equal(result.attachments.deleted, 0)
  assert.equal(await exists(imagePath), true)
})

test('keeps every object when another process still writes a surviving session', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  const survivor = await addSessionDirectory(home, 'session-b')
  const imagePath = await addImageObject(home, DIGEST_A)
  const persistence = persistenceOf([
    { header: snapshot('session-a').header, events: [headerEvent(), imageEvent(1, DIGEST_A)] },
    {
      header: snapshot('session-b').header,
      events: [headerEvent()],
      formatStatus: 'current',
      location: { kind: 'jsonl', path: join(survivor, 'session.v4.jsonl') },
    },
  ])
  const open = persistence.open
  persistence.open = async (id, access, options) => {
    if (id === 'session-b' && access === 'write') {
      const error = new Error('held by another process')
      error.name = 'SessionAlreadyOwnedError'
      throw error
    }
    return open(id, access, options)
  }
  const ctx = ctxOf(persistence)

  const result = await deleteSession(ctx, 'session-a', { deleteAttachments: true })

  assert.equal(result.ok, true)
  assert.equal(result.attachments.status, 'unverified')
  assert.equal(result.attachments.reason, 'writer')
  assert.equal(await exists(imagePath), true)
})

test('keeps every object when a surviving migration-required log cannot be lease-probed', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  const survivor = await addSessionDirectory(home, 'session-b')
  const imagePath = await addImageObject(home, DIGEST_A)
  const ctx = ctxOf(persistenceOf([
    { header: snapshot('session-a').header, events: [headerEvent(), imageEvent(1, DIGEST_A)] },
    {
      header: snapshot('session-b').header,
      events: [headerEvent()],
      formatStatus: 'migration-required',
      location: { kind: 'jsonl', path: join(survivor, 'session.v3.jsonl') },
    },
  ]))

  const result = await deleteSession(ctx, 'session-a', { deleteAttachments: true })

  assert.equal(result.ok, true)
  assert.equal(result.attachments.status, 'unverified')
  assert.equal(result.attachments.reason, 'writer')
  assert.equal(await exists(imagePath), true)
})

test('keeps every object when a surviving live session log is still pending', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  const imagePath = await addImageObject(home, DIGEST_A)
  const persistence = persistenceOf([
    { header: snapshot('session-a').header, events: [headerEvent(), imageEvent(1, DIGEST_A)] },
    { header: snapshot('session-b').header, events: [headerEvent(), imageEvent(1, DIGEST_A)] },
  ])
  persistence.hasPendingSession = (id) => id === 'session-b'
  const ctx = ctxWith(persistence, {
    sessions: { get: () => undefined, list: () => [{ id: 'session-b' }] },
  })

  const result = await deleteSession(ctx, 'session-a', { deleteAttachments: true })

  assert.equal(result.ok, true)
  assert.equal(result.attachments.status, 'unverified')
  assert.equal(result.attachments.reason, 'pending')
  assert.equal(await exists(imagePath), true)
})

test('keeps a shared object when one session of the tree survives the deletion', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  await addSessionDirectory(home, 'session-b')
  // session-c is in the tree (a subagent child) but has no directory, so it survives.
  const imagePath = await addImageObject(home, DIGEST_A)
  const ctx = ctxOf(persistenceOf([
    { header: snapshot('session-a').header, events: [headerEvent(), imageEvent(1, DIGEST_A)] },
    { header: { ...snapshot('session-c').header, origin: 'subagent', parentSession: 'session-a' }, events: [headerEvent(), imageEvent(1, DIGEST_A)] },
    { header: snapshot('session-b').header, events: [headerEvent()] },
  ]))

  const result = await deleteSession(ctx, 'session-a', { deleteAttachments: true })

  assert.equal(result.ok, true)
  assert.equal(result.attachments.kept, 1)
  assert.equal(await exists(imagePath), true)
})

test('treats only an explicit true as the option', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  const imagePath = await addImageObject(home, DIGEST_A)
  const ctx = ctxOf(persistenceOf([
    { header: snapshot('session-a').header, events: [headerEvent(), imageEvent(1, DIGEST_A)] },
  ]))

  const result = await deleteSession(ctx, 'session-a', { deleteAttachments: 'yes' })

  assert.equal(result.ok, true)
  assert.equal('attachments' in result, false)
  assert.equal(await exists(imagePath), true)
})

test('reports a missing object without failing the session deletion', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  const ctx = ctxOf(persistenceOf([
    { header: snapshot('session-a').header, events: [headerEvent(), imageEvent(1, DIGEST_D)] },
  ]))

  const result = await deleteSession(ctx, 'session-a', { deleteAttachments: true })

  assert.equal(result.ok, true)
  assert.equal(result.attachments.deleted, 0)
  assert.equal(result.attachments.missing, 1)
})

test('removes the attachments of a subagent child along with the parent', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  await addSessionDirectory(home, 'session-child')
  const imagePath = await addImageObject(home, DIGEST_A)
  const ctx = ctxOf(persistenceOf([
    { header: snapshot('session-a').header, events: [headerEvent()] },
    { header: { ...snapshot('session-child').header, origin: 'subagent', parentSession: 'session-a' }, events: [headerEvent(), imageEvent(1, DIGEST_A)] },
  ]))

  const result = await deleteSession(ctx, 'session-a', { deleteAttachments: true })

  assert.equal(result.ok, true)
  assert.deepEqual(result.deleted.sort(), ['session-a', 'session-child'])
  assert.equal(result.attachments.deleted, 1)
  assert.equal(await exists(imagePath), false)
})

test('reads the deleted session log before removing its directory', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  const imagePath = await addImageObject(home, DIGEST_A)
  let reads = 0
  const persistence = persistenceOf([
    { header: snapshot('session-a').header, events: [headerEvent(), imageEvent(1, DIGEST_A)] },
  ])
  const open = persistence.open
  persistence.open = async (id, access) => {
    reads += 1
    const directory = join(home, 'sessions', '--work--', id)
    assert.equal(await exists(directory), true, 'the log must still exist when references are read')
    return open(id, access)
  }

  const result = await deleteSession(ctxOf(persistence), 'session-a', { deleteAttachments: true })

  assert.equal(reads, 1)
  assert.equal(result.attachments.deleted, 1)
  assert.equal(await exists(imagePath), false)
})

test('follows the recorded reference through the whole decoded log', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  await addSessionDirectory(home, 'session-b')
  const imagePath = await addImageObject(home, DIGEST_A)
  // The surviving session references the image only in a late event, far past
  // one read chunk; the scan must page through the log instead of stopping early.
  const events = [headerEvent()]
  for (let seq = 1; seq <= 2500; seq += 1) events.push({ seq, type: 'assistant/message', data: { text: `step ${seq}` } })
  events.push(imageEvent(2501, DIGEST_A))
  const ctx = ctxOf(persistenceOf([
    { header: snapshot('session-a').header, events: [headerEvent(), imageEvent(1, DIGEST_A)] },
    { header: snapshot('session-b').header, events },
  ]))

  const result = await deleteSession(ctx, 'session-a', { deleteAttachments: true })

  assert.equal(result.attachments.kept, 1)
  assert.equal(await exists(imagePath), true)
})

test('names an open session as the reason a deletion is refused', async (t) => {
  const home = await makeHome(t)
  const directory = await addSessionDirectory(home, 'session-a')
  const persistence = persistenceOf([
    { header: snapshot('session-a').header, events: [headerEvent()] },
  ])
  const ctx = ctxWith(persistence, { sessions: { get: (id) => (id === 'session-a' ? {} : undefined) } })

  const result = await deleteSession(ctx, 'session-a', { deleteAttachments: true })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'live')
  assert.equal(result.reason, 'session')
  assert.equal(result.sessionId, 'session-a')
  assert.equal(await exists(directory), true)
})

test('honors a workspace activity provider before deleting', async (t) => {
  const home = await makeHome(t)
  const directory = await addSessionDirectory(home, 'session-a')
  const ctx = ctxOf(persistenceOf([{ header: snapshot('session-a').header, events: [headerEvent()] }]))
  ctx.waterfall = async () => [{ kind: 'custom' }]

  const result = await deleteSession(ctx, 'session-a')

  assert.equal(result.ok, false)
  assert.equal(result.code, 'live')
  assert.equal(result.reason, 'custom')
  assert.equal(await exists(directory), true)
})

test('names a pending subagent descendant that is not in the catalog', async (t) => {
  const home = await makeHome(t)
  const directory = await addSessionDirectory(home, 'session-a')
  const persistence = persistenceOf([
    { header: snapshot('session-a').header, events: [headerEvent()] },
  ])
  const ctx = ctxWith(persistence, {
    sessions: {
      get: () => undefined,
      list: () => [{
        id: 'session-pending-child',
        header: { id: 'session-pending-child', version: 4, createdAt: 2, cwd: '/work', origin: 'subagent', parentSession: 'session-a' },
      }],
    },
  })

  const result = await deleteSession(ctx, 'session-a', { deleteAttachments: true })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'live')
  assert.equal(result.reason, 'session')
  assert.equal(result.sessionId, 'session-pending-child')
  assert.equal(await exists(directory), true)
})

test('refuses a session held by another process write lease', async (t) => {
  const home = await makeHome(t)
  const directory = await addSessionDirectory(home, 'session-a')
  const persistence = persistenceOf([{
    header: snapshot('session-a').header,
    events: [headerEvent()],
    formatStatus: 'current',
    location: { kind: 'jsonl', path: join(directory, 'session.v4.jsonl') },
  }])
  const open = persistence.open
  persistence.open = async (id, access) => {
    if (access === 'write') {
      const error = new Error('held by another process')
      error.name = 'SessionAlreadyOwnedError'
      throw error
    }
    return open(id, access)
  }
  const ctx = ctxOf(persistence)

  const result = await deleteSession(ctx, 'session-a')

  assert.equal(result.ok, false)
  assert.equal(result.code, 'live')
  assert.equal(result.reason, 'writer')
  assert.equal(await exists(directory), true)
})

test('probes a migration-required tree session before deleting it', async (t) => {
  const home = await makeHome(t)
  const directory = await addSessionDirectory(home, 'session-a')
  const persistence = persistenceOf([{
    header: snapshot('session-a').header,
    events: [headerEvent()],
    formatStatus: 'migration-required',
    location: { kind: 'jsonl', path: join(directory, 'session.v3.jsonl') },
  }])
  const open = persistence.open
  persistence.open = async (id, access, options) => {
    if (access === 'write') {
      const error = new Error('held by another process')
      error.name = 'SessionAlreadyOwnedError'
      throw error
    }
    return open(id, access, options)
  }
  const ctx = ctxOf(persistence)

  const result = await deleteSession(ctx, 'session-a')

  assert.equal(result.ok, false)
  assert.equal(result.code, 'live')
  assert.equal(result.reason, 'writer')
  assert.equal(await exists(directory), true)
})

test('names a running job as the reason a deletion is refused', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  const persistence = persistenceOf([
    { header: snapshot('session-a').header, events: [headerEvent()] },
  ])
  const ctx = ctxWith(persistence, {
    jobs: { list: () => [{ id: 'job-1', owner: 'session-a', status: 'running' }] },
  })

  const result = await deleteSession(ctx, 'session-a')

  assert.equal(result.code, 'live')
  assert.equal(result.reason, 'job')
})

test('ignores an unowned running job that belongs to no session', async (t) => {
  const home = await makeHome(t)
  const directory = await addSessionDirectory(home, 'session-a')
  const persistence = persistenceOf([
    { header: snapshot('session-a').header, events: [headerEvent()] },
  ])
  const ctx = ctxWith(persistence, {
    jobs: { list: () => [{ id: 'job-unowned', status: 'running' }] },
  })

  const result = await deleteSession(ctx, 'session-a')

  assert.equal(result.ok, true)
  assert.equal(await exists(directory), false)
})

test('announces each deleted session so the page drops its row immediately', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  await addSessionDirectory(home, 'session-child')
  const persistence = persistenceOf([
    { header: snapshot('session-a').header, events: [headerEvent()] },
    { header: { ...snapshot('session-child').header, origin: 'subagent', parentSession: 'session-a' }, events: [headerEvent()] },
  ])
  const ctx = ctxOf(persistence)

  const result = await deleteSession(ctx, 'session-a')

  assert.equal(result.ok, true)
  assert.deepEqual(result.deleted, ['session-child', 'session-a'])
  assert.deepEqual(ctx.emitted, [
    ['api-session/removed', 'session-a'],
    ['api-session/removed', 'session-child'],
  ])
})

test('treats an already-absent child directory as already deleted', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  const persistence = persistenceOf([
    { header: snapshot('session-a').header, events: [headerEvent()] },
    { header: { ...snapshot('session-child').header, origin: 'subagent', parentSession: 'session-a' }, events: [headerEvent()] },
  ])
  const ctx = ctxOf(persistence)

  const result = await deleteSession(ctx, 'session-a')

  assert.equal(result.ok, true)
  assert.deepEqual(result.deleted, ['session-a'])
  assert.deepEqual(ctx.emitted, [
    ['api-session/removed', 'session-a'],
    ['api-session/removed', 'session-child'],
  ])
})

test('refuses a readable grandchild whose intermediate parent is not in the catalog', async (t) => {
  const home = await makeHome(t)
  const root = await addSessionDirectory(home, 'session-a')
  const grandchild = await addSessionDirectory(home, 'session-grandchild')
  const persistence = persistenceOf([
    { header: snapshot('session-a').header, events: [headerEvent()] },
    {
      header: { ...snapshot('session-grandchild').header, origin: 'subagent', parentSession: 'session-missing-child' },
      events: [headerEvent()],
    },
  ])
  const ctx = ctxOf(persistence)

  const result = await deleteSession(ctx, 'session-a')

  assert.equal(result.ok, false)
  assert.equal(result.code, 'tree-incomplete')
  assert.equal(await exists(root), true)
  assert.equal(await exists(grandchild), true)
})

test('refuses a subagent descendant behind a readable intermediate without origin', async (t) => {
  const home = await makeHome(t)
  const root = await addSessionDirectory(home, 'session-a')
  await addSessionDirectory(home, 'session-child')
  await addSessionDirectory(home, 'session-grandchild')
  const persistence = persistenceOf([
    { header: snapshot('session-a').header, events: [headerEvent()] },
    {
      // A normal fork would omit parentSession; this intermediate has a parent
      // link but lost its subagent origin.
      header: { ...snapshot('session-child').header, parentSession: 'session-a' },
      events: [headerEvent()],
    },
    {
      header: { ...snapshot('session-grandchild').header, origin: 'subagent', parentSession: 'session-child' },
      events: [headerEvent()],
    },
  ])
  const ctx = ctxOf(persistence)

  const result = await deleteSession(ctx, 'session-a')

  assert.equal(result.ok, false)
  assert.equal(result.code, 'tree-incomplete')
  assert.equal(await exists(root), true)
})

test('refuses a same-project subagent without a parent link', async (t) => {
  const home = await makeHome(t)
  const root = await addSessionDirectory(home, 'session-a')
  const orphan = await addSessionDirectory(home, 'session-orphan')
  const ctx = ctxOf(persistenceOf([
    { header: snapshot('session-a').header, events: [headerEvent()] },
    {
      header: { ...snapshot('session-orphan').header, origin: 'subagent' },
      events: [headerEvent()],
    },
  ]))

  const result = await deleteSession(ctx, 'session-a')

  assert.equal(result.ok, false)
  assert.equal(result.code, 'tree-incomplete')
  assert.equal(await exists(root), true)
  assert.equal(await exists(orphan), true)
})

test('refuses a same-project subagent whose parent chain cycles', async (t) => {
  const home = await makeHome(t)
  const root = await addSessionDirectory(home, 'session-a')
  const first = await addSessionDirectory(home, 'session-x')
  const second = await addSessionDirectory(home, 'session-y')
  const ctx = ctxOf(persistenceOf([
    { header: snapshot('session-a').header, events: [headerEvent()] },
    {
      header: { ...snapshot('session-x').header, origin: 'subagent', parentSession: 'session-y' },
      events: [headerEvent()],
    },
    {
      header: { ...snapshot('session-y').header, origin: 'subagent', parentSession: 'session-x' },
      events: [headerEvent()],
    },
  ]))

  const result = await deleteSession(ctx, 'session-a')

  assert.equal(result.ok, false)
  assert.equal(result.code, 'tree-incomplete')
  assert.equal(await exists(root), true)
  assert.equal(await exists(first), true)
  assert.equal(await exists(second), true)
})

test('refuses a same-project session directory the catalog cannot name', async (t) => {
  const home = await makeHome(t)
  const root = await addSessionDirectory(home, 'session-a')
  const ghost = await addSessionDirectory(home, 'session-ghost')
  const imagePath = await addImageObject(home, DIGEST_A)
  const ctx = ctxOf(persistenceOf([
    { header: snapshot('session-a').header, events: [headerEvent(), imageEvent(1, DIGEST_A)] },
  ]))

  const result = await deleteSession(ctx, 'session-a', { deleteAttachments: true })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'tree-incomplete')
  assert.equal(await exists(root), true)
  assert.equal(await exists(ghost), true)
  assert.equal(await exists(imagePath), true)
})

test('removes a subagent chain deeper than the old depth cap', async (t) => {
  const home = await makeHome(t)
  const sessions = []
  const ids = []
  for (let index = 0; index <= 70; index += 1) {
    const id = `deep-${index}`
    ids.push(id)
    await addSessionDirectory(home, id)
    sessions.push({
      header: {
        ...snapshot(id).header,
        ...(index === 0 ? {} : { origin: 'subagent', parentSession: ids[index - 1] }),
      },
      events: [headerEvent()],
    })
  }
  const ctx = ctxOf(persistenceOf(sessions))

  const result = await deleteSession(ctx, ids[0])

  assert.equal(result.ok, true)
  assert.equal(result.deleted.length, ids.length)
  for (const id of ids) assert.equal(await exists(join(home, 'sessions', '--work--', id)), false)
})

test('keeps the failed directory ancestors when a child delete fails', async (t) => {
  const home = await makeHome(t)
  const root = await addSessionDirectory(home, 'session-a')
  const child = await addSessionDirectory(home, 'session-child')
  const grandchild = await addSessionDirectory(home, 'session-grandchild')
  const sessions = [
    { header: snapshot('session-a').header, events: [headerEvent()] },
    { header: { ...snapshot('session-child').header, origin: 'subagent', parentSession: 'session-a' }, events: [headerEvent()] },
    { header: { ...snapshot('session-grandchild').header, origin: 'subagent', parentSession: 'session-child' }, events: [headerEvent()] },
  ]
  const ctx = ctxOf(persistenceOf(sessions))

  const first = await deleteSession(ctx, 'session-a', {
    removeDirectory: async (_root, directory) => {
      if (basename(directory) === 'session-grandchild') throw new Error('injected delete failure')
      await rm(directory, { recursive: true })
    },
  })

  assert.equal(first.ok, false)
  assert.equal(first.code, 'partial')
  assert.deepEqual(first.failed.map((entry) => entry.sessionId), ['session-grandchild'])
  assert.equal(await exists(root), true)
  assert.equal(await exists(child), true)
  assert.equal(await exists(grandchild), true)

  const retry = await deleteSession(ctx, 'session-a')
  assert.equal(retry.ok, true)
  assert.equal(await exists(root), false)
  assert.equal(await exists(child), false)
  assert.equal(await exists(grandchild), false)
})

test('cleans a child that was deleted before the root failure', async (t) => {
  const home = await makeHome(t)
  const root = await addSessionDirectory(home, 'session-a')
  await addSessionDirectory(home, 'session-child')
  const imagePath = await addImageObject(home, DIGEST_A)
  const ctx = ctxOf(persistenceOf([
    { header: snapshot('session-a').header, events: [headerEvent()] },
    {
      header: { ...snapshot('session-child').header, origin: 'subagent', parentSession: 'session-a' },
      events: [headerEvent(), imageEvent(1, DIGEST_A)],
    },
  ]))

  const result = await deleteSession(ctx, 'session-a', {
    deleteAttachments: true,
    removeDirectory: async (_root, directory) => {
      if (basename(directory) === 'session-a') throw new Error('injected root failure')
      await rm(directory, { recursive: true })
    },
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'partial')
  assert.deepEqual(result.deleted, ['session-child'])
  assert.deepEqual(result.failed.map((entry) => entry.sessionId), ['session-a'])
  assert.equal(result.attachments.status, 'applied')
  assert.equal(result.attachments.deleted, 1)
  assert.equal(await exists(root), true)
  assert.equal(await exists(imagePath), false)
})

test('cleans a deleted grandchild when an intermediate child fails', async (t) => {
  const home = await makeHome(t)
  const root = await addSessionDirectory(home, 'session-a')
  const child = await addSessionDirectory(home, 'session-child')
  await addSessionDirectory(home, 'session-grandchild')
  const imagePath = await addImageObject(home, DIGEST_A)
  const ctx = ctxOf(persistenceOf([
    { header: snapshot('session-a').header, events: [headerEvent()] },
    {
      header: { ...snapshot('session-child').header, origin: 'subagent', parentSession: 'session-a' },
      events: [headerEvent()],
    },
    {
      header: { ...snapshot('session-grandchild').header, origin: 'subagent', parentSession: 'session-child' },
      events: [headerEvent(), imageEvent(1, DIGEST_A)],
    },
  ]))

  const result = await deleteSession(ctx, 'session-a', {
    deleteAttachments: true,
    removeDirectory: async (_root, directory) => {
      if (basename(directory) === 'session-child') throw new Error('injected child failure')
      await rm(directory, { recursive: true })
    },
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'partial')
  assert.deepEqual(result.deleted, ['session-grandchild'])
  assert.deepEqual(result.failed.map((entry) => entry.sessionId), ['session-child'])
  assert.equal(result.attachments.status, 'applied')
  assert.equal(result.attachments.deleted, 1)
  assert.equal(await exists(root), true)
  assert.equal(await exists(child), true)
  assert.equal(await exists(imagePath), false)
})

/** A directory link: a junction on Windows, a directory symlink elsewhere. */
function linkDirectory(target, path) {
  return symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir')
}

test('deletes a reference that only appears past the first read chunk of the deleted log', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  const imagePath = await addImageObject(home, DIGEST_A)
  const events = [headerEvent()]
  for (let seq = 1; seq <= 2400; seq += 1) events.push({ seq, type: 'assistant/message', data: { text: `step ${seq}` } })
  events.push(imageEvent(2401, DIGEST_A))
  const ctx = ctxOf(persistenceOf([{ header: snapshot('session-a').header, events }]))

  const result = await deleteSession(ctx, 'session-a', { deleteAttachments: true })

  assert.equal(result.attachments.deleted, 1)
  assert.equal(await exists(imagePath), false)
})

test('refuses a log read that never advances instead of re-reading it forever', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  const imagePath = await addImageObject(home, DIGEST_A)
  const persistence = {
    name: 'session-persistence-jsonl',
    root: join(home, 'sessions'),
    async list() {
      return [{ header: snapshot('session-a').header }]
    },
    async open() {
      return {
        id: 'session-a',
        inheritedEventCount: 0,
        async read() {
          return { events: [imageEvent(0, DIGEST_A)] }
        },
        async close() {},
      }
    },
  }

  const result = await deleteSession(ctxOf(persistence), 'session-a', { deleteAttachments: true })

  assert.equal(result.ok, true)
  assert.equal(result.attachments.status, 'unverified')
  assert.equal(result.attachments.deleted, 0)
  assert.equal(await exists(imagePath), true)
})

test('keeps every object when reading the deleted log outlives the budget', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  const imagePath = await addImageObject(home, DIGEST_A)
  const persistence = {
    name: 'session-persistence-jsonl',
    root: join(home, 'sessions'),
    async list() {
      return [{ header: snapshot('session-a').header }]
    },
    async open() {
      return {
        id: 'session-a',
        inheritedEventCount: 0,
        async read(offset, length, options) {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, 200)
            const signal = options?.signal
            if (signal === undefined) return
            const abort = () => {
              clearTimeout(timer)
              reject(new Error('aborted'))
            }
            if (signal.aborted) abort()
            else signal.addEventListener('abort', abort, { once: true })
          })
          return { events: [imageEvent(0, DIGEST_A)] }
        },
        async close() {},
      }
    },
  }

  const result = await deleteSession(ctxOf(persistence), 'session-a', {
    deleteAttachments: true,
    attachmentsBudgetMs: 5,
  })

  assert.equal(result.attachments.status, 'unverified')
  assert.equal(result.attachments.reason, 'timeout')
  assert.equal(await exists(imagePath), true)
})

test('keeps every object when a stored directory is missing from the catalog', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  await addSessionDirectory(home, 'session-ghost', '--other--')
  const imagePath = await addImageObject(home, DIGEST_A)
  const ctx = ctxOf(persistenceOf([
    { header: snapshot('session-a').header, events: [headerEvent(), imageEvent(1, DIGEST_A)] },
  ]))

  const result = await deleteSession(ctx, 'session-a', { deleteAttachments: true })

  assert.equal(result.ok, true)
  assert.equal(result.attachments.status, 'unverified')
  assert.equal(result.attachments.reason, 'catalog')
  assert.equal(await exists(imagePath), true)
})

test('keeps every object when one session id exists under two projects', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a', '--one--')
  await addSessionDirectory(home, 'session-a', '--two--')
  const imagePath = await addImageObject(home, DIGEST_A)
  const ctx = ctxOf(persistenceOf([
    { header: snapshot('session-a').header, events: [headerEvent(), imageEvent(1, DIGEST_A)] },
  ]))

  const result = await deleteSession(ctx, 'session-a', { deleteAttachments: true })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'ambiguous')
  assert.equal(await exists(join(home, 'sessions', '--one--', 'session-a')), true)
  assert.equal(await exists(join(home, 'sessions', '--two--', 'session-a')), true)
  assert.equal(await exists(imagePath), true)
})

test('reports an unreachable object path as missing, not as a deletion failure', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  const objects = join(home, 'attachments', 'v1', 'objects')
  await mkdir(objects, { recursive: true })
  await writeFile(join(objects, DIGEST_A.slice(0, 2)), 'not a directory')
  const ctx = ctxOf(persistenceOf([
    { header: snapshot('session-a').header, events: [headerEvent(), imageEvent(1, DIGEST_A)] },
  ]))

  const result = await deleteSession(ctx, 'session-a', { deleteAttachments: true })

  assert.equal(result.attachments.status, 'applied')
  assert.equal(result.attachments.missing, 1)
  assert.equal(result.attachments.failed, 0)
})

test('refuses to delete through a linked attachment directory', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  const outside = join(home, 'outside')
  await mkdir(join(outside, DIGEST_A.slice(0, 2)), { recursive: true })
  const outsideObject = join(outside, DIGEST_A.slice(0, 2), DIGEST_A)
  await writeFile(outsideObject, 'outside')
  const store = join(home, 'attachments', 'v1')
  await mkdir(store, { recursive: true })
  await linkDirectory(outside, join(store, 'objects'))
  const ctx = ctxOf(persistenceOf([
    { header: snapshot('session-a').header, events: [headerEvent(), imageEvent(1, DIGEST_A)] },
  ]))

  const result = await deleteSession(ctx, 'session-a', { deleteAttachments: true })

  assert.equal(result.attachments.status, 'partial')
  assert.equal(result.attachments.failed, 1)
  assert.equal(result.attachments.deleted, 0)
  assert.equal(await exists(outsideObject), true)
})

test('reports a refused object entry as a failure instead of skipping it', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  const bucket = join(home, 'attachments', 'v1', 'objects', DIGEST_A.slice(0, 2))
  await mkdir(bucket, { recursive: true })
  const target = join(home, 'elsewhere')
  await mkdir(target, { recursive: true })
  await linkDirectory(target, join(bucket, DIGEST_A))
  const ctx = ctxOf(persistenceOf([
    { header: snapshot('session-a').header, events: [headerEvent(), imageEvent(1, DIGEST_A)] },
  ]))

  const result = await deleteSession(ctx, 'session-a', { deleteAttachments: true })

  assert.equal(result.attachments.status, 'partial')
  assert.equal(result.attachments.failed, 1)
})

test('removes abandoned staging files and keeps recent ones', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  await addImageObject(home, DIGEST_A)
  const staging = join(home, 'attachments', 'v1', 'tmp')
  await mkdir(staging, { recursive: true })
  const abandoned = join(staging, 'abandoned')
  const inFlight = join(staging, 'in-flight')
  await writeFile(abandoned, 'old')
  await writeFile(inFlight, 'new')
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
  await utimes(abandoned, eightDaysAgo, eightDaysAgo)
  const ctx = ctxOf(persistenceOf([
    { header: snapshot('session-a').header, events: [headerEvent(), imageEvent(1, DIGEST_A)] },
  ]))

  const result = await deleteSession(ctx, 'session-a', { deleteAttachments: true })

  assert.equal(result.attachments.staging, 1)
  assert.equal(await exists(abandoned), false)
  assert.equal(await exists(inFlight), true)
})

test('uses the persistence root and the attachment service root when relocated', async (t) => {
  await makeHome(t)
  const relocated = await mkdtemp(join(tmpdir(), 'dsh-relocated-'))
  t.after(async () => {
    await rm(relocated, { recursive: true, force: true })
  })
  const directory = join(relocated, 'sessions', '--work--', 'session-a')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'session.v4.jsonl'), '')
  const objectPath = join(relocated, 'attachments', 'v1', 'objects', DIGEST_A.slice(0, 2), DIGEST_A)
  await mkdir(dirname(objectPath), { recursive: true })
  await writeFile(objectPath, 'x')
  const persistence = persistenceOf([
    { header: snapshot('session-a').header, events: [headerEvent(), imageEvent(1, DIGEST_A)] },
  ])
  persistence.root = join(relocated, 'sessions')
  const ctx = ctxWith(persistence, { attachments: { root: join(relocated, 'attachments', 'v1') } })

  const result = await deleteSession(ctx, 'session-a', { deleteAttachments: true })

  assert.equal(result.ok, true)
  assert.equal(result.attachments.deleted, 1)
  assert.equal(await exists(objectPath), false)
  assert.equal(await exists(directory), false)
})

test('reads the attachment root from the mounted attachment service', async (t) => {
  await makeHome(t)
  const store = await mkdtemp(join(tmpdir(), 'dsh-store-'))
  t.after(async () => {
    await rm(store, { recursive: true, force: true })
  })
  await addSessionDirectory(process.env.DSH_HOME, 'session-a')
  const objectPath = join(store, 'objects', DIGEST_A.slice(0, 2), DIGEST_A)
  await mkdir(dirname(objectPath), { recursive: true })
  await writeFile(objectPath, 'x')
  const ctx = ctxWith(
    persistenceOf([{ header: snapshot('session-a').header, events: [headerEvent(), imageEvent(1, DIGEST_A)] }]),
    { attachments: { root: store } },
  )

  const result = await deleteSession(ctx, 'session-a', { deleteAttachments: true })

  assert.equal(result.attachments.deleted, 1)
  assert.equal(await exists(objectPath), false)
})

test('re-checks liveness before removing the session log', async (t) => {
  const home = await makeHome(t)
  const directory = await addSessionDirectory(home, 'session-a')
  const persistence = persistenceOf([{ header: snapshot('session-a').header, events: [headerEvent()] }])
  let calls = 0
  const ctx = ctxWith(persistence, {
    sessions: {
      get: (id) => {
        calls += 1
        return calls > 1 && id === 'session-a' ? {} : undefined
      },
    },
  })

  const result = await deleteSession(ctx, 'session-a', { deleteAttachments: true })

  assert.equal(result.code, 'live')
  assert.equal(result.reason, 'session')
  assert.equal(await exists(directory), true)
})

test('reports a concurrent deletion of the same session as busy', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  const ctx = ctxOf(persistenceOf([{ header: snapshot('session-a').header, events: [headerEvent()] }]))
  let release
  const gate = new Promise((resolve) => { release = resolve })

  const first = deleteSession(ctx, 'session-a', {
    removeDirectory: async (_root, directory) => {
      await gate
      await rm(directory, { recursive: true })
    },
  })
  const second = await deleteSession(ctx, 'session-a')
  assert.equal(second.ok, false)
  assert.equal(second.code, 'busy')

  release()
  const result = await first
  assert.equal(result.ok, true)
})

test('does not treat an encoded session directory as an unknown reference', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  const weird = join(home, 'sessions', '--work--', 'my~0020session')
  await mkdir(weird, { recursive: true })
  await writeFile(join(weird, 'session.v4.jsonl'), '')
  const imagePath = await addImageObject(home, DIGEST_A)
  const ctx = ctxOf(persistenceOf([
    { header: snapshot('session-a').header, events: [headerEvent(), imageEvent(1, DIGEST_A)] },
    {
      header: { ...snapshot('my session').header },
      events: [headerEvent()],
      formatStatus: 'current',
      location: { kind: 'jsonl', path: join(weird, 'session.v4.jsonl.zstd') },
    },
  ]))

  const result = await deleteSession(ctx, 'session-a', { deleteAttachments: true })

  assert.equal(result.attachments.status, 'applied')
  assert.equal(result.attachments.deleted, 1)
  assert.equal(await exists(imagePath), false)
})

test('matches an encoded session directory even without a catalog location', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  const weird = join(home, 'sessions', '--work--', 'my~0020session')
  await mkdir(weird, { recursive: true })
  await writeFile(join(weird, 'session.v4.jsonl'), '')
  await addImageObject(home, DIGEST_A)
  const ctx = ctxOf(persistenceOf([
    { header: snapshot('session-a').header, events: [headerEvent(), imageEvent(1, DIGEST_A)] },
    { header: { ...snapshot('my session').header }, events: [headerEvent()] },
  ]))

  const result = await deleteSession(ctx, 'session-a', { deleteAttachments: true })

  assert.equal(result.attachments.status, 'applied')
  assert.equal(result.attachments.deleted, 1)
})

test('uses the persistence config root when the service exposes no root', async (t) => {
  await makeHome(t)
  const relocated = await mkdtemp(join(tmpdir(), 'dsh-config-root-'))
  t.after(async () => {
    await rm(relocated, { recursive: true, force: true })
  })
  const directory = join(relocated, 'sessions', '--work--', 'session-a')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'session.v4.jsonl'), '')
  const persistence = persistenceOf([{ header: snapshot('session-a').header, events: [headerEvent()] }])
  delete persistence.root
  persistence.config = { root: join(relocated, 'sessions') }

  const result = await deleteSession(ctxOf(persistence), 'session-a')

  assert.equal(result.ok, true)
  assert.equal(await exists(directory), false)
})

test('deletes the exact stored id without trimming or normalization', async (t) => {
  const home = await makeHome(t)
  const paddedId = ' session-a '
  const paddedDirectory = join(home, 'sessions', '--work--', encodeSessionId(paddedId))
  await mkdir(paddedDirectory, { recursive: true })
  await writeFile(join(paddedDirectory, 'session.v3.jsonl'), '{}\n')
  const plainDirectory = await addSessionDirectory(home, 'session-a')
  const ctx = ctxOf(persistenceOf([
    { header: snapshot(paddedId).header, events: [headerEvent()] },
    { header: snapshot('session-a').header, events: [headerEvent()] },
  ]))

  const result = await deleteSession(ctx, paddedId)

  assert.equal(result.ok, true)
  assert.deepEqual(result.deleted, [paddedId])
  assert.equal(await exists(paddedDirectory), false)
  assert.equal(await exists(plainDirectory), true)
})

test('deletes a non-ASCII stored id through the encoded directory', async (t) => {
  const home = await makeHome(t)
  const id = '会话-a'
  const directory = join(home, 'sessions', '--work--', encodeSessionId(id))
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'session.v3.jsonl'), '{}\n')
  const ctx = ctxOf(persistenceOf([{ header: snapshot(id).header, events: [headerEvent()] }]))

  const result = await deleteSession(ctx, id)

  assert.equal(result.ok, true)
  assert.deepEqual(result.deleted, [id])
  assert.equal(await exists(directory), false)
})

test('matches a case-renamed session directory on Windows', { skip: process.platform !== 'win32' }, async (t) => {
  const home = await makeHome(t)
  const project = join(home, 'sessions', '--work--')
  const actual = join(project, 'Session-A')
  await mkdir(actual, { recursive: true })
  await writeFile(join(actual, 'session.v3.jsonl'), '{}\n')
  const ctx = ctxOf(persistenceOf([{
    header: snapshot('session-a').header,
    events: [headerEvent()],
    location: { kind: 'jsonl', path: join(project, 'session-a', 'session.v3.jsonl') },
  }]))

  const result = await deleteSession(ctx, 'session-a')

  assert.equal(result.ok, true)
  assert.equal(await exists(actual), false)
})

test('refuses a duplicated session directory instead of deleting one copy', async (t) => {
  const home = await makeHome(t)
  const first = await addSessionDirectory(home, 'session-a', '--one--')
  const second = await addSessionDirectory(home, 'session-a', '--two--')
  const ctx = ctxOf(persistenceOf([{
    header: snapshot('session-a').header,
    events: [headerEvent()],
    location: { kind: 'jsonl', path: join(second, 'session.v4.jsonl') },
  }]))

  const result = await deleteSession(ctx, 'session-a')

  assert.equal(result.ok, false)
  assert.equal(result.code, 'ambiguous')
  assert.equal(await exists(first), true)
  assert.equal(await exists(second), true)
})

test('refuses a directory that disagrees with the catalog location', async (t) => {
  const home = await makeHome(t)
  const directory = await addSessionDirectory(home, 'session-a', '--one--')
  const ctx = ctxOf(persistenceOf([{
    header: snapshot('session-a').header,
    events: [headerEvent()],
    location: { kind: 'jsonl', path: join(home, 'sessions', '--two--', 'session-a', 'session.v4.jsonl') },
  }]))

  const result = await deleteSession(ctx, 'session-a')

  assert.equal(result.ok, false)
  assert.equal(result.code, 'ambiguous')
  assert.equal(await exists(directory), true)
})

test('refuses a catalog directory whose name is not the encoded session id', async (t) => {
  const home = await makeHome(t)
  const wrong = join(home, 'sessions', '--work--', 'not-the-id')
  await mkdir(wrong, { recursive: true })
  await writeFile(join(wrong, 'session.v4.jsonl'), '')
  const ctx = ctxOf(persistenceOf([{
    header: snapshot('session-a').header,
    events: [headerEvent()],
    location: { kind: 'jsonl', path: join(wrong, 'session.v4.jsonl') },
  }]))

  const result = await deleteSession(ctx, 'session-a')

  assert.equal(result.ok, false)
  assert.equal(result.code, 'ambiguous')
  assert.equal(await exists(wrong), true)
})

test('refuses to remove a directory when the materialized location changed', async (t) => {
  const home = await makeHome(t)
  const directory = await addSessionDirectory(home, 'session-a')
  const other = join(home, 'outside', 'session-a')
  await mkdir(other, { recursive: true })
  await writeFile(join(other, 'session.v3.jsonl'), '{}\n')
  const persistence = persistenceOf([{ header: snapshot('session-a').header, events: [headerEvent()] }])
  persistence.stat = async () => ({
    header: snapshot('session-a').header,
    revision: 'rev-session-a',
    location: { kind: 'jsonl', path: join(other, 'session.v3.jsonl') },
  })
  const ctx = ctxOf(persistence)

  const result = await deleteSession(ctx, 'session-a')

  assert.equal(result.ok, false)
  assert.equal(result.code, 'partial')
  assert.equal(await exists(directory), true)
  assert.equal(await exists(other), true)
})

test('returns not-found when another process removed the root before removal', async (t) => {
  const home = await makeHome(t)
  const directory = await addSessionDirectory(home, 'session-a')
  const persistence = persistenceOf([{ header: snapshot('session-a').header, events: [headerEvent()] }])
  let stats = 0
  persistence.stat = async () => {
    stats += 1
    return stats === 1
      ? {
          header: snapshot('session-a').header,
          revision: 'rev-session-a',
          location: { kind: 'jsonl', path: join(directory, 'session.v3.jsonl') },
        }
      : undefined
  }
  const ctx = ctxOf(persistence)

  const result = await deleteSession(ctx, 'session-a', {
    removeDirectory: async (_root, planned) => {
      await rm(planned, { recursive: true })
      const error = new Error('removed by another process')
      error.code = 'SESSION_GONE'
      throw error
    },
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'not-found')
  assert.equal(await exists(directory), false)
})

test('reports a missing root directory without touching reminders', async (t) => {
  const home = await makeHome(t)
  const edits = []
  const schedule = {
    async catalog() {
      return [{ id: 'delete-me', target: { kind: 'session', sessionId: 'session-a' }, status: 'active' }]
    },
    async edit(request) {
      edits.push(request.id)
      return { id: request.id, deleted: true }
    },
  }
  const ctx = ctxWith(
    persistenceOf([{ header: snapshot('session-a').header, events: [headerEvent()] }]),
    { schedule },
  )

  const result = await deleteSession(ctx, 'session-a')

  assert.equal(result.ok, false)
  assert.equal(result.code, 'directory-missing')
  assert.deepEqual(edits, [])
})

test('refuses deletion when the backend exposes no filesystem root', async (t) => {
  const home = await makeHome(t)
  const directory = await addSessionDirectory(home, 'session-a')
  const persistence = persistenceOf([{ header: snapshot('session-a').header, events: [headerEvent()] }])
  delete persistence.root

  const result = await deleteSession(ctxOf(persistence), 'session-a')

  assert.equal(result.ok, false)
  assert.equal(result.code, 'unsupported')
  assert.equal(await exists(directory), true)
})

test('reports attachment cleanup unavailable when the attachment service has no root', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  const ctx = ctxWith(
    persistenceOf([{ header: snapshot('session-a').header, events: [headerEvent()] }]),
    { attachments: undefined },
  )

  const result = await deleteSession(ctx, 'session-a', { deleteAttachments: true })

  assert.equal(result.ok, true)
  assert.equal(result.attachments.status, 'unverified')
  assert.equal(result.attachments.reason, 'unavailable')
})

test('refuses deletion when the job registry cannot be queried', async (t) => {
  const home = await makeHome(t)
  const directory = await addSessionDirectory(home, 'session-a')
  const ctx = ctxWith(
    persistenceOf([{ header: snapshot('session-a').header, events: [headerEvent()] }]),
    { jobs: { list() { throw new Error('job registry unavailable') } } },
  )

  const result = await deleteSession(ctx, 'session-a')

  assert.equal(result.ok, false)
  assert.equal(result.code, 'live-check-failed')
  assert.equal(await exists(directory), true)
})

test('refuses legacy schedule records instead of deleting the log', async (t) => {
  const home = await makeHome(t)
  const directory = await addSessionDirectory(home, 'session-a')
  const schedule = {
    async catalog() {
      return [{ id: 'legacy', sessionId: 'session-a', status: 'active' }]
    },
    async edit() {
      throw new Error('legacy record should not be edited')
    },
  }
  const ctx = ctxWith(
    persistenceOf([{ header: snapshot('session-a').header, events: [headerEvent()] }]),
    { schedule },
  )

  const result = await deleteSession(ctx, 'session-a')

  assert.equal(result.ok, false)
  assert.equal(result.code, 'schedule-failed')
  assert.equal(await exists(directory), true)
})

test('clears reminders before removing the session directory', async (t) => {
  const home = await makeHome(t)
  const directory = await addSessionDirectory(home, 'session-a')
  const tasks = [{ id: 'delete-me', target: { kind: 'session', sessionId: 'session-a' }, status: 'active' }]
  const schedule = {
    async catalog() {
      return tasks
    },
    async edit(request) {
      assert.equal(await exists(directory), true, 'reminders must be removed while the log still exists')
      tasks.splice(0)
      return { id: request.id, deleted: true }
    },
  }
  const ctx = ctxWith(
    persistenceOf([{ header: snapshot('session-a').header, events: [headerEvent()] }]),
    { schedule },
  )

  const result = await deleteSession(ctx, 'session-a')

  assert.equal(result.ok, true)
  assert.equal(result.schedules, 1)
})

test('refuses to delete logs when a reminder cannot be removed', async (t) => {
  const home = await makeHome(t)
  const directory = await addSessionDirectory(home, 'session-a')
  const schedule = {
    async catalog() {
      return [{ id: 'stuck', target: { kind: 'session', sessionId: 'session-a' } }]
    },
    async edit() {
      throw new Error('schedule write failed')
    },
  }
  const ctx = ctxWith(
    persistenceOf([{ header: snapshot('session-a').header, events: [headerEvent()] }]),
    { schedule },
  )

  const result = await deleteSession(ctx, 'session-a')

  assert.equal(result.ok, false)
  assert.equal(result.code, 'schedule-failed')
  assert.equal(await exists(directory), true)
})

test('removes spill files when no surviving session descends from the tree', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  const spillRoot = join(home, 'spill')
  const spillDirectory = join(spillRoot, spillKey('session-a'))
  await mkdir(spillDirectory, { recursive: true })
  await writeFile(join(spillDirectory, 'result.txt'), 'full result')
  const ctx = ctxWith(
    persistenceOf([{ header: snapshot('session-a').header, events: [headerEvent()] }]),
    { spillStore: { root: spillRoot } },
  )

  const result = await deleteSession(ctx, 'session-a')

  assert.equal(result.spill.deleted, 1)
  assert.equal(await exists(spillDirectory), false)
})

test('keeps spill files while a surviving ordinary fork exists', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  const spillRoot = join(home, 'spill')
  const spillDirectory = join(spillRoot, spillKey('session-a'))
  await mkdir(spillDirectory, { recursive: true })
  await writeFile(join(spillDirectory, 'result.txt'), 'full result')
  const ctx = ctxWith(
    persistenceOf([
      { header: snapshot('session-a').header, events: [headerEvent()] },
      {
        // Current DSH ordinary forks set isSeeded but omit parentSession.
        header: { ...snapshot('session-fork').header, isSeeded: true },
        events: [headerEvent()],
      },
    ]),
    { spillStore: { root: spillRoot } },
  )

  const result = await deleteSession(ctx, 'session-a')

  assert.equal(result.spill.kept, 1)
  assert.equal(await exists(spillDirectory), true)
})

test('removes the per-session projection cache and its backups', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  const cacheDirectory = join(home, 'storages', 'session_projcache', 'sessions')
  await mkdir(cacheDirectory, { recursive: true })
  const cachePath = join(cacheDirectory, 'session-a.json')
  const backupPath = join(cacheDirectory, 'session-a.json.bak.123')
  const otherPath = join(cacheDirectory, 'session-b.json')
  await writeFile(cachePath, '{}')
  await writeFile(backupPath, '{}')
  await writeFile(otherPath, '{}')
  const ctx = ctxOf(persistenceOf([{ header: snapshot('session-a').header, events: [headerEvent()] }]))

  const result = await deleteSession(ctx, 'session-a')

  assert.equal(result.caches, 2)
  assert.equal(await exists(cachePath), false)
  assert.equal(await exists(backupPath), false)
  assert.equal(await exists(otherPath), true)
})

test('uses the mounted storage backend root for projection-cache cleanup', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  const customRoot = join(home, 'custom-storages')
  const customCacheDirectory = join(customRoot, 'session_projcache', 'sessions')
  await mkdir(customCacheDirectory, { recursive: true })
  const customCache = join(customCacheDirectory, 'session-a.json')
  await writeFile(customCache, '{}')
  const defaultCacheDirectory = join(home, 'storages', 'session_projcache', 'sessions')
  await mkdir(defaultCacheDirectory, { recursive: true })
  const defaultCache = join(defaultCacheDirectory, 'session-a.json')
  await writeFile(defaultCache, '{}')
  const ctx = ctxWith(
    persistenceOf([{ header: snapshot('session-a').header, events: [headerEvent()] }]),
    { storage: { backend: { get: () => ({ root: customRoot }) } } },
  )

  const result = await deleteSession(ctx, 'session-a')

  assert.equal(result.caches, 1)
  assert.equal(await exists(customCache), false)
  assert.equal(await exists(defaultCache), true)
})

test('does not follow a linked projection-cache directory', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  const outside = join(home, 'outside-cache')
  await mkdir(outside, { recursive: true })
  const outsideCache = join(outside, 'session-a.json')
  await writeFile(outsideCache, '{}')
  const cacheParent = join(home, 'storages', 'session_projcache')
  await mkdir(cacheParent, { recursive: true })
  await linkDirectory(outside, join(cacheParent, 'sessions'))
  const ctx = ctxOf(persistenceOf([{ header: snapshot('session-a').header, events: [headerEvent()] }]))

  const result = await deleteSession(ctx, 'session-a')

  assert.equal(result.caches, 0)
  assert.equal(await exists(outsideCache), true)
})

test('skips projection-cache cleanup when no storage service is mounted', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  const cacheDirectory = join(home, 'storages', 'session_projcache', 'sessions')
  await mkdir(cacheDirectory, { recursive: true })
  const cachePath = join(cacheDirectory, 'session-a.json')
  await writeFile(cachePath, '{}')
  const ctx = ctxWith(
    persistenceOf([{ header: snapshot('session-a').header, events: [headerEvent()] }]),
    { storage: undefined },
  )

  const result = await deleteSession(ctx, 'session-a')

  assert.equal(result.caches, 0)
  assert.equal(await exists(cachePath), true)
})

test('keeps spill files when the stored-directory catalog is incomplete', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  await addSessionDirectory(home, 'session-ghost', '--other--')
  const spillRoot = join(home, 'spill')
  const spillDirectory = join(spillRoot, spillKey('session-a'))
  await mkdir(spillDirectory, { recursive: true })
  await writeFile(join(spillDirectory, 'result.txt'), 'full result')
  const ctx = ctxWith(
    persistenceOf([{ header: snapshot('session-a').header, events: [headerEvent()] }]),
    { spillStore: { root: spillRoot } },
  )

  const result = await deleteSession(ctx, 'session-a')

  assert.equal(result.spill.status, 'unverified')
  assert.equal(result.spill.kept, 1)
  assert.equal(await exists(spillDirectory), true)
})

test('keeps spill files when a surviving descendant has an unresolved parent', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  const orphan = await addSessionDirectory(home, 'session-orphan', '--other--')
  const spillRoot = join(home, 'spill-roots', 'dsh-spill-abc123')
  const spillDirectory = join(spillRoot, spillKey('session-a'))
  await mkdir(spillDirectory, { recursive: true })
  await writeFile(join(spillDirectory, 'result.txt'), 'full result')
  const ctx = ctxWith(
    persistenceOf([
      { header: snapshot('session-a').header, events: [headerEvent()] },
      {
        header: { ...snapshot('session-orphan').header, origin: 'subagent', parentSession: 'missing-parent' },
        events: [headerEvent()],
        location: { kind: 'jsonl', path: join(orphan, 'session.v4.jsonl') },
      },
    ]),
    { spillStore: { root: spillRoot } },
  )

  const result = await deleteSession(ctx, 'session-a')

  assert.equal(result.ok, true)
  assert.equal(result.spill.deleted, 0)
  assert.equal(result.spill.kept, 1)
  assert.equal(await exists(spillDirectory), true)
})

test('keeps spill files when a surviving subagent has no parent link', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  const orphan = await addSessionDirectory(home, 'session-orphan', '--other--')
  const spillRoot = join(home, 'spill-roots', 'dsh-spill-abc123')
  const spillDirectory = join(spillRoot, spillKey('session-a'))
  await mkdir(spillDirectory, { recursive: true })
  await writeFile(join(spillDirectory, 'result.txt'), 'full result')
  const ctx = ctxWith(
    persistenceOf([
      { header: snapshot('session-a').header, events: [headerEvent()] },
      {
        header: { ...snapshot('session-orphan').header, origin: 'subagent' },
        events: [headerEvent()],
        location: { kind: 'jsonl', path: join(orphan, 'session.v4.jsonl') },
      },
    ]),
    { spillStore: { root: spillRoot } },
  )

  const result = await deleteSession(ctx, 'session-a')

  assert.equal(result.ok, true)
  assert.equal(result.spill.deleted, 0)
  assert.equal(result.spill.kept, 1)
  assert.equal(await exists(spillDirectory), true)
})

test('does not follow a linked staging directory', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  const outside = join(home, 'outside')
  await mkdir(outside, { recursive: true })
  const abandoned = join(outside, 'abandoned')
  await writeFile(abandoned, 'old')
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
  await utimes(abandoned, old, old)
  const store = join(home, 'attachments', 'v1')
  await mkdir(store, { recursive: true })
  await linkDirectory(outside, join(store, 'tmp'))
  const ctx = ctxOf(persistenceOf([{ header: snapshot('session-a').header, events: [headerEvent()] }]))

  const result = await deleteSession(ctx, 'session-a', { deleteAttachments: true })

  assert.equal(result.attachments.staging, 0)
  assert.equal(await exists(abandoned), true)
})

test('removes reminders whose target is the deleted session only', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  const tasks = [
    { id: 'keep-other', target: { kind: 'session', sessionId: 'session-b' } },
    { id: 'keep-new', target: { kind: 'new' } },
    { id: 'keep-once', target: { kind: 'new_once', sessionId: 'session-reserved' } },
    { id: 'delete-me', target: { kind: 'session', sessionId: 'session-a' } },
  ]
  const deleted = []
  const schedule = {
    async catalog() {
      return tasks
    },
    async edit(request) {
      deleted.push(request.id)
      const index = tasks.findIndex((task) => task.id === request.id)
      if (index !== -1) tasks.splice(index, 1)
      return { id: request.id, deleted: true }
    },
  }
  const ctx = ctxWith(
    persistenceOf([{ header: snapshot('session-a').header, events: [headerEvent()] }]),
    { schedule },
  )

  const result = await deleteSession(ctx, 'session-a')

  assert.equal(result.schedules, 1)
  assert.deepEqual(deleted, ['delete-me'])
})

test('pages the reminder list when the service has no catalog', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  const tasks = [
    { id: 'delete-me', target: { kind: 'session', sessionId: 'session-a' } },
    { id: 'keep', target: { kind: 'session', sessionId: 'session-b' } },
  ]
  const deleted = []
  const schedule = {
    async list({ offset = 0, limit = 100 } = {}) {
      return { items: tasks.slice(offset, offset + limit), total: tasks.length }
    },
    async edit(request) {
      deleted.push(request.id)
      const index = tasks.findIndex((task) => task.id === request.id)
      if (index !== -1) tasks.splice(index, 1)
      return { id: request.id, deleted: true }
    },
  }
  const ctx = ctxWith(
    persistenceOf([{ header: snapshot('session-a').header, events: [headerEvent()] }]),
    { schedule },
  )

  const result = await deleteSession(ctx, 'session-a')

  assert.equal(result.schedules, 1)
  assert.deepEqual(deleted, ['delete-me'])
})

test('keeps paging the reminder list when the service reports no total', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  const tasks = [
    { id: 'keep', target: { kind: 'session', sessionId: 'session-b' } },
    { id: 'delete-me', target: { kind: 'session', sessionId: 'session-a' } },
  ]
  const deleted = []
  const schedule = {
    async list({ offset = 0 } = {}) {
      return { items: tasks.slice(offset, offset + 1) }
    },
    async edit(request) {
      deleted.push(request.id)
      const index = tasks.findIndex((task) => task.id === request.id)
      if (index !== -1) tasks.splice(index, 1)
      return { id: request.id, deleted: true }
    },
  }
  const ctx = ctxWith(
    persistenceOf([{ header: snapshot('session-a').header, events: [headerEvent()] }]),
    { schedule },
  )

  const result = await deleteSession(ctx, 'session-a')

  assert.equal(result.schedules, 1)
  assert.deepEqual(deleted, ['delete-me'])
})

test('refuses to delete a subagent child as the root session', async (t) => {
  const home = await makeHome(t)
  const directory = await addSessionDirectory(home, 'session-child')
  const ctx = ctxOf(persistenceOf([{
    header: {
      ...snapshot('session-child').header,
      origin: 'subagent',
      parentSession: 'session-parent',
    },
    events: [headerEvent()],
  }]))

  const result = await deleteSession(ctx, 'session-child')

  assert.equal(result.ok, false)
  assert.equal(result.code, 'subagent-session')
  assert.equal(await exists(directory), true)
})

test('probes pending survivors through stat() when hasPendingSession is absent', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  const imagePath = await addImageObject(home, DIGEST_A)
  const persistence = persistenceOf([
    { header: snapshot('session-a').header, events: [headerEvent(), imageEvent(1, DIGEST_A)] },
    { header: snapshot('session-b').header, events: [headerEvent()] },
  ])
  persistence.stat = async (id) => id === 'session-a'
    ? {
        header: snapshot('session-a').header,
        revision: 'rev-session-a',
        location: { kind: 'jsonl', path: join(home, 'sessions', '--work--', 'session-a', 'session.v3.jsonl') },
      }
    : { header: snapshot('session-b').header, revision: 'pending' }
  delete persistence.hasPendingSession
  const ctx = ctxWith(persistence, {
    sessions: { get: () => undefined, list: () => [{ id: 'session-b' }] },
  })

  const result = await deleteSession(ctx, 'session-a', { deleteAttachments: true })

  assert.equal(result.ok, true)
  assert.equal(result.attachments.status, 'unverified')
  assert.equal(result.attachments.reason, 'pending')
  assert.equal(await exists(imagePath), true)
})

test('keeps attachments when a survivor has no pending probe at all', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  const imagePath = await addImageObject(home, DIGEST_A)
  const persistence = persistenceOf([
    { header: snapshot('session-a').header, events: [headerEvent(), imageEvent(1, DIGEST_A)] },
    { header: snapshot('session-b').header, events: [headerEvent(), imageEvent(1, DIGEST_A)] },
  ])
  delete persistence.hasPendingSession
  const ctx = ctxOf(persistence)

  const result = await deleteSession(ctx, 'session-a', { deleteAttachments: true })

  assert.equal(result.ok, true)
  assert.equal(result.attachments.status, 'unverified')
  assert.equal(result.attachments.reason, 'pending')
  assert.equal(await exists(imagePath), true)
})

test('counts attachments still present only in a live session snapshot', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  const imagePath = await addImageObject(home, DIGEST_A)
  const persistence = persistenceOf([
    { header: snapshot('session-a').header, events: [headerEvent(), imageEvent(1, DIGEST_A)] },
    { header: snapshot('session-b').header, events: [headerEvent()] },
  ])
  persistence.hasPendingSession = () => false
  const live = {
    id: 'session-b',
    snapshotEvents: () => [headerEvent(), imageEvent(1, DIGEST_A)],
  }
  const ctx = ctxWith(persistence, {
    sessions: {
      get: (id) => (id === 'session-b' ? live : undefined),
      list: () => [{ id: 'session-b' }],
    },
  })

  const result = await deleteSession(ctx, 'session-a', { deleteAttachments: true })

  assert.equal(result.ok, true)
  assert.equal(result.attachments.status, 'applied')
  assert.equal(result.attachments.kept, 1)
  assert.equal(await exists(imagePath), true)
})

test('treats an unaccounted session directory with only a subdirectory as an artifact', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  await mkdir(join(home, 'sessions', '--other--', 'session-ghost', 'nested'), { recursive: true })
  const imagePath = await addImageObject(home, DIGEST_A)
  const ctx = ctxOf(persistenceOf([
    { header: snapshot('session-a').header, events: [headerEvent(), imageEvent(1, DIGEST_A)] },
  ]))

  const result = await deleteSession(ctx, 'session-a', { deleteAttachments: true })

  assert.equal(result.ok, true)
  assert.equal(result.attachments.status, 'unverified')
  assert.equal(result.attachments.reason, 'catalog')
  assert.equal(await exists(imagePath), true)
})

test('removes spill files from prior private spill roots', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  const parent = join(home, 'spill-roots')
  const current = join(parent, 'dsh-spill-abc123')
  const prior = join(parent, 'dsh-spill-def456')
  const unrelated = join(parent, 'dsh-spill-test-extra')
  for (const root of [current, prior, unrelated]) {
    const directory = join(root, spillKey('session-a'))
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'result.txt'), 'full result')
  }
  const ctx = ctxWith(
    persistenceOf([{ header: snapshot('session-a').header, events: [headerEvent()] }]),
    { spillStore: { root: current } },
  )

  const result = await deleteSession(ctx, 'session-a')

  assert.equal(result.spill.deleted, 2)
  assert.equal(await exists(join(current, spillKey('session-a'))), false)
  assert.equal(await exists(join(prior, spillKey('session-a'))), false)
  assert.equal(await exists(join(unrelated, spillKey('session-a'))), true)
})

test('skips a group-writable sibling private spill root', { skip: process.platform === 'win32' }, async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  const parent = join(home, 'spill-roots')
  const current = join(parent, 'dsh-spill-abc123')
  const untrusted = join(parent, 'dsh-spill-def456')
  for (const root of [current, untrusted]) {
    const directory = join(root, spillKey('session-a'))
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'result.txt'), 'full result')
  }
  await chmod(untrusted, 0o777)
  const ctx = ctxWith(
    persistenceOf([{ header: snapshot('session-a').header, events: [headerEvent()] }]),
    { spillStore: { root: current } },
  )

  const result = await deleteSession(ctx, 'session-a')

  assert.equal(result.spill.deleted, 1)
  assert.equal(await exists(join(current, spillKey('session-a'))), false)
  assert.equal(await exists(join(untrusted, spillKey('session-a'))), true)
})

test('skips an untrusted configured spill root', { skip: process.platform === 'win32' }, async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  const spillRoot = join(home, 'spill-roots', 'custom-spill')
  const spillDirectory = join(spillRoot, spillKey('session-a'))
  await mkdir(spillDirectory, { recursive: true })
  await writeFile(join(spillDirectory, 'result.txt'), 'full result')
  await chmod(spillRoot, 0o777)
  const ctx = ctxWith(
    persistenceOf([{ header: snapshot('session-a').header, events: [headerEvent()] }]),
    { spillStore: { root: spillRoot, config: { root: spillRoot } } },
  )

  const result = await deleteSession(ctx, 'session-a')

  assert.equal(result.spill.status, 'unverified')
  assert.equal(result.spill.deleted, 0)
  assert.equal(await exists(spillDirectory), true)
})

test('does not scan sibling spill roots when the backend root is configured', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  const parent = join(home, 'spill-roots')
  const current = join(parent, 'custom-spill')
  const sibling = join(parent, 'dsh-spill-other')
  for (const root of [current, sibling]) {
    const directory = join(root, spillKey('session-a'))
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'result.txt'), 'full result')
  }
  const ctx = ctxWith(
    persistenceOf([{ header: snapshot('session-a').header, events: [headerEvent()] }]),
    { spillStore: { root: current, config: { root: current } } },
  )

  const result = await deleteSession(ctx, 'session-a')

  assert.equal(result.spill.deleted, 1)
  assert.equal(await exists(join(current, spillKey('session-a'))), false)
  assert.equal(await exists(join(sibling, spillKey('session-a'))), true)
})

test('reports reminders already removed when a later liveness check refuses', async (t) => {
  const home = await makeHome(t)
  const directory = await addSessionDirectory(home, 'session-a')
  let live = false
  const tasks = [{ id: 'delete-me', target: { kind: 'session', sessionId: 'session-a' } }]
  const schedule = {
    async catalog() {
      return tasks
    },
    async edit(request) {
      tasks.splice(0)
      live = true
      return { id: request.id, deleted: true }
    },
  }
  const ctx = ctxWith(
    persistenceOf([{ header: snapshot('session-a').header, events: [headerEvent()] }]),
    {
      schedule,
      sessions: {
        get: (id) => (live && id === 'session-a' ? { id } : undefined),
        list: () => [],
      },
    },
  )

  const result = await deleteSession(ctx, 'session-a')

  assert.equal(result.ok, false)
  assert.equal(result.code, 'live')
  assert.equal(result.schedules, 1)
  assert.equal(await exists(directory), true)
})

test('reports reminders removed before a later reminder failure', async (t) => {
  const home = await makeHome(t)
  const directory = await addSessionDirectory(home, 'session-a')
  const tasks = [
    { id: 'delete-me', target: { kind: 'session', sessionId: 'session-a' } },
    { id: 'stuck', target: { kind: 'session', sessionId: 'session-a' } },
  ]
  const schedule = {
    async catalog() {
      return tasks
    },
    async edit(request) {
      if (request.id === 'stuck') throw new Error('schedule write failed')
      tasks.splice(tasks.findIndex((task) => task.id === request.id), 1)
      return { id: request.id, deleted: true }
    },
  }
  const ctx = ctxWith(
    persistenceOf([{ header: snapshot('session-a').header, events: [headerEvent()] }]),
    { schedule },
  )

  const result = await deleteSession(ctx, 'session-a')

  assert.equal(result.ok, false)
  assert.equal(result.code, 'schedule-failed')
  assert.equal(result.schedules, 1)
  assert.equal(await exists(directory), true)
})

test('clears stale workspace membership, archive, and pin entries after a successful delete', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  const calls = []
  const workspace = {
    sessionIds: ['session-a'],
    async detachSession(id) { calls.push(`detach:${id}`) },
  }
  const workspaceRegistry = {
    archivedSessionIds: ['session-a'],
    pinnedSessionIds: ['session-a'],
    list: () => [workspace],
    async unarchiveSession(id) { calls.push(`unarchive:${id}`) },
    async unpinSession(id) { calls.push(`unpin:${id}`) },
  }
  const ctx = ctxWith(
    persistenceOf([{ header: snapshot('session-a').header, events: [headerEvent()] }]),
    { workspaceRegistry },
  )

  const result = await deleteSession(ctx, 'session-a')

  assert.equal(result.ok, true)
  assert.deepEqual(calls, ['detach:session-a', 'unarchive:session-a', 'unpin:session-a'])
})

test('ignores legacy reminders that target another session', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  const schedule = {
    async catalog() {
      return [{ id: 'legacy-other', sessionId: 'session-b' }]
    },
    async edit() {
      throw new Error('unrelated legacy reminder must not be edited')
    },
  }
  const ctx = ctxWith(
    persistenceOf([{ header: snapshot('session-a').header, events: [headerEvent()] }]),
    { schedule },
  )

  const result = await deleteSession(ctx, 'session-a')

  assert.equal(result.ok, true)
})

test('deletes ids containing separators and tilde through the JSONL encoding', async (t) => {
  const home = await makeHome(t)
  const id = 'a/b~c'
  const directory = await addSessionDirectory(home, encodeSessionId(id))
  const ctx = ctxOf(persistenceOf([{ header: snapshot(id).header, events: [headerEvent()] }]))

  const result = await deleteSession(ctx, id)

  assert.equal(result.ok, true)
  assert.deepEqual(result.deleted, [id])
  assert.equal(await exists(directory), false)
})
