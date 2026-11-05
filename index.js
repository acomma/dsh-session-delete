/**
 * Host half of the Session Delete bundle.
 *
 * DSH archives Sessions but deliberately ships no deletion API: the persistence
 * seam stores one log per Session and documents that "nothing deletes session
 * files". This plugin adds two narrow operations, both reachable through
 * authenticated Fetch routes and both refusing live work:
 *
 * - delete one stored Session log together with its subagent descendants;
 * - purge every deletable Session a Workspace owns, so the shipped "delete
 *   workspace" action can offer to take the logs with the registration.
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
/** Absolute Fetch path of the workspace cascade; the browser calls the document-relative form. */
const WORKSPACE_ROUTE = '/api/workspace.purge-sessions'
/** Safe stored-session id: one path segment, no traversal, no separators. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
/** Safe workspace registration id: the UUID shape the Workspace registry mints. */
const WORKSPACE_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
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
  'workspace-invalid-request': 'Expected a JSON body with a workspaceId string and deleteSessions: true.',
  'workspace-invalid-id': 'The workspace id is not a registry workspace id.',
  'workspace-unavailable': 'The Workspace registry is not mounted in this profile.',
  'workspace-not-found': 'No Workspace registration has that id.',
}

/**
 * Register the authenticated deletion routes when the Web carrier and Session
 * persistence are both available. An injection (rather than a hard `inject`)
 * keeps the bundle inactive in profiles without a browser carrier.
 *
 * The workspace route is registered defensively: the single-Session route is
 * this bundle's original contract, so a carrier that refuses the second
 * registration loses the cascade and keeps the Session row menu working.
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
    scope.effect(
      () => {
        try {
          return scope.connection.fetch.register({
            path: WORKSPACE_ROUTE,
            methods: ['POST'],
            requestBody: 'buffered',
            fetch: (request) => respondWorkspace(scope, request),
          })
        } catch (error) {
          scope.logger?.warn?.(`session-delete: workspace purge route unavailable: ${String(error)}`)
          return () => {}
        }
      },
      'session-delete: authenticated workspace purge route',
    )
  })
}

/**
 * Read one request body, reporting an unparseable one as undefined.
 * @param request - the authenticated Fetch request.
 * @returns the parsed JSON body, or undefined when it is not JSON.
 */
async function readJson(request) {
  try {
    return await request.json()
  } catch {
    return undefined
  }
}

/**
 * Read one deletion request and answer with its JSON result.
 * @param ctx - Host context carrying persistence and optional registries.
 * @param request - the authenticated Fetch request.
 * @returns the HTTP response.
 */
async function respond(ctx, request) {
  const body = await readJson(request)
  if (body === undefined) {
    return json({ ok: false, code: 'invalid-request', message: FAILURE_MESSAGES['invalid-request'] }, 400)
  }
  const result = await deleteSession(ctx, body?.sessionId, { deleteAttachments: body?.deleteAttachments === true })
  return json(result, statusFor(result))
}

/**
 * Read one workspace cascade request and answer with its JSON result.
 *
 * The body must also carry `deleteSessions: true`: without it the built-in
 * workspace delete already does exactly what the caller wants, and a route that
 * silently deleted logs anyway would be a footgun.
 * @param ctx - Host context carrying the Workspace registry and persistence.
 * @param request - the authenticated Fetch request.
 * @returns the HTTP response.
 */
async function respondWorkspace(ctx, request) {
  const body = await readJson(request)
  if (body === undefined || body?.deleteSessions !== true) {
    return json({ ok: false, code: 'workspace-invalid-request', message: FAILURE_MESSAGES['workspace-invalid-request'] }, 400)
  }
  const result = await purgeWorkspaceSessions(ctx, body?.workspaceId, { deleteAttachments: body?.deleteAttachments === true })
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
  const owned = deleteAttachments ? await readAttachmentRefs(persistence, tree) : undefined

  const root = sessionsRoot()
  const deleted = []
  const failed = []

  for (const id of tree) {
    try {
      const outcome = await deleteSessionTree(root, id)
      if (!outcome.found) {
        failed.push({ sessionId: id, code: 'directory-missing' })
        continue
      }
      deleted.push(id)
    } catch (error) {
      failed.push({ sessionId: id, code: 'delete-failed', message: describe(error) })
    }
  }

  if (deleted.length === 0) {
    const code = failed.some((entry) => entry.code === 'delete-failed') ? 'delete-failed' : 'directory-missing'
    return { ...failure(code, sessionId), failed }
  }

  const schedules = await deleteSchedules(ctx, deleted)
  const caches = await deleteProjectionCache(deleted)
  const attachments = owned === undefined ? undefined : await settleAttachments(persistence, tree, deleted, owned)

  // Announce that these Sessions left the catalog so a connected page drops
  // their rows immediately instead of keeping stale rows until a reload.
  for (const id of deleted) {
    try {
      ctx.emit('api-session/removed', id)
    } catch {
      /* observation only */
    }
  }

  const result = {
    ok: failed.length === 0,
    sessionId,
    deleted,
    schedules,
    caches,
    ...(attachments === undefined ? {} : { attachments }),
  }
  if (failed.length > 0) {
    result.code = 'partial'
    result.message = FAILURE_MESSAGES.partial
    result.failed = failed
  }
  return result
}

/**
 * Permanently delete every deletable Session a Workspace owns.
 *
 * The Workspace registration is deliberately left alone: this route only
 * reclaims the Session logs the caller asked to remove with it, so the shipped
 * "delete workspace" action keeps owning the registry write and the client can
 * fall back to it unchanged. Sessions are selected from the registry record's
 * `sessionIds` (the same account the sidebar groups), each expanded to the
 * subagent tree it owns, and a tree is skipped as a whole when anything in it
 * is live: an Agent, an in-memory Session, or a running job still holds the log,
 * and the workspace row can leave while that conversation keeps running.
 * A Session the catalog no longer lists is still attempted by directory, because
 * a stale Workspace record can outlive logs the catalog stopped indexing.
 * @param ctx - Host context carrying the Workspace registry and persistence.
 * @param rawWorkspaceId - requested Workspace registration id.
 * @param options - optional attachment cleanup; it runs only for `deleteAttachments: true`.
 * @returns a structured result; `ok` is false only when a Session delete failed.
 */
export async function purgeWorkspaceSessions(ctx, rawWorkspaceId, options = {}) {
  const deleteAttachments = options?.deleteAttachments === true
  const workspaceId = typeof rawWorkspaceId === 'string' ? rawWorkspaceId.trim() : ''
  if (!WORKSPACE_ID.test(workspaceId)) return failure('workspace-invalid-id')

  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return failure('workspace-unavailable')
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) return failure('unavailable')

  let workspace
  try {
    workspace = registry.get(workspaceId)
  } catch (error) {
    return failure('workspace-unavailable', undefined, describe(error))
  }
  if (workspace === undefined) return failure('workspace-not-found')

  let snapshots
  try {
    snapshots = await persistence.list()
  } catch (error) {
    return failure('list-failed', undefined, describe(error))
  }
  const byId = new Map()
  for (const snapshot of snapshots) byId.set(String(snapshot.header.id), snapshot)

  const recordIds = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []
  const roots = [...new Set(recordIds.map((rawId) => String(rawId)).filter((id) => SESSION_ID.test(id)))]

  // Expand each root's owned subagent tree once; a tree shares its root's fate.
  const trees = new Map()
  const everyId = new Set()
  for (const root of roots) {
    const ids = byId.has(root) ? collectTree(byId, root) : [root]
    trees.set(root, ids)
    for (const id of ids) everyId.add(id)
  }

  const targets = []
  const skipped = []
  for (const root of roots) {
    const live = findLive(ctx, trees.get(root))
    if (live === undefined) targets.push(root)
    else skipped.push({ sessionId: root, reason: live.reason, liveSessionId: live.sessionId })
  }

  const deletable = new Set()
  for (const root of targets) for (const id of trees.get(root)) deletable.add(id)

  // Read what the doomed Sessions reference while their logs still exist.
  const owned = deleteAttachments ? await readAttachmentRefs(persistence, [...deletable]) : undefined

  const root = sessionsRoot()
  const deleted = []
  const missing = []
  const failed = []
  for (const id of deletable) {
    try {
      const outcome = await deleteSessionTree(root, id)
      if (!outcome.found) {
        missing.push({ sessionId: id })
        continue
      }
      deleted.push(id)
    } catch (error) {
      failed.push({ sessionId: id, code: 'delete-failed', message: describe(error) })
    }
  }

  const deletedSet = new Set(deleted)
  const rootSet = new Set(roots)
  const rootsDeleted = targets.filter((id) => trees.get(id).every((child) => deletedSet.has(child)))
  const sessions = {
    total: roots.length,
    deleted,
    rootsDeleted,
    skipped,
    missing,
    failed,
    descendantsDeleted: deleted.filter((id) => !rootSet.has(id)).length,
  }

  if (deleted.length === 0 && failed.length > 0) {
    return { ...failure('delete-failed'), workspaceId, sessions }
  }

  const schedules = await deleteSchedules(ctx, deleted)
  const caches = await deleteProjectionCache(deleted)
  // The skipped trees are passed in `tree` but not in `deleted`: their logs are
  // still a reference source, so any object they share with a removed Session is kept.
  const attachments = owned === undefined
    ? undefined
    : await settleAttachments(persistence, [...everyId], deleted, owned)

  // Announce the removals so a connected page drops the rows immediately.
  for (const id of deleted) {
    try {
      ctx.emit('api-session/removed', id)
    } catch {
      /* observation only */
    }
  }

  if (failed.length > 0) {
    return {
      ...failure('partial'),
      workspaceId,
      sessions,
      schedules,
      caches,
      ...(attachments === undefined ? {} : { attachments }),
    }
  }

  return {
    ok: true,
    workspaceId,
    workspace: { title: String(workspace.title), path: String(workspace.path) },
    sessions,
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
 * @param persistence - Session persistence service.
 * @param sessionIds - the tree being deleted.
 * @returns refs per Session id, plus the ids that could not be read.
 */
async function readAttachmentRefs(persistence, sessionIds) {
  const refs = new Map()
  const unreadable = []
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
 * @param persistence - Session persistence service.
 * @param sessionId - stored Session to read.
 * @returns the attachment ids the Session references.
 */
async function readSessionAttachmentRefs(persistence, sessionId) {
  const refs = new Set()
  await forEachEventBatch(persistence, sessionId, undefined, (events) => {
    walkAttachmentRefs(events, (attachmentId) => {
      refs.add(attachmentId)
    })
  })
  return refs
}

/**
 * Stream one stored Session's event batches through the persistence seam.
 *
 * The seam is the only reader that decodes the compressed, possibly migrated
 * log. Progress follows the event sequence numbers so a backend slice can never
 * stall, and the final empty read ends the walk.
 * @param persistence - Session persistence service.
 * @param sessionId - stored Session to read.
 * @param options - optional cancellation forwarded to the open and read calls.
 * @param visit - called with each non-empty batch; return true to stop early.
 */
async function forEachEventBatch(persistence, sessionId, options, visit) {
  const handle = await persistence.open(sessionId, 'read', options)
  try {
    let offset = 0
    for (;;) {
      const { events } = await handle.read(offset, REFERENCE_READ_CHUNK, options)
      if (events.length === 0) return
      if (visit(events) === true) return
      offset = events[events.length - 1].seq + 1
    }
  } finally {
    await handle.close().catch(() => {})
  }
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
 * @param persistence - Session persistence service.
 * @param tree - the Session ids the deletion addressed.
 * @param deletedIds - Sessions whose directory this request removed.
 * @param owned - attachment refs per tree Session, read before deletion.
 * @returns the attachment report carried by the response.
 */
async function settleAttachments(persistence, tree, deletedIds, owned) {
  const report = { status: 'applied', deleted: 0, kept: 0, failed: 0, missing: 0, bytes: 0 }
  if (owned.unreadable.length > 0) return { ...report, status: 'unverified', reason: 'unreadable' }

  const deleted = new Set(deletedIds)
  const candidates = new Set()
  for (const id of deletedIds) {
    const refs = owned.refs.get(id)
    if (refs === undefined) continue
    for (const attachmentId of refs) candidates.add(attachmentId)
  }
  if (candidates.size === 0) return report

  // `pending` is the candidates minus every reference a surviving Session still
  // holds, so it also answers "was this candidate kept?" at the end.
  const pending = new Set(candidates)
  // A Session whose directory survived still owns every reference it held.
  for (const id of tree) {
    if (deleted.has(id)) continue
    const refs = owned.refs.get(id)
    if (refs === undefined) continue
    for (const attachmentId of refs) pending.delete(attachmentId)
  }

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
      for (const attachmentId of found) pending.delete(attachmentId)
    }
  } finally {
    clearTimeout(timer)
  }

  const root = attachmentsRoot()
  for (const attachmentId of candidates) {
    if (!pending.has(attachmentId)) {
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
  await forEachEventBatch(persistence, sessionId, { signal }, (events) => {
    walkAttachmentRefs(events, (attachmentId) => {
      if (pending.has(attachmentId)) found.add(attachmentId)
    })
    return found.size === pending.size
  })
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
  const targets = [
    { path: join(root, 'objects', bucket, digest), directory: false },
    { path: join(root, 'file-objects', bucket, digest), directory: false },
    { path: join(root, 'files', bucket, digest), directory: true },
  ]
  let found = false
  let bytes = 0

  for (const target of targets) {
    const entry = await statOrUndefined(target.path)
    if (entry === undefined || entry.isSymbolicLink()) continue
    if (target.directory ? !entry.isDirectory() : !entry.isFile()) continue
    if (!target.directory) bytes += entry.size
    await rm(target.path, { recursive: target.directory, force: true })
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
 * @returns root first, then the id of each owned descendant.
 */
function collectTree(byId, rootId) {
  const childrenOf = new Map()
  for (const [id, snapshot] of byId) {
    if (snapshot.header.origin !== 'subagent') continue
    const parentId = String(snapshot.header.parentSession ?? '')
    const children = childrenOf.get(parentId)
    if (children === undefined) childrenOf.set(parentId, [id])
    else children.push(id)
  }

  const tree = []
  const seen = new Set()
  const queue = [{ id: rootId, depth: 0 }]
  while (queue.length > 0) {
    const { id, depth } = queue.shift()
    if (seen.has(id)) continue
    seen.add(id)
    tree.push(id)
    if (depth >= MAX_TREE_DEPTH) continue
    for (const childId of childrenOf.get(id) ?? []) {
      if (!seen.has(childId)) queue.push({ id: childId, depth: depth + 1 })
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
 * @param sessionIds - Sessions about to be deleted.
 * @returns the live Session id and what holds it, or undefined when every one is cold.
 */
function findLive(ctx, sessionIds) {
  const agents = ctx.get('agents')
  const sessions = ctx.get('sessions')
  const jobs = ctx.get('jobs')
  for (const id of sessionIds) {
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
 * @param sessionIds - Sessions being deleted.
 * @returns the number of removed reminders.
 */
async function deleteSchedules(ctx, sessionIds) {
  const schedule = ctx.get('schedule')
  if (schedule === undefined) return 0
  let removed = 0
  for (const id of sessionIds) {
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
 * @param sessionIds - Sessions being deleted.
 * @returns the number of removed cache files.
 */
async function deleteProjectionCache(sessionIds) {
  const directory = join(dshHome(), 'storages', 'session_projcache', 'sessions')
  let entries
  try {
    entries = await readdir(directory)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of entries) {
    for (const id of sessionIds) {
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
function sessionsRoot() {
  return join(dshHome(), 'sessions')
}

/**
 * Find a stored Session's own directory without trusting a constructed path.
 * @param root - the sessions root.
 * @param sessionId - safe stored Session id.
 * @returns the absolute Session directory, or undefined when absent.
 */
async function locateSessionDirectory(root, sessionId) {
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
    const info = await statOrUndefined(directory)
    if (info === undefined || !info.isDirectory() || info.isSymbolicLink()) continue
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
async function deleteSessionTree(root, sessionId) {
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
    case 'workspace-invalid-request':
    case 'workspace-invalid-id':
      return 400
    case 'not-found':
    case 'workspace-not-found':
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
