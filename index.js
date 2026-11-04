/**
 * Host half of the Session Delete bundle.
 *
 * DSH archives Sessions but deliberately ships no deletion API: the persistence
 * seam stores one log per Session and documents that "nothing deletes session
 * files". This plugin adds exactly one narrow operation, reachable from the
 * Session row menu in the Web UI through an authenticated Fetch route. It
 * refuses a live Session, and deletes a cold Session's stored log together
 * with the logs of its subagent descendants.
 *
 * The session log directory is the only authoritative Session artifact. Derived
 * caches and shared attachment blobs live elsewhere. On request the caller may
 * also reclaim attachment objects, but only those no surviving Session
 * references: an attachment is content-addressed and immutable, so resumed and
 * forked Sessions may share it (see README.md).
 */
import { lstat, readdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Absolute Fetch path; the browser calls the document-relative `api/session.delete`. */
const ROUTE = '/api/session.delete'
/** Safe stored-session id: one path segment, no traversal, no separators. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
/** Guards a pathological lineage against an unbounded walk. */
const MAX_TREE_DEPTH = 64
/** Durable attachment identity: the content addresses recorded in a Session log. */
const ATTACHMENT_ID = /^sha256:[a-f0-9]{64}$/
/** Logical events per persistence read while counting attachment references. */
const REFERENCE_READ_CHUNK = 2000
/** Bound on the reference scan; after it nothing is deleted, because an unfinished count proves nothing. */
const REFERENCE_SCAN_BUDGET_MS = 30000

const FAILURE_MESSAGES = {
  'invalid-request': 'Expected a JSON body with a sessionId string.',
  'invalid-id': 'The session id is not a safe stored-session id.',
  unavailable: 'Session persistence is not mounted in this profile.',
  'not-found': 'No stored session has that id.',
  live: 'The session is live. Close it and stop its work before deleting it.',
  'directory-missing': 'The stored session has no directory under the session root.',
  'delete-failed': 'The session directory could not be deleted.',
  partial: 'Some session files could not be deleted; see the deleted and failed lists.',
  'list-failed': 'The stored session list could not be read.',
}

/**
 * Register the authenticated deletion route when the Web carrier and Session
 * persistence are both available. An injection (rather than a hard `inject`)
 * keeps the bundle inactive in profiles without a browser carrier.
 * @param ctx - the composed Host context.
 */
export function apply(ctx) {
  ctx.inject(['sessionPersistence', 'connection'], (scope) => {
    scope.effect(
      () => scope.connection.fetch.register({
        path: ROUTE,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: (request) => respond(scope, request),
      }),
      'session-delete: authenticated deletion route',
    )
  })
}

/**
 * Read one deletion request and answer with its JSON result.
 * @param ctx - Host context carrying persistence and optional registries.
 * @param request - the authenticated Fetch request.
 * @returns the HTTP response.
 */
async function respond(ctx, request) {
  let body
  try {
    body = await request.json()
  } catch {
    return json({ ok: false, code: 'invalid-request', message: FAILURE_MESSAGES['invalid-request'] }, 400)
  }
  const result = await deleteSession(ctx, body?.sessionId, { deleteAttachments: body?.deleteAttachments === true })
  return json(result, statusFor(result))
}

/**
 * Permanently delete one stored Session and its subagent descendants.
 *
 * Order: resolve the stored tree, refuse anything live, read the attachment
 * references the tree owns, remove the Session log directories, then remove the
 * binding reminders and derived projection cache records. When the caller asked
 * for attachment cleanup, objects that only the deleted Sessions reference are
 * removed afterwards; every surviving Session's log is the reference source.
 * Only a Session that is neither in the live Session store nor held by a live
 * Agent nor running a background job may be deleted.
 * @param ctx - Host context carrying the services the deletion uses.
 * @param rawSessionId - requested Session id.
 * @param options - optional attachment cleanup; it runs only for `deleteAttachments: true`.
 * @returns a structured result; `ok` is false for every refusal or partial delete.
 */
export async function deleteSession(ctx, rawSessionId, options = {}) {
  const deleteAttachments = options?.deleteAttachments === true
  const sessionId = typeof rawSessionId === 'string' ? rawSessionId.trim() : ''
  if (!SESSION_ID.test(sessionId)) return failure('invalid-id', sessionId)

  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) return failure('unavailable')

  let snapshots
  try {
    snapshots = await persistence.list()
  } catch (error) {
    return failure('list-failed', sessionId, describe(error))
  }

  const byId = new Map()
  for (const snapshot of snapshots) byId.set(String(snapshot.header.id), snapshot)
  if (!byId.has(sessionId)) return failure('not-found', sessionId)

  const tree = collectTree(byId, sessionId)
  const live = findLive(ctx, tree)
  if (live !== undefined) return { ...failure('live', live.sessionId), reason: live.reason }

  // Read what the tree references while its logs still exist: after the
  // directories are gone nothing can name the attachments that were in them.
  const owned = deleteAttachments ? await readAttachmentRefs(ctx, tree.map((entry) => entry.id)) : undefined

  const root = sessionsRoot()
  const deleted = []
  const failed = []
  let bytes = 0

  for (const entry of tree) {
    try {
      const outcome = await deleteSessionTree(root, entry.id)
      if (!outcome.found) {
        failed.push({ sessionId: entry.id, code: 'directory-missing' })
        continue
      }
      deleted.push(entry.id)
      bytes += entry.bytes
    } catch (error) {
      failed.push({ sessionId: entry.id, code: 'delete-failed', message: describe(error) })
    }
  }

  if (deleted.length === 0) {
    const code = failed.some((entry) => entry.code === 'delete-failed') ? 'delete-failed' : 'directory-missing'
    return { ...failure(code, sessionId), failed }
  }

  const removedEntries = tree.filter((entry) => deleted.includes(entry.id))
  const schedules = await deleteSchedules(ctx, removedEntries)
  const caches = await deleteProjectionCache(removedEntries)
  const attachments = owned === undefined ? undefined : await settleAttachments(ctx, tree, deleted, owned)

  // Announce that these Sessions left the catalog so a connected page drops
  // their rows immediately. The page then opens a neighbouring Session, and
  // merely following one makes the Host resume an Agent for it
  // (SessionController.promote), so that neighbour becomes live and cannot be
  // deleted until the process restarts. Immediate row removal is the chosen
  // trade-off: the alternative keeps stale rows that Desktop cannot refresh.
  for (const id of deleted) {
    try {
      ctx.emit('api-session/removed', id)
    } catch {
      /* observation only */
    }
  }

  if (failed.length > 0) {
    return {
      ok: false,
      code: 'partial',
      message: FAILURE_MESSAGES.partial,
      sessionId,
      deleted,
      failed,
      bytes,
      schedules,
      caches,
      ...(attachments === undefined ? {} : { attachments }),
    }
  }

  return {
    ok: true,
    sessionId,
    deleted,
    bytes,
    schedules,
    caches,
    ...(attachments === undefined ? {} : { attachments }),
  }
}

/**
 * Read the attachment references every Session of the deleted tree owns.
 *
 * The read happens before any directory is removed. A Session whose log cannot
 * be read leaves the cleanup unverified: not knowing its references is not the
 * same as knowing it has none.
 * @param ctx - Host context carrying Session persistence.
 * @param sessionIds - the tree being deleted.
 * @returns refs per Session id, plus the ids that could not be read.
 */
async function readAttachmentRefs(ctx, sessionIds) {
  const persistence = ctx.get('sessionPersistence')
  const refs = new Map()
  const unreadable = []
  if (persistence === undefined) return { refs, unreadable: [...sessionIds] }
  for (const id of sessionIds) {
    try {
      refs.set(id, await readSessionAttachmentRefs(persistence, id))
    } catch {
      unreadable.push(id)
    }
  }
  return { refs, unreadable }
}

/**
 * Collect every durable attachment reference from one stored Session log.
 *
 * Reads go through the persistence seam, which is the only reader that decodes
 * the compressed, possibly migrated log. The final read is empty, and progress
 * follows the event sequence numbers so a backend slice can never stall.
 * @param persistence - Session persistence service.
 * @param sessionId - stored Session to read.
 * @returns the attachment ids the Session references.
 */
async function readSessionAttachmentRefs(persistence, sessionId) {
  const refs = new Set()
  const handle = await persistence.open(sessionId, 'read')
  try {
    let offset = 0
    for (;;) {
      const { events } = await handle.read(offset, REFERENCE_READ_CHUNK)
      if (events.length === 0) break
      walkAttachmentRefs(events, (attachmentId) => {
        refs.add(attachmentId)
      })
      offset = events[events.length - 1].seq + 1
    }
  } finally {
    await handle.close().catch(() => {})
  }
  return refs
}

/**
 * Visit every durable attachment reference in a batch of events.
 *
 * The walk is shape-driven on purpose: any object carrying a valid
 * `attachmentId` counts, wherever an event, message, or future content block
 * nests it, so a reader cannot silently miss a shape it does not know.
 * @param roots - event values to traverse.
 * @param visit - called with each attachment id.
 */
function walkAttachmentRefs(roots, visit) {
  const stack = [...roots]
  while (stack.length > 0) {
    const value = stack.pop()
    if (value === null || typeof value !== 'object') continue
    if (Array.isArray(value)) {
      for (const item of value) stack.push(item)
      continue
    }
    const attachmentId = value.attachmentId
    if (typeof attachmentId === 'string' && ATTACHMENT_ID.test(attachmentId)) visit(attachmentId)
    for (const key of Object.keys(value)) {
      const child = value[key]
      if (child !== null && typeof child === 'object') stack.push(child)
    }
  }
}

/**
 * Remove the attachment objects that only the deleted Sessions referenced.
 *
 * One rule: an object referenced by any Session that survives the deletion stays,
 * because attachments are content-addressed and immutable, so resumed and forked
 * Sessions share them. A Session whose directory survived counts as surviving, and
 * a catalog that cannot be read in full keeps every object — an unproven absence
 * of references is not proof. The scan stops early once every candidate is known
 * to be shared, and is budgeted so a huge catalog degrades to "keep everything"
 * instead of blocking the deletion.
 * @param ctx - Host context carrying Session persistence.
 * @param tree - the Session tree the deletion addressed.
 * @param deletedIds - Sessions whose directory this request removed.
 * @param owned - attachment refs per tree Session, read before deletion.
 * @returns the attachment report carried by the response.
 */
async function settleAttachments(ctx, tree, deletedIds, owned) {
  const report = { status: 'applied', requested: true, deleted: 0, kept: 0, failed: 0, missing: 0, bytes: 0 }
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) return { ...report, status: 'unverified', reason: 'unavailable' }
  if (owned.unreadable.length > 0) return { ...report, status: 'unverified', reason: 'unreadable' }

  const candidates = new Set()
  for (const id of deletedIds) {
    const refs = owned.refs.get(id)
    if (refs === undefined) continue
    for (const attachmentId of refs) candidates.add(attachmentId)
  }
  if (candidates.size === 0) return report

  const deleted = new Set(deletedIds)
  const referenced = new Set()
  // A Session whose directory survived still owns every reference it held.
  for (const entry of tree) {
    if (deleted.has(entry.id)) continue
    const refs = owned.refs.get(entry.id)
    if (refs === undefined) continue
    for (const attachmentId of refs) if (candidates.has(attachmentId)) referenced.add(attachmentId)
  }

  const pending = new Set(candidates)
  for (const attachmentId of referenced) pending.delete(attachmentId)

  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new Error('attachment reference scan exceeded its budget')),
    REFERENCE_SCAN_BUDGET_MS,
  )
  try {
    let snapshots
    try {
      snapshots = await persistence.list({ signal: controller.signal })
    } catch {
      return { ...report, status: 'unverified', reason: controller.signal.aborted ? 'timeout' : 'unreadable' }
    }
    for (const snapshot of snapshots) {
      if (pending.size === 0) break
      const id = String(snapshot.header.id)
      if (deleted.has(id) || owned.refs.has(id)) continue
      let found
      try {
        found = await scanSessionForAttachments(persistence, id, pending, controller.signal)
      } catch {
        return { ...report, status: 'unverified', reason: controller.signal.aborted ? 'timeout' : 'unreadable' }
      }
      for (const attachmentId of found) {
        referenced.add(attachmentId)
        pending.delete(attachmentId)
      }
    }
  } finally {
    clearTimeout(timer)
  }

  const root = attachmentsRoot()
  for (const attachmentId of candidates) {
    if (referenced.has(attachmentId)) {
      report.kept += 1
      continue
    }
    try {
      const outcome = await deleteAttachmentObject(root, attachmentId)
      if (outcome.found) {
        report.deleted += 1
        report.bytes += outcome.bytes
      } else {
        report.missing += 1
      }
    } catch {
      report.failed += 1
    }
  }
  return report
}

/**
 * Find which wanted attachment ids one surviving Session references.
 * @param persistence - Session persistence service.
 * @param sessionId - stored Session to read.
 * @param pending - ids still unaccounted for.
 * @param signal - cancellation for the completed reference check.
 * @returns the wanted ids found in this Session.
 */
async function scanSessionForAttachments(persistence, sessionId, pending, signal) {
  const found = new Set()
  const handle = await persistence.open(sessionId, 'read', { signal })
  try {
    let offset = 0
    for (;;) {
      const { events } = await handle.read(offset, REFERENCE_READ_CHUNK, { signal })
      if (events.length === 0) break
      walkAttachmentRefs(events, (attachmentId) => {
        if (pending.has(attachmentId)) found.add(attachmentId)
      })
      offset = events[events.length - 1].seq + 1
      if (found.size === pending.size) break
    }
  } finally {
    await handle.close().catch(() => {})
  }
  return found
}

/**
 * Remove one attachment's durable objects.
 *
 * Images live at `objects/<digest>`. Generic files have a canonical
 * `file-objects/<digest>` plus a hard-link alias directory `files/<digest>/`
 * keyed by display name; removing the aliases costs no extra bytes because the
 * canonical object is removed in the same call. Only the digest spelling
 * validated by {@link ATTACHMENT_ID} reaches a path.
 * @param root - the attachment store root.
 * @param attachmentId - validated durable attachment id.
 * @returns whether anything was removed and the bytes the canonical objects held.
 */
async function deleteAttachmentObject(root, attachmentId) {
  if (!ATTACHMENT_ID.test(attachmentId)) return { found: false, bytes: 0 }
  const digest = attachmentId.slice('sha256:'.length)
  const bucket = digest.slice(0, 2)
  let found = false
  let bytes = 0

  const imagePath = join(root, 'objects', bucket, digest)
  const image = await statOrUndefined(imagePath)
  if (image !== undefined && image.isFile() && !image.isSymbolicLink()) {
    bytes += image.size
    await rm(imagePath, { force: true })
    found = true
  }

  const objectPath = join(root, 'file-objects', bucket, digest)
  const object = await statOrUndefined(objectPath)
  if (object !== undefined && object.isFile() && !object.isSymbolicLink()) {
    bytes += object.size
    await rm(objectPath, { force: true })
    found = true
  }

  const aliasPath = join(root, 'files', bucket, digest)
  const alias = await statOrUndefined(aliasPath)
  if (alias !== undefined && alias.isDirectory() && !alias.isSymbolicLink()) {
    await rm(aliasPath, { recursive: true, force: true })
    found = true
  }

  return { found, bytes }
}

/**
 * The versioned durable attachment root below the Harness home.
 * @returns absolute `<dshHome>/attachments/v1`.
 */
function attachmentsRoot() {
  return join(dshHome(), 'attachments', 'v1')
}

/**
 * `lstat` one path, treating absence as undefined.
 * @param path - absolute path.
 * @returns the entry, or undefined when it does not exist.
 */
async function statOrUndefined(path) {
  try {
    return await lstat(path)
  } catch {
    return undefined
  }
}

/**
 * Resolve the stored Session tree rooted at one id.
 *
 * A `parentSession` link alone is lineage (a fork), not ownership, so only
 * descendants carrying `origin: 'subagent'` are included. Those are the hidden
 * child Sessions whose history belongs to the parent and whose deletion is
 * implied by deleting the parent.
 * @param byId - stored snapshots keyed by Session id.
 * @param rootId - requested root Session.
 * @returns root first, then each owned descendant.
 */
function collectTree(byId, rootId) {
  const tree = []
  const seen = new Set()
  const queue = [{ id: rootId, depth: 0 }]
  while (queue.length > 0) {
    const { id, depth } = queue.shift()
    if (seen.has(id)) continue
    seen.add(id)
    const snapshot = byId.get(id)
    if (snapshot === undefined) continue
    tree.push({ id, bytes: snapshot.sizeBytes ?? 0 })
    if (depth >= MAX_TREE_DEPTH) continue
    for (const [candidateId, candidate] of byId) {
      if (candidate.header.origin !== 'subagent') continue
      if (String(candidate.header.parentSession ?? '') !== id) continue
      if (seen.has(candidateId)) continue
      queue.push({ id: candidateId, depth: depth + 1 })
    }
  }
  return tree
}

/**
 * Find the first Session in the tree that still has live work.
 *
 * The reason matters to the user: an Agent or an in-memory Session is normally
 * an open conversation (including an unused "New Session" draft), while a
 * running job needs stopping first. Both make deleting the stored log unsafe.
 * @param ctx - Host context carrying the optional live registries.
 * @param tree - Sessions about to be deleted.
 * @returns the live Session id and what holds it, or undefined when every one is cold.
 */
function findLive(ctx, tree) {
  const agents = ctx.get('agents')
  const sessions = ctx.get('sessions')
  const jobs = ctx.get('jobs')
  for (const { id } of tree) {
    if (agents !== undefined && agents.get(id) !== undefined) return { sessionId: id, reason: 'agent' }
    if (sessions !== undefined && sessions.get(id) !== undefined) return { sessionId: id, reason: 'session' }
    if (jobs === undefined) continue
    try {
      const running = jobs.list(id).find((job) => job.status === 'running' || job.status === 'stopping')
      if (running !== undefined) return { sessionId: id, reason: 'job' }
    } catch {
      /* an unknown or foreign owner is not a live signal */
    }
  }
  return undefined
}

/**
 * Delete every active reminder bound to the Sessions leaving the catalog, so a
 * later delivery cannot recreate a deleted Session log.
 * @param ctx - Host context; the schedule service is optional.
 * @param tree - Sessions being deleted.
 * @returns the number of removed reminders.
 */
async function deleteSchedules(ctx, tree) {
  const schedule = ctx.get('schedule')
  if (schedule === undefined) return 0
  let removed = 0
  for (const { id } of tree) {
    let tasks
    try {
      tasks = await schedule.list({ sessionId: id })
    } catch {
      continue
    }
    for (const task of tasks) {
      try {
        const result = await schedule.delete({ sessionId: id, id: task.id })
        if (result?.deleted === true) removed += 1
      } catch {
        /* best effort; the log deletion is the primary operation */
      }
    }
  }
  return removed
}

/**
 * Remove the per-Session projection checkpoint files for the deleted ids. They
 * are a derived cache, so a failure here never turns a completed deletion into
 * an error; the cache service simply reads a missing record as absent.
 * @param tree - Sessions being deleted.
 * @returns the number of removed cache files.
 */
async function deleteProjectionCache(tree) {
  const directory = join(dshHome(), 'storages', 'session_projcache', 'sessions')
  let entries
  try {
    entries = await readdir(directory)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of entries) {
    for (const { id } of tree) {
      if (name !== `${id}.json` && !name.startsWith(`${id}.json.bak.`)) continue
      try {
        await rm(join(directory, name), { force: true })
        removed += 1
      } catch {
        /* derived cache; ignore */
      }
      break
    }
  }
  return removed
}

/**
 * The session-persistence root this installation uses.
 *
 * The shipped profile mounts the JSONL backend at `DSH_HOME/sessions`; a
 * profile that relocates the backend must set DSH_HOME or keep that layout.
 * @returns the absolute session root.
 */
export function sessionsRoot() {
  const configured = process.env.DSH_HOME?.trim()
  return join(configured && configured !== '' ? configured : join(homedir(), '.dsh'), 'sessions')
}

/**
 * Find a stored Session's own directory without trusting a constructed path.
 * @param root - the sessions root.
 * @param sessionId - safe stored Session id.
 * @returns the absolute Session directory, or undefined when absent.
 */
export async function locateSessionDirectory(root, sessionId) {
  if (!SESSION_ID.test(sessionId)) return undefined
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const project of projects) {
    if (!project.isDirectory() || project.isSymbolicLink()) continue
    const directory = join(root, project.name, sessionId)
    let info
    try {
      info = await lstat(directory)
    } catch {
      continue
    }
    if (!info.isDirectory() || info.isSymbolicLink()) continue
    return directory
  }
  return undefined
}

/**
 * Delete one stored Session directory after proving it is exactly one project
 * child of the sessions root. The containment check keeps a malformed id or a
 * future layout change from turning this into a recursive delete elsewhere.
 * @param root - the sessions root.
 * @param sessionId - safe stored Session id.
 * @returns whether a directory was found and removed.
 */
export async function deleteSessionTree(root, sessionId) {
  const directory = await locateSessionDirectory(root, sessionId)
  if (directory === undefined) return { found: false }
  assertContained(root, directory)
  await rm(directory, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 })
  return { found: true }
}

/**
 * Require `<root>/<project>/<sessionId>` exactly.
 * @param root - the sessions root.
 * @param directory - the candidate Session directory.
 */
function assertContained(root, directory) {
  const base = resolve(root)
  const target = resolve(directory)
  const suffix = relative(base, target)
  if (suffix === '' || suffix.startsWith('..') || isAbsolute(suffix)) {
    throw new Error('refusing to delete outside the session root')
  }
  if (suffix.split(sep).length !== 2) {
    throw new Error('refusing to delete outside a project session directory')
  }
}

/**
 * The home directory the session and storage roots derive from.
 * @returns the configured DSH home or `~/.dsh`.
 */
function dshHome() {
  const configured = process.env.DSH_HOME?.trim()
  return configured && configured !== '' ? configured : join(homedir(), '.dsh')
}

/**
 * Build one failure result.
 * @param code - stable machine-readable failure code.
 * @param sessionId - the addressed Session, when the request named one.
 * @param detail - optional diagnostic carried for the UI and logs.
 * @returns the result object.
 */
function failure(code, sessionId, detail) {
  return {
    ok: false,
    code,
    message: FAILURE_MESSAGES[code] ?? code,
    ...(sessionId === undefined || sessionId === '' ? {} : { sessionId }),
    ...(detail === undefined ? {} : { detail }),
  }
}

/**
 * Map a result to an HTTP status.
 * @param result - deletion result.
 * @returns the status code.
 */
function statusFor(result) {
  if (result.ok) return 200
  switch (result.code) {
    case 'invalid-request':
    case 'invalid-id':
      return 400
    case 'not-found':
      return 404
    case 'live':
    case 'directory-missing':
      return 409
    default:
      return 500
  }
}

/**
 * Write one JSON response without caching.
 * @param body - JSON-serializable body.
 * @param status - HTTP status.
 * @returns the response.
 */
function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/**
 * Describe an unknown thrown value.
 * @param error - the thrown value.
 * @returns a printable message.
 */
function describe(error) {
  return error instanceof Error ? error.message : String(error)
}
