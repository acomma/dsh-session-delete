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
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  return { header: { id, version: 3, createdAt: 1, cwd: 'C:/work' }, revision: `rev-${id}`, sizeBytes: 16 }
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
  return {
    emitted,
    get(name) {
      if (name === 'sessionPersistence') return persistence
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
  assert.deepEqual(result.attachments, { status: 'applied', deleted: 1, kept: 0, failed: 0, missing: 0, bytes: 9 })
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

  assert.equal(result.ok, false)
  assert.equal(result.code, 'partial')
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

test('names a running job as the reason a deletion is refused', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  const persistence = persistenceOf([
    { header: snapshot('session-a').header, events: [headerEvent()] },
  ])
  const ctx = ctxWith(persistence, { jobs: { list: () => [{ id: 'job-1', status: 'running' }] } })

  const result = await deleteSession(ctx, 'session-a')

  assert.equal(result.code, 'live')
  assert.equal(result.reason, 'job')
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
  assert.deepEqual(ctx.emitted, [
    ['api-session/removed', 'session-a'],
    ['api-session/removed', 'session-child'],
  ])
})

test('does not announce a session whose directory survived', async (t) => {
  const home = await makeHome(t)
  await addSessionDirectory(home, 'session-a')
  const persistence = persistenceOf([
    { header: snapshot('session-a').header, events: [headerEvent()] },
    { header: { ...snapshot('session-child').header, origin: 'subagent', parentSession: 'session-a' }, events: [headerEvent()] },
  ])
  const ctx = ctxOf(persistence)

  const result = await deleteSession(ctx, 'session-a')

  assert.equal(result.code, 'partial')
  assert.deepEqual(ctx.emitted, [['api-session/removed', 'session-a']])
})
