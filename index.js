/**
 * Host half of the Session Delete bundle.
 *
 * DSH archives Sessions but deliberately ships no deletion API: the persistence
 * seam stores one log per Session and documents that "nothing deletes session
 * files". This plugin adds exactly one narrow operation, reachable from the
 * Session row menu in the Web UI through an authenticated Fetch route. It
 * refuses a live Session and a subagent Session addressed as the root, and
 * deletes a cold Session's stored log together with the logs of its subagent
 * descendants.
 *
 * The session log directory is the authoritative Session artifact. Derived
 * caches, local spill directories, and content-addressed attachment blobs live
 * elsewhere. On request the caller may also reclaim attachment objects, but
 * only those no surviving Session references: an attachment is
 * content-addressed and immutable, so resumed and forked Sessions may share it
 * (see README.md). Spill directories are removed only when the refreshed
 * catalog is complete and no surviving Session descends from — or may descend
 * from — the deleted tree, including an ordinary fork that carries only
 * `isSeeded`.
 */
import { createHash } from 'node:crypto'
import { lstat, readdir, realpath, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Absolute Fetch path; the browser calls the document-relative `api/session.delete`. */
const ROUTE = '/api/session.delete'
/**
 * Record keys the JSON storage backend accepts as path segments. Projection
 * cache records use the Session id as their key; an id outside this set has no
 * per-record cache document even though its log is addressable through
 * `encodeSegment`.
 */
const STORAGE_RECORD_KEY = /^[A-Za-z0-9_-]+$/
/** Durable attachment identity: the content addresses recorded in a Session log. */
const ATTACHMENT_ID = /^sha256:[a-f0-9]{64}$/
/** Logical events per persistence read while counting attachment references. */
const REFERENCE_READ_CHUNK = 2000
/** Bound on the whole attachment phase; after it nothing is deleted, because an unfinished count proves nothing. */
const REFERENCE_SCAN_BUDGET_MS = 30000
/** Staged attachment bytes older than this are abandoned writes, not in-flight uploads (generic files have no size limit, so the window is generous). */
const STAGING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
/** Exact `mkdtemp` shape of a default spill root: prefix plus six alphanumeric characters. */
const SPILL_ROOT_NAME = /^dsh-spill-[A-Za-z0-9]{6}$/u
/** In-process guard against overlapping deletion requests for one Session id. */
const inflightDeletions = new Set()
/** Serializes derived cleanup across different Session ids in this process. */
let cleanupTail = Promise.resolve()

const FAILURE_MESSAGES = {
  'invalid-request': 'Expected a JSON body with a sessionId string.',
  'invalid-id': 'The session id must be a non-empty string.',
  busy: 'Another deletion request is already running for this session.',
  unavailable: 'Session persistence is not mounted in this profile.',
  unsupported: 'This session backend has no resolved filesystem root; deletion is unsupported.',
  'not-found': 'No stored session has that id.',
  live: 'The session is live. Close it and stop its work before deleting it.',
  'live-check-failed': 'Liveness could not be determined, so deletion was refused.',
  'subagent-session': 'A subagent Session cannot be deleted on its own; delete its parent Session instead.',
  ambiguous: 'The stored session directory is ambiguous or does not match the catalog.',
  'schedule-failed': 'The session reminders could not be removed; no session files were deleted.',
  'tree-incomplete': 'The stored subagent tree is incomplete: a subagent Session or its directory cannot be identified, so deletion was refused.',
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
  let result
  try {
    result = await deleteSession(ctx, body?.sessionId, { deleteAttachments: body?.deleteAttachments === true })
  } catch (error) {
    result = failure('delete-failed', typeof body?.sessionId === 'string' ? body.sessionId : '', describe(error))
  }
  return json(result, statusFor(result))
}

/**
 * Permanently delete one stored Session and its subagent descendants.
 *
 * Order: resolve the stored tree, refuse a subagent root or anything live,
 * resolve the catalog directories and prove the tree catalog is complete, probe
 * cross-process writers, read attachment references while the logs still exist,
 * re-check liveness, clear reminders, re-check liveness once more, remove child
 * directories before the root, then re-scan the catalog and remove derived
 * caches, spill files, and unshared attachment objects.
 *
 * The root directory is removed last so a child failure leaves the root and a
 * retry can finish the tree. A child directory already absent is treated as
 * already deleted; the root's absence is still a refusal. Even a partial failure
 * cleans up the child directories that were already removed, because their logs
 * are gone and a retry can no longer name their attachments.
 *
 * Only a Session that is neither in the live Session store nor held by a live
 * Agent nor running a background job may be deleted. Reminders targeting the
 * tree are removed before any session directory, because they can activate the
 * Session during deletion. Overlapping in-process requests for the same id are
 * refused with `busy`.
 * @param ctx - Host context carrying the services the deletion uses.
 * @param rawSessionId - requested Session id, used exactly as stored.
 * @param options - optional attachment cleanup (`deleteAttachments`); the internal
 * `attachmentsBudgetMs` and `removeDirectory` overrides exist for tests.
 * @returns a structured result; `ok` is false for every refusal or partial delete.
 */
export async function deleteSession(ctx, rawSessionId, options = {}) {
  if (!isSessionId(rawSessionId)) return failure('invalid-id', typeof rawSessionId === 'string' ? rawSessionId : '')
  if (inflightDeletions.has(rawSessionId)) return failure('busy', rawSessionId)
  inflightDeletions.add(rawSessionId)
  try {
    return await deleteSessionLocked(ctx, rawSessionId, options)
  } finally {
    inflightDeletions.delete(rawSessionId)
  }
}

/**
 * Delete one Session after the exported entry point claimed the in-process
 * guard. Split out so every return path releases that guard.
 * @param ctx - Host context carrying the services the deletion uses.
 * @param sessionId - requested Session id, used exactly as stored.
 * @param options - optional attachment cleanup and test overrides.
 * @returns a structured result; `ok` is false for every refusal or partial delete.
 */
async function deleteSessionLocked(ctx, sessionId, options) {
  const deleteAttachments = options?.deleteAttachments === true

  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) return failure('unavailable')

  const backendName = typeof persistence.name === 'string' ? persistence.name : undefined
  if (backendName !== undefined && backendName !== 'session-persistence-jsonl') {
    return failure('unsupported', sessionId, `session persistence backend "${backendName}" is not the JSONL backend`)
  }
  const locations = resolveLocations(ctx, persistence)
  if (locations.sessionRoot === undefined) {
    return failure('unsupported', sessionId, 'session persistence exposes no resolved filesystem root')
  }

  let snapshots
  try {
    snapshots = await persistence.list()
  } catch (error) {
    return failure('list-failed', sessionId, describe(error))
  }

  const byId = new Map()
  for (const snapshot of snapshots) byId.set(String(snapshot.header.id), snapshot)
  if (!byId.has(sessionId)) return failure('not-found', sessionId)
  if (byId.get(sessionId)?.header?.origin === 'subagent') {
    return failure('subagent-session', sessionId)
  }

  const tree = collectTree(byId, sessionId)
  const live = await checkLive(ctx, tree, byId)
  if (live.error !== undefined) return failure('live-check-failed', sessionId, live.error)
  if (live.session !== undefined) return { ...failure('live', live.session.sessionId), reason: live.session.reason }

  // Resolve every directory before touching any state. A duplicate id or a
  // catalog location that disagrees with the directory tree is refused here.
  const planned = await planSessionDirectories(locations.sessionRoot, tree, byId)
  if (planned.plans === undefined) {
    const result = failure(planned.code, sessionId, planned.detail)
    if (planned.failed !== undefined) result.failed = planned.failed
    return result
  }
  const rootPlan = planned.plans.find((plan) => plan.id === sessionId)
  if (rootPlan?.directory === undefined) {
    return {
      ...failure('directory-missing', sessionId),
      failed: [{ sessionId, code: 'directory-missing' }],
    }
  }

  // A child Session that the current Build cannot read is absent from list().
  // Its directory, or a readable descendant with a missing parent, may still
  // be part of this tree. Refuse before deleting anything rather than leave an
  // orphan subagent Session that this API refuses to delete directly.
  const catalogCheck = await ensureTreeCatalogComplete(
    locations.sessionRoot,
    dirname(rootPlan.directory),
    tree,
    byId,
  )
  if (catalogCheck.code !== undefined) {
    return failure(catalogCheck.code, sessionId, catalogCheck.detail)
  }

  const writer = await probeWriters(persistence, tree, byId)
  if (writer.busy !== undefined) {
    return { ...failure('live', writer.busy), reason: 'writer' }
  }
  if (writer.error !== undefined) return failure('live-check-failed', sessionId, writer.error)

  const budget = deleteAttachments && locations.attachmentsRoot !== undefined
    ? startBudget(options?.attachmentsBudgetMs)
    : undefined
  const removeDirectory = typeof options?.removeDirectory === 'function'
    ? options.removeDirectory
    : removeSessionDirectory

  try {
    // Read what the tree references while its logs still exist: after the
    // directories are gone nothing can name the attachments that were in them.
    // The budget covers this read too, so a huge or stuck log cannot outlive it.
    const owned = budget === undefined ? undefined : await readAttachmentRefs(persistence, tree, budget.signal)

    const stillLive = await checkLive(ctx, tree, byId)
    if (stillLive.error !== undefined) return failure('live-check-failed', sessionId, stillLive.error)
    if (stillLive.session !== undefined) {
      return { ...failure('live', stillLive.session.sessionId), reason: stillLive.session.reason }
    }

    // Reminders can activate a Session without leaving an Agent or Session
    // object in the registries until the delivery starts. Clear them before
    // touching logs, then check liveness again; `edit`/`delete` is serialized
    // behind an already running delivery.
    const scheduleOutcome = await clearSchedules(ctx, tree)
    if (scheduleOutcome.error !== undefined) {
      return withSchedulesRemoved(failure('schedule-failed', sessionId, scheduleOutcome.error), scheduleOutcome.removed)
    }

    const afterSchedules = await checkLive(ctx, tree, byId)
    if (afterSchedules.error !== undefined) {
      return withSchedulesRemoved(failure('live-check-failed', sessionId, afterSchedules.error), scheduleOutcome.removed)
    }
    if (afterSchedules.session !== undefined) {
      return withSchedulesRemoved(
        { ...failure('live', afterSchedules.session.sessionId), reason: afterSchedules.session.reason },
        scheduleOutcome.removed,
      )
    }

    let activity
    try {
      activity = await checkActivity(ctx, tree)
    } catch (error) {
      return withSchedulesRemoved(failure('live-check-failed', sessionId, describe(error)), scheduleOutcome.removed)
    }
    if (activity.session !== undefined) {
      return withSchedulesRemoved(
        { ...failure('live', activity.session.sessionId), reason: activity.session.reason },
        scheduleOutcome.removed,
      )
    }

    const deleted = []
    const failed = []
    const alreadyGone = []

    // Children first; the root is the last directory removed. `collectTree`
    // emits BFS order, so reversing it processes deeper directories before
    // their ancestors. On the first failure we stop rather than delete an
    // ancestor of the failed directory: a retry must still be able to reach
    // that directory through its parent.
    const childPlans = planned.plans.filter((plan) => plan.id !== sessionId)
    for (const plan of [...childPlans].reverse()) {
      if (plan.directory === undefined) {
        alreadyGone.push(plan.id)
        continue
      }
      try {
        await verifySessionDirectory(persistence, plan.id, plan.directory)
        await removeDirectory(locations.sessionRoot, plan.directory, plan.id)
        deleted.push(plan.id)
      } catch (error) {
        failed.push({ sessionId: plan.id, code: 'delete-failed', message: describe(error) })
        break
      }
    }

    if (failed.length === 0) {
      try {
        await verifySessionDirectory(persistence, sessionId, rootPlan.directory)
        await removeDirectory(locations.sessionRoot, rootPlan.directory, sessionId)
        deleted.push(sessionId)
      } catch (error) {
        if (deleted.length === 0
          && error?.code === 'SESSION_GONE'
          && await isSessionGone(persistence, sessionId, rootPlan.directory)) {
          return withSchedulesRemoved(failure('not-found', sessionId), scheduleOutcome.removed)
        }
        failed.push({ sessionId, code: 'delete-failed', message: describe(error) })
      }
    }

    // A partial failure may already have removed child directories. Clean up
    // exactly those ids now: their logs no longer exist, so this is the last
    // point where their attachment, spill, cache, and workspace references can
    // be reclaimed. The surviving root or failed child is still a tree member,
    // so `settleAttachments` keeps every object it references.
    const gone = [...deleted, ...alreadyGone]
    const reports = gone.length === 0
      ? { caches: 0 }
      : await enqueueCleanup(() => cleanupDeletedArtifacts({
          persistence,
          tree,
          deleted,
          gone,
          owned,
          ctx,
          locations,
          signal: budget?.signal,
          deleteAttachments,
        }))

    const base = {
      sessionId,
      deleted,
      schedules: scheduleOutcome.removed,
      ...reports,
    }
    if (failed.length > 0) {
      return { ok: false, code: 'partial', message: FAILURE_MESSAGES.partial, ...base, failed }
    }
    return { ok: true, ...base }
  } finally {
    budget?.stop()
  }
}

/**
 * Run one derived-cleanup pass after every earlier pass in this process.
 *
 * Two deletions of different Sessions can otherwise both observe the other's
 * still-present log and keep a shared attachment. The later serialized pass
 * sees both logs gone (when both deletes succeeded) and can reclaim it.
 * @param task - cleanup work to run.
 * @returns the task result, or its rejection.
 */
function enqueueCleanup(task) {
  const run = cleanupTail.then(task, task)
  cleanupTail = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/**
 * Remove derived state and optional attachment objects for the Sessions that
 * actually left the catalog, including a subtree removed before a later
 * failure. The catalog is refreshed once after the removals so both spill and
 * attachment decisions see the surviving tree.
 * @param options - service, tree, removed ids, owned references, roots, and budget.
 * @returns report fields for the success or partial result.
 */
async function cleanupDeletedArtifacts(options) {
  const { persistence, tree, deleted, gone, owned, ctx, locations, signal, deleteAttachments } = options
  const caches = await deleteProjectionCache(
    locations.storagesRoot,
    locations.projectionCacheRoot,
    gone,
  )
  // A fork created while the deletion ran must be visible to the spill
  // decision, and a new unaccounted session directory must keep attachment
  // cleanup closed. Re-list and re-scan once after the logs are gone.
  const latest = locations.spillRoot !== undefined
    || (owned !== undefined && locations.attachmentsRoot !== undefined)
    ? await refreshCatalog(persistence, locations.sessionRoot)
    : { byId: new Map(), catalog: undefined }
  const spillRoots = await resolveSpillRoots(locations)
  const spill = await deleteSpillDirectories(spillRoots, latest.byId, gone, latest.catalog)
  // Attachment candidates come from directories actually removed. A child
  // directory already absent keeps its referenced objects: without a stored
  // log the references cannot be proven absent. When the attachment service
  // exposes no root the scan is skipped entirely and the report stays
  // fail-closed.
  const attachments = deleteAttachments === false
    ? undefined
    : owned === undefined
      ? unavailableAttachmentReport()
      : await settleAttachments(
          persistence,
          tree,
          deleted,
          owned,
          ctx,
          {
            signal,
            locations,
            catalog: latest.catalog,
            snapshots: [...latest.byId.values()],
          },
        )
  // Workspace archive/pin sets are not pruned by the registry's header
  // refresh. Clear a stale id when the mounted registry exposes the public
  // idempotent operations; failure is only stale derived state.
  await clearWorkspaceSessionState(ctx, gone)

  // Announce that these Sessions left the catalog so a connected page drops
  // their rows immediately instead of keeping stale rows until a reload.
  // Emit in tree order (root first) so the observable order is deterministic.
  const goneSet = new Set(gone)
  for (const id of tree) {
    if (!goneSet.has(id)) continue
    try {
      ctx.emit('api-session/removed', id)
    } catch {
      /* observation only */
    }
  }

  return {
    caches,
    ...(spill === undefined ? {} : { spill }),
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
 * @param signal - cancellation for the shared attachment-phase budget.
 * @returns refs per Session id, plus the ids that could not be read.
 */
async function readAttachmentRefs(persistence, sessionIds, signal) {
  const refs = new Map()
  const unreadable = []
  for (const id of sessionIds) {
    try {
      refs.set(id, await readSessionAttachmentRefs(persistence, id, signal))
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
 * @param signal - cancellation for the shared attachment-phase budget.
 * @returns the attachment ids the Session references.
 */
async function readSessionAttachmentRefs(persistence, sessionId, signal) {
  const refs = new Set()
  await forEachEventBatch(persistence, sessionId, signal === undefined ? undefined : { signal }, (events) => {
    walkAttachmentRefs(events, (attachmentId) => {
      refs.add(attachmentId)
    })
  })
  return refs
}

/**
 * Re-list and re-scan the stored Session root after the deletion.
 *
 * A fork created while the deletion ran, or an unaccounted directory that
 * appeared during it, is an unknown reference for the optional spill and
 * attachment cleanup. A failed refresh is never treated as an empty catalog:
 * the caller keeps every candidate.
 * @param persistence - Session persistence service.
 * @param sessionRoot - the Session persistence root.
 * @returns the refreshed snapshots and catalog findings.
 */
async function refreshCatalog(persistence, sessionRoot) {
  try {
    const snapshots = await persistence.list()
    const byId = new Map()
    for (const snapshot of snapshots) byId.set(String(snapshot.header.id), snapshot)
    return { byId, catalog: await inspectCatalog(sessionRoot, byId) }
  } catch {
    return { byId: new Map(), catalog: { incomplete: true, unaccountedPaths: [], duplicates: [], failedProjects: [] } }
  }
}

/**
 * Compare the stored Session directories with the catalog that was used to
 * prove a reference absent.
 *
 * The catalog is the only name source for attachment cleanup, so a directory it
 * cannot name is an unknown reference and must fail the cleanup closed. The
 * catalog is matched by the backend-resolved artifact path when a snapshot
 * carries one, and by the storage's own segment encoding otherwise; a duplicated
 * id is equally unsafe because only one directory is removed.
 * @param sessionRoot - the Session persistence root.
 * @param known - catalog snapshots keyed by Session id.
 * @returns what makes the catalog incomplete, if anything.
 */
async function inspectCatalog(sessionRoot, known) {
  const result = { incomplete: false, unaccountedPaths: [], duplicates: [], failedProjects: [] }
  const knownDirs = new Set()
  const knownNames = new Set()
  for (const snapshot of known.values()) {
    const path = snapshot?.location?.path
    if (typeof path === 'string' && isAbsolute(path)) knownDirs.add(pathKey(dirname(path)))
    const id = String(snapshot?.header?.id ?? '')
    if (id !== '') knownNames.add(nameKey(encodeSegment(id)))
  }

  let projects
  try {
    projects = await readdir(sessionRoot, { withFileTypes: true })
  } catch {
    return { ...result, incomplete: true }
  }

  const seen = new Map()
  for (const project of projects) {
    if (!project.isDirectory() || project.isSymbolicLink()) continue
    let entries
    try {
      entries = await readdir(join(sessionRoot, project.name), { withFileTypes: true })
    } catch {
      result.incomplete = true
      result.failedProjects.push(join(sessionRoot, project.name))
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const directory = join(sessionRoot, project.name, entry.name)
      const entryKey = nameKey(entry.name)
      if (knownDirs.has(pathKey(directory)) || knownNames.has(entryKey)) {
        const count = (seen.get(entryKey) ?? 0) + 1
        seen.set(entryKey, count)
        if (count === 2) result.duplicates.push(entry.name)
        continue
      }
      const hasArtifact = await hasSessionArtifact(directory)
      if (hasArtifact === undefined) {
        result.incomplete = true
        result.unaccountedPaths.push(directory)
      } else if (hasArtifact) {
        result.unaccountedPaths.push(directory)
      }
    }
  }
  return result
}

/**
 * Prove that the stored subagent forest under one root is completely
 * identifiable before any directory is removed.
 *
 * `sessionPersistence.list()` deliberately skips sessions whose header the
 * current Build cannot read. Such a directory can still be a subagent child of
 * the root, and a readable grandchild can point at a parent that is no longer in
 * the catalog. A subagent with an empty parent link or a cyclic parent chain is
 * equally unresolvable. Deleting the root in any of those cases would leave a
 * hidden orphan (`deleteSession` refuses a subagent as a root), so this check
 * fails closed for the root's project before any attachment read, schedule
 * removal, or `rm`.
 * @param sessionRoot - the session persistence root.
 * @param projectDirectory - the project directory holding the root Session.
 * @param tree - Session ids being deleted, root first.
 * @param byId - catalog snapshots keyed by Session id.
 * @returns an empty object, or a failure code and detail.
 */
async function ensureTreeCatalogComplete(sessionRoot, projectDirectory, tree, byId) {
  let catalog
  try {
    catalog = await inspectCatalog(sessionRoot, byId)
  } catch (error) {
    return { code: 'tree-incomplete', detail: describe(error) }
  }

  const treeNames = new Set(tree.map((id) => nameKey(encodeSegment(id))))
  const duplicateTreeIds = catalog.duplicates.filter((name) => treeNames.has(nameKey(name)))
  if (duplicateTreeIds.length > 0) {
    return {
      code: 'ambiguous',
      detail: `session directories are duplicated: ${duplicateTreeIds.slice(0, 5).join(', ')}`,
    }
  }

  const localUnaccounted = catalog.unaccountedPaths.filter(
    (directory) => samePath(resolve(dirname(directory)), projectDirectory),
  )
  if (localUnaccounted.length > 0) {
    return {
      code: 'tree-incomplete',
      detail: `unreadable session directories in this project: ${localUnaccounted.slice(0, 5).join(', ')}`,
    }
  }

  const failedLocalProject = catalog.failedProjects.some(
    (directory) => samePath(resolve(directory), projectDirectory),
  )
  if (failedLocalProject) {
    return { code: 'tree-incomplete', detail: 'the root project directory cannot be read' }
  }
  // A root-level scan failure leaves no per-project path; refuse rather than
  // treating an unreadable session root as an empty, complete catalog.
  if (catalog.incomplete === true && catalog.failedProjects.length === 0 && catalog.unaccountedPaths.length === 0) {
    return { code: 'tree-incomplete', detail: 'the session root cannot be inspected completely' }
  }

  const treeSet = new Set(tree)
  for (const [id, snapshot] of byId) {
    const header = snapshot?.header
    if (header?.origin !== 'subagent') continue
    if (treeSet.has(id)) continue

    let parentId = typeof header.parentSession === 'string' ? header.parentSession : ''
    const seen = new Set([id])
    let unresolved = parentId === ''
    let descendsFromTree = false
    while (parentId !== '') {
      if (treeSet.has(parentId)) {
        descendsFromTree = true
        break
      }
      if (seen.has(parentId)) {
        // A cycle is a damaged lineage, not a resolved independent owner.
        // Deleting the requested root could leave this subagent unreachable
        // because this API refuses to delete a subagent as a root.
        unresolved = true
        break
      }
      seen.add(parentId)
      const parentSnapshot = byId.get(parentId)
      if (parentSnapshot === undefined) {
        unresolved = true
        break
      }
      // A seeded non-subagent Session is an independent fork; its own
      // subagent children are not owned by the requested root. A non-seeded
      // intermediate without origin is treated as possibly legacy subagent
      // lineage and the chain is followed (fail-closed).
      if (parentSnapshot.header?.origin !== 'subagent'
        && parentSnapshot.header?.isSeeded === true) break
      const nextParent = typeof parentSnapshot.header?.parentSession === 'string'
        ? parentSnapshot.header.parentSession
        : ''
      if (nextParent === '' && parentSnapshot.header?.origin === 'subagent') {
        // A subagent intermediate with no parent link is as unresolvable as a
        // missing parent: the chain cannot prove independent ownership.
        unresolved = true
        break
      }
      parentId = nextParent
    }

    if (descendsFromTree) {
      return {
        code: 'tree-incomplete',
        detail: `subagent session "${id}" descends from the deletion tree but is not included in it`,
      }
    }
    if (!unresolved) continue

    // A subagent inherits its parent's cwd, so an unresolved child in another
    // project cannot descend from this root. A snapshot without a resolved
    // location cannot be ruled out and is kept in the refusal.
    const locationPath = snapshot?.location?.path
    if (typeof locationPath === 'string' && isAbsolute(locationPath)
      && !samePath(resolve(dirname(locationPath)), projectDirectory)) continue

    return {
      code: 'tree-incomplete',
      detail: `subagent session "${id}" has no resolvable parent in the stored catalog`,
    }
  }

  return {}
}

/**
 * Encode one Session id into the single storage path segment the JSONL backend
 * uses (`encodeSegment` in `dsh-session-persistence-jsonl`): ASCII letters,
 * digits, `.`, `_`, and `-` stay literal, every other UTF-16 code unit becomes
 * `~XXXX`. Ids accepted by this plugin are already literal, but the catalog is
 * compared against directories the backend named, so the rule must match exactly.
 * @param raw - Session id.
 * @returns the encoded path segment.
 */
function encodeSegment(raw) {
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
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

/**
 * Whether one stored Session directory holds any entry. A log is the expected
 * artifact, but the directory is Session-owned and may carry future artifacts
 * (including Session-owned subdirectories), so any entry counts: a directory
 * the catalog cannot name must never be silently ignored. An empty directory
 * names nothing and is ignored.
 * @param directory - the candidate Session directory.
 * @returns true/false, or undefined when the directory cannot be read.
 */
async function hasSessionArtifact(directory) {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    return entries.length > 0
  } catch {
    return undefined
  }
}

/**
 * Stream one stored Session's event batches through the persistence seam.
 *
 * The seam is the only reader that decodes the compressed, possibly migrated
 * log. Progress follows the event sequence numbers so a backend slice can never
 * stall, and the final empty read ends the walk. A batch that does not advance
 * the offset is refused instead of re-read forever.
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
      if (events[0].seq !== offset) {
        throw new Error(`session log read skipped from offset ${offset} to seq ${events[0].seq}`)
      }
      if (visit(events) === true) return
      const next = events[events.length - 1].seq + 1
      if (!Number.isSafeInteger(next) || next <= offset) {
        throw new Error(`session log read did not advance (offset ${offset}, seq ${events[events.length - 1].seq})`)
      }
      offset = next
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
 * The fail-closed attachment report used when the attachment service exposes
 * no root, so no object can be proven unreferenced or removed.
 * @returns the report carried by the successful deletion.
 */
function unavailableAttachmentReport() {
  return {
    status: 'unverified',
    reason: 'unavailable',
    deleted: 0,
    kept: 0,
    failed: 0,
    missing: 0,
    bytes: 0,
    staging: 0,
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
 * @param ctx - Host context carrying the optional live Session store.
 * @param options - the shared budget, resolved store roots, catalog findings,
 * and optionally the already-refreshed survivor snapshots.
 * @returns the attachment report carried by the response.
 */
async function settleAttachments(persistence, tree, deletedIds, owned, ctx, options) {
  const report = { status: 'applied', deleted: 0, kept: 0, failed: 0, missing: 0, bytes: 0, staging: 0 }
  if (owned.unreadable.length > 0) {
    return { ...report, status: 'unverified', reason: options.signal.aborted ? 'timeout' : 'unreadable' }
  }
  if (options.catalog.incomplete === true) {
    return { ...report, status: 'unverified', reason: 'catalog' }
  }
  if (options.catalog.unaccountedPaths.length > 0 || options.catalog.duplicates.length > 0) {
    return { ...report, status: 'unverified', reason: 'catalog' }
  }

  const deleted = new Set(deletedIds)
  const candidates = new Set()
  for (const id of deletedIds) {
    const refs = owned.refs.get(id)
    if (refs === undefined) continue
    for (const attachmentId of refs) candidates.add(attachmentId)
  }
  const attachmentsRoot = options.locations.attachmentsRoot
  if (candidates.size === 0) {
    report.staging = await sweepStaging(attachmentsRoot)
    return report
  }

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

  let snapshots
  if (options.snapshots !== undefined) {
    snapshots = options.snapshots
  } else {
    try {
      snapshots = await persistence.list({ signal: options.signal })
    } catch {
      return { ...report, status: 'unverified', reason: options.signal.aborted ? 'timeout' : 'unreadable' }
    }
  }
  for (const snapshot of snapshots) {
    if (pending.size === 0) break
    const id = String(snapshot.header.id)
    if (deleted.has(id) || owned.refs.has(id)) continue
    let live
    try {
      live = ctx.get('sessions')?.get?.(id)
    } catch {
      return { ...report, status: 'unverified', reason: options.signal.aborted ? 'timeout' : 'unreadable' }
    }
    if (live === undefined) {
      // A listed survivor without a materialized artifact has no durable log
      // to scan. That is an unknown reference only while the backend still
      // reports it pending; a materialized older snapshot can be read below.
      if (snapshot.location === undefined && await isPendingSnapshot(persistence, snapshot, options.signal)) {
        return { ...report, status: 'unverified', reason: 'pending' }
      }
      // A materialized Session that is not live in this process may still be
      // live in another process. Its write-behind buffer can hold attachment
      // references that the persisted log does not. A successful write-lease
      // probe proves no such writer exists; a busy/missing/error probe keeps
      // every candidate instead of deleting a possibly-shared object.
      const probe = await probeWriterLease(persistence, snapshot, options.signal)
      if (probe.busy === true || probe.unprobeable === true) {
        return { ...report, status: 'unverified', reason: 'writer' }
      }
      if (probe.error !== undefined || probe.missing === true) {
        return { ...report, status: 'unverified', reason: options.signal.aborted ? 'timeout' : 'unreadable' }
      }
    } else if (live === null || typeof live.snapshotEvents !== 'function') {
      // Without the deprecated in-memory read there is no way to observe a
      // live write-behind buffer; keep every candidate.
      return { ...report, status: 'unverified', reason: 'unreadable' }
    }
    let found
    try {
      // The persisted log is the durable prefix. A live Session additionally
      // carries events still in the routed write-behind buffer, so union its
      // in-memory snapshot instead of choosing one source. `snapshotEvents` is
      // deprecated in DSH, but it remains the only public read of that buffer;
      // an upstream replacement is still required (documented in README).
      found = new Set(await scanSessionForAttachments(persistence, id, pending, options.signal))
      if (live !== undefined && typeof live.snapshotEvents === 'function') {
        walkAttachmentRefs(live.snapshotEvents(), (attachmentId) => {
          if (pending.has(attachmentId)) found.add(attachmentId)
        })
      }
    } catch {
      return { ...report, status: 'unverified', reason: options.signal.aborted ? 'timeout' : 'unreadable' }
    }
    for (const attachmentId of found) pending.delete(attachmentId)
  }

  const realAttachmentRoot = await realpathOrError(attachmentsRoot)
  for (const attachmentId of candidates) {
    if (!pending.has(attachmentId)) {
      report.kept += 1
      continue
    }
    try {
      const outcome = await deleteAttachmentObject(
        attachmentsRoot,
        attachmentId,
        realAttachmentRoot.error === undefined ? realAttachmentRoot.path : undefined,
      )
      report.bytes += outcome.bytes
      if (outcome.outcome === 'deleted') report.deleted += 1
      else if (outcome.outcome === 'missing') report.missing += 1
      else report.failed += 1
    } catch {
      report.failed += 1
    }
  }
  report.staging = await sweepStaging(attachmentsRoot)
  if (report.failed > 0) report.status = 'partial'
  return report
}

/**
 * Whether one listed survivor is still an unmaterialized pending Session.
 *
 * A snapshot without a `location` has no durable log to scan. The JSONL
 * backend exposes `hasPendingSession()`; other backends fall back to the public
 * `stat()` snapshot. A failed probe is treated as pending (unknown), so the
 * caller keeps every attachment; a backend with no probe at all is also treated
 * as pending because it cannot prove the references absent.
 * @param persistence - Session persistence service.
 * @param snapshot - listed survivor snapshot.
 * @param signal - optional attachment-phase cancellation.
 * @returns true when the Session has no materialized log.
 */
async function isPendingSnapshot(persistence, snapshot, signal) {
  const id = String(snapshot.header.id)
  if (typeof persistence.hasPendingSession === 'function') {
    try {
      return persistence.hasPendingSession(id)
    } catch {
      return true
    }
  }
  // No backend probe exists. The snapshot has no durable `location`, so its
  // references cannot be proven absent; fail closed.
  if (typeof persistence.stat !== 'function') return true
  try {
    const current = await persistence.stat(id, signal === undefined ? undefined : { signal })
    return current === undefined || current.location === undefined
  } catch {
    return true
  }
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
 *
 * Every target is proven to sit inside the resolved store root first: the digest
 * is safe, but an intermediate `objects`/`file-objects`/`files` directory could
 * still be a link. Existing symlinks and wrong entry types are refused and
 * reported as failures instead of being silently skipped.
 * @param root - the attachment store root.
 * @param attachmentId - validated durable attachment id.
 * @param realRoot - optional already-resolved root shared by one cleanup pass.
 * @returns `deleted`, `missing`, or `failed`, plus the bytes the freed objects held.
 */
async function deleteAttachmentObject(root, attachmentId, realRoot) {
  if (!ATTACHMENT_ID.test(attachmentId)) return { outcome: 'missing', bytes: 0 }
  const digest = attachmentId.slice('sha256:'.length)
  const bucket = digest.slice(0, 2)

  const realRootInfo = realRoot === undefined
    ? await realpathOrError(root)
    : { path: realRoot }
  if (realRootInfo.error !== undefined) {
    return { outcome: isAbsentError(realRootInfo.error) ? 'missing' : 'failed', bytes: 0 }
  }
  const targets = [
    { path: join(realRootInfo.path, 'objects', bucket, digest), parent: join(realRootInfo.path, 'objects', bucket), directory: false },
    { path: join(realRootInfo.path, 'file-objects', bucket, digest), parent: join(realRootInfo.path, 'file-objects', bucket), directory: false },
    { path: join(realRootInfo.path, 'files', bucket, digest), parent: join(realRootInfo.path, 'files', bucket), directory: true },
  ]

  let removed = false
  let blocked = false
  let bytes = 0

  for (const target of targets) {
    const realParentInfo = await realpathOrError(dirname(target.path))
    if (realParentInfo.error !== undefined) {
      if (!isAbsentError(realParentInfo.error)) blocked = true
      continue
    }
    if (!samePath(realParentInfo.path, target.parent) || !isStrictlyInside(realRootInfo.path, realParentInfo.path)) {
      blocked = true
      continue
    }
    const info = await inspectPath(target.path)
    if (info.error !== undefined) {
      blocked = true
      continue
    }
    if (info.entry === undefined) continue
    const entry = info.entry
    if (entry.isSymbolicLink()) {
      blocked = true
      continue
    }
    if (target.directory ? !entry.isDirectory() : !entry.isFile()) {
      blocked = true
      continue
    }
    // Re-resolve the leaf itself. The parent check above narrows, but a leaf
    // replaced between lstat() and rm() must not redirect the removal.
    const realTargetInfo = await realpathOrError(target.path)
    if (realTargetInfo.error !== undefined
      || !isStrictlyInside(realRootInfo.path, realTargetInfo.path)
      || !samePath(dirname(realTargetInfo.path), target.parent)
      || !samePath(basename(realTargetInfo.path), digest)) {
      blocked = true
      continue
    }
    try {
      await rm(realTargetInfo.path, { recursive: target.directory, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      blocked = true
      continue
    }
    if (!target.directory) bytes += entry.size
    removed = true
  }

  if (blocked) return { outcome: 'failed', bytes }
  return removed ? { outcome: 'deleted', bytes } : { outcome: 'missing', bytes: 0 }
}

/**
 * Remove abandoned staging files from `<root>/tmp`.
 *
 * A staged file is published through an atomic link moments after it is written,
 * so anything older than the staging window is a crash leftover and cannot
 * belong to an in-flight upload. Recent files are never touched.
 * @param root - the attachment store root.
 * @returns the number of abandoned files removed.
 */
async function sweepStaging(root) {
  const directory = join(root, 'tmp')
  const rootInfo = await realpathOrError(root)
  if (rootInfo.error !== undefined) return 0
  const directoryInfo = await inspectPath(directory)
  if (directoryInfo.entry === undefined || !directoryInfo.entry.isDirectory() || directoryInfo.entry.isSymbolicLink()) {
    return 0
  }
  const realDirectory = await realpathOrError(directory)
  if (realDirectory.error !== undefined
    || !isStrictlyInside(rootInfo.path, realDirectory.path)
    || !samePath(realDirectory.path, join(rootInfo.path, 'tmp'))) return 0
  let entries
  try {
    entries = await readdir(realDirectory.path, { withFileTypes: true })
  } catch {
    return 0
  }
  const cutoff = Date.now() - STAGING_MAX_AGE_MS
  let removed = 0
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const path = join(realDirectory.path, entry.name)
    const info = await lstat(path).catch(() => undefined)
    if (info === undefined || !info.isFile() || info.mtimeMs > cutoff) continue
    try {
      await rm(path, { force: true })
      removed += 1
    } catch {
      /* staging is best effort */
    }
  }
  return removed
}

/**
 * `lstat` one attachment path, separating absence from every other failure.
 * @param path - absolute path.
 * @returns the entry, an explicit absence, or the error that made it unknown.
 */
async function inspectPath(path) {
  try {
    return { entry: await lstat(path) }
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { entry: undefined }
    return { entry: undefined, error }
  }
}

/**
 * `realpath` one path, keeping absence distinct from every other failure.
 * @param path - absolute path.
 * @returns the resolved path, or the error that made it unknown.
 */
async function realpathOrError(path) {
  try {
    return { path: await realpath(path) }
  } catch (error) {
    return { error }
  }
}

/**
 * Whether a filesystem error means the path does not exist.
 * @param error - caught value.
 * @returns true for ENOENT/ENOTDIR.
 */
function isAbsentError(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR'
}

/**
 * Whether one resolved path is a strict descendant of another. Deletion targets
 * must never equal the container root: a mount point or an unexpected reparse
 * target that resolves to the root itself would otherwise turn one `rm` into a
 * removal of the whole store.
 * @param root - resolved parent directory.
 * @param path - resolved candidate.
 * @returns true when `path` is below `root`, never equal to it.
 */
function isStrictlyInside(root, path) {
  const suffix = relative(root, path)
  return suffix !== '' && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)
}

/**
 * Compare two normalized paths with the host filesystem's identity rules.
 * Windows folds case; macOS commonly stores decomposed Unicode, so normalize
 * to NFC before comparing.
 * @param left - normalized path.
 * @param right - normalized path.
 * @returns whether they name the same path.
 */
function samePath(left, right) {
  if (process.platform === 'win32') return left.toLowerCase() === right.toLowerCase()
  if (process.platform === 'darwin') return left.normalize('NFC') === right.normalize('NFC')
  return left === right
}

/**
 * Normalize one absolute path into the key used by catalog directory sets.
 * @param value - absolute directory path.
 * @returns the platform-normalized resolved path.
 */
function pathKey(value) {
  const absolute = resolve(value)
  if (process.platform === 'win32') return absolute.toLowerCase()
  if (process.platform === 'darwin') return absolute.normalize('NFC')
  return absolute
}

/**
 * Normalize one encoded Session directory name for catalog lookups.
 * @param value - one path segment.
 * @returns the platform-normalized segment.
 */
function nameKey(value) {
  if (process.platform === 'win32') return value.toLowerCase()
  if (process.platform === 'darwin') return value.normalize('NFC')
  return value
}

/**
 * Whether one value is a usable stored-session id. DSH brands an unvalidated
 * string, so identity is preserved exactly; the filesystem encoding happens
 * later in `encodeSegment`, never by trimming or normalizing the id.
 * @param value - request value.
 * @returns true for a non-empty string.
 */
function isSessionId(value) {
  return typeof value === 'string' && value.length > 0
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
  const queue = [{ id: rootId }]
  while (queue.length > 0) {
    const { id } = queue.shift()
    if (seen.has(id)) continue
    seen.add(id)
    tree.push(id)
    for (const childId of childrenOf.get(id) ?? []) {
      if (!seen.has(childId)) queue.push({ id: childId })
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
 * A failing job lookup is an error rather than "no job": an unknown writer must
 * not be mistaken for a cold Session.
 * @param ctx - Host context carrying the optional live registries.
 * @param sessionIds - Sessions about to be deleted.
 * @param byId - catalog snapshots keyed by Session id.
 * @returns the live Session id and what holds it, or undefined when every one is cold.
 */
async function findLive(ctx, sessionIds, byId) {
  const agents = ctx.get('agents')
  const sessions = ctx.get('sessions')
  const jobs = ctx.get('jobs')
  for (const id of sessionIds) {
    if (agents !== undefined && agents.get(id) !== undefined) return { sessionId: id, reason: 'agent' }
    if (sessions !== undefined && sessions.get(id) !== undefined) return { sessionId: id, reason: 'session' }
    if (jobs === undefined) continue
    let listing
    try {
      listing = jobs.list(id)
    } catch (error) {
      throw new Error(`job registry lookup failed for "${id}": ${describe(error)}`, { cause: error })
    }
    // `list(owner)` also shows unowned jobs; only this Session's own running
    // work blocks the deletion (mirrors the job registry's archive admission).
    const running = listing.find(
      (job) => job.owner === id && (job.status === 'running' || job.status === 'stopping'),
    )
    if (running !== undefined) return { sessionId: id, reason: 'job' }
  }
  return findLiveDescendant(new Set(sessionIds), byId, agents, sessions)
}

/**
 * Find a live subagent descendant whose own id is not in the deletion tree.
 *
 * This covers a session omitted from `list()` (corrupt/unsupported header) and
 * a pending child with no materialized artifact: neither participates in
 * `collectTree`, but their header still names the parent chain. Running work in
 * such a descendant must block deletion just like a cataloged child.
 * @param deleting - ids already covered by the per-id check.
 * @param byId - catalog snapshots keyed by Session id.
 * @param agents - optional Agent registry.
 * @param sessions - optional Session store.
 * @returns the live descendant and its holder, or undefined.
 */
function findLiveDescendant(deleting, byId, agents, sessions) {
  if (agents !== undefined && typeof agents.list === 'function') {
    for (const agent of agents.list()) {
      const id = String(agent?.id ?? '')
      if (id === '' || deleting.has(id)) continue
      if (descendsFrom(agent?.session?.header, deleting, byId, sessions)) {
        return { sessionId: id, reason: 'agent' }
      }
    }
  }
  if (sessions !== undefined && typeof sessions.list === 'function') {
    for (const session of sessions.list()) {
      const id = String(session?.id ?? '')
      if (id === '' || deleting.has(id)) continue
      if (descendsFrom(session?.header, deleting, byId, sessions)) {
        return { sessionId: id, reason: 'session' }
      }
    }
  }
  return undefined
}

/**
 * Whether one live Session's subagent parent chain reaches the deletion tree.
 *
 * Only `origin: 'subagent'` sessions are owned by a parent; an ordinary fork is
 * an independent lineage. A missing parent, an empty parent link, or a cycle is
 * treated as unknown lineage and blocks deletion rather than being ignored.
 * @param header - live Session header, when available.
 * @param deleting - ids in the deletion tree.
 * @param byId - catalog snapshots keyed by Session id.
 * @param sessions - optional Session store used to read live parent headers.
 * @returns true when the header belongs to a possibly-owned descendant.
 */
function descendsFrom(header, deleting, byId, sessions) {
  if (header?.origin !== 'subagent') return false
  let parent = typeof header.parentSession === 'string' ? header.parentSession : ''
  if (parent === '') return true
  const seen = new Set([String(header.id ?? '')])
  for (;;) {
    if (deleting.has(parent)) return true
    if (seen.has(parent)) return true
    seen.add(parent)
    const parentHeader = sessions?.get?.(parent)?.header ?? byId.get(parent)?.header
    if (parentHeader === undefined) return true
    // A fork or any other non-subagent Session is an independent owner; its
    // own subagent children do not descend from this root.
    if (parentHeader.origin !== 'subagent') return false
    parent = typeof parentHeader.parentSession === 'string' ? parentHeader.parentSession : ''
    if (parent === '') return true
  }
}

/**
 * Run the liveness check and keep an unavailable registry distinct from cold.
 * @param ctx - Host context.
 * @param sessionIds - Sessions about to be deleted.
 * @param byId - catalog snapshots keyed by Session id.
 * @returns `{ session }` for a live one, `{ error }` when the check failed, or `{}`.
 */
async function checkLive(ctx, sessionIds, byId) {
  try {
    const session = await findLive(ctx, sessionIds, byId)
    return session === undefined ? {} : { session }
  } catch (error) {
    return { error: describe(error) }
  }
}

/**
 * Probe each materialized tree Session's write lease.
 *
 * DSH's JSONL write lease is cross-process; the local Agent/Session/job checks
 * cannot see a writer in another process. A short write-open is the public way
 * to acquire the same lease: success proves no other writer holds it, while
 * `SessionAlreadyOwnedError` refuses the deletion. The handle is closed without
 * appending or flushing. A `migration-required` tree log is deliberately probed:
 * the write open publishes a migrated generation, which is harmless because the
 * directory is then removed (and leaves an intact migrated Session if a later
 * step fails). Survivor probes never publish a migration.
 * @param persistence - Session persistence service.
 * @param tree - Sessions being deleted.
 * @param byId - catalog snapshots keyed by Session id.
 * @returns `{ busy }` for a held lease, `{ error }` for an unknown probe failure, or `{}`.
 */
async function probeWriters(persistence, tree, byId) {
  for (const id of tree) {
    const probe = await probeWriterLease(persistence, byId.get(id), undefined, true)
    if (probe.busy === true) return { busy: id }
    if (probe.error !== undefined) return { error: `write-lease probe failed for "${id}": ${probe.error}` }
  }
  return {}
}

/**
 * Acquire and immediately release one materialized Session's write lease.
 * Used both to preflight the deletion tree and to detect a surviving Session
 * that another process is still writing (its buffered attachment references
 * would otherwise be invisible). A pending snapshot is skipped; the caller
 * decides whether an unknown answer is tolerable.
 *
 * `allowMigration` is true only for tree Sessions that are about to be deleted:
 * a write open of a `migration-required` log publishes a migrated generation,
 * which is harmless when the directory is then removed (and leaves an intact
 * migrated Session if deletion fails). Survivors keep that side effect out.
 * @param persistence - Session persistence service.
 * @param snapshot - catalog snapshot for the Session.
 * @param signal - optional attachment-phase cancellation.
 * @param allowMigration - allow a write open to publish a historical migration.
 * @returns `{}` on a clean probe, `{busy}`, `{missing}`, `{unprobeable}`, or `{error}`.
 */
async function probeWriterLease(persistence, snapshot, signal, allowMigration = false) {
  if (snapshot?.location === undefined) return {}
  if (allowMigration !== true
    && (snapshot.formatStatus === undefined || snapshot.formatStatus === 'migration-required')) {
    return { unprobeable: true }
  }
  const id = String(snapshot.header?.id ?? '')
  if (id === '') return {}
  let handle
  try {
    handle = await persistence.open(id, 'write', signal === undefined ? undefined : { signal })
  } catch (error) {
    if (error?.name === 'SessionAlreadyOwnedError') return { busy: true }
    if (error?.name === 'SessionPersistenceNotFoundError') return { missing: true }
    return { error: describe(error) }
  }
  try {
    await handle.close()
  } catch (error) {
    return { error: describe(error) }
  }
  return {}
}

/**
 * Ask DSH's canonical activity waterfall whether any work still targets the
 * tree. This covers providers the plugin does not know about (and the built-in
 * turn/job/subagent/schedule families) after reminders were cleared; a custom
 * provider that reports activity blocks the deletion. A missing waterfall is
 * treated as "no extra provider", matching older/minimal host compositions.
 * @param ctx - Host context.
 * @param sessionIds - Sessions about to be deleted.
 * @returns `{ session }` for reported activity, or `{}`.
 */
async function checkActivity(ctx, sessionIds) {
  if (typeof ctx.waterfall !== 'function') return {}
  for (const id of sessionIds) {
    const activities = await ctx.waterfall(
      'workspace/session-activity',
      { sessionId: id },
      () => Promise.resolve([]),
    )
    if (Array.isArray(activities) && activities.length > 0) {
      const kind = typeof activities[0]?.kind === 'string' ? activities[0].kind : 'activity'
      return { session: { sessionId: id, reason: kind } }
    }
  }
  return {}
}

/**
 * Remove every reminder whose destination is one of the Sessions leaving the
 * catalog, so a later delivery cannot activate or write the Session during
 * deletion. This targets the schedule API shipped from 0.2.2-rc.1:
 * `target: { kind, sessionId }` plus `schedule.edit({ action: 'delete' })`.
 *
 * The list is re-read after deletion so a concurrent retarget/creation is not
 * silently missed. Any failure aborts the session deletion before log removal;
 * `removed` still reports reminders already deleted so the caller can disclose
 * the side effect.
 * @param ctx - Host context; the schedule service is optional.
 * @param sessionIds - Sessions leaving the catalog.
 * @returns the removed count, or an error description plus the removed count.
 */
async function clearSchedules(ctx, sessionIds) {
  const schedule = ctx.get('schedule')
  if (schedule === undefined) return { removed: 0 }
  const deleting = new Set(sessionIds)
  let removed = 0
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let tasks
    try {
      tasks = await listScheduleTasks(schedule)
    } catch (error) {
      return { error: `reminder list failed: ${describe(error)}`, removed }
    }
    const targets = []
    for (const task of tasks) {
      if (task !== null && typeof task === 'object' && task.target === undefined
        && typeof task.sessionId === 'string') {
        // Legacy records have no explicit target; only one that names a
        // Session in this tree makes the old API unsafe for this deletion.
        if (deleting.has(task.sessionId)) {
          return { error: 'the mounted schedule service uses the unsupported pre-0.2.2 API', removed }
        }
        continue
      }
      const targetId = scheduleTargetSessionId(task)
      if (targetId !== undefined && deleting.has(targetId)) targets.push({ task })
    }
    if (targets.length === 0) return { removed }
    let progress = false
    for (const { task } of targets) {
      let outcome
      try {
        outcome = await deleteScheduleTask(schedule, task)
      } catch (error) {
        return { error: `reminder "${String(task?.id)}" failed: ${describe(error)}`, removed }
      }
      if (outcome === 'deleted') {
        removed += 1
        progress = true
      } else if (outcome === 'absent') {
        progress = true
      } else if (outcome === 'conflict') {
        // The task changed under the catalog read. Re-read and decide again.
        progress = true
        break
      }
    }
    if (!progress) return { error: 'reminder deletion made no progress', removed }
  }
  return { error: 'reminders still target the session after retries', removed }
}

/**
 * Clear stale registry-owned workspace state for deleted Sessions.
 *
 * A Workspace's durable `sessionIds` account is not rewritten at startup and
 * only prunes filtered candidates on a later mutation, so a deleted id can
 * remain accounted indefinitely. `Workspace.detachSession` is the public,
 * mutation-pruning operation; use it when the mounted registry exposes `list`.
 * The registry-global archive and pin sets are cleared through their public
 * idempotent operations. All of this is best-effort: stale derived state must
 * not turn a completed deletion into an error. A same-id Session created later
 * would otherwise inherit the old lifecycle's workspace/archive/pin state.
 * @param ctx - Host context; the workspace registry is optional.
 * @param sessionIds - Sessions that left the catalog.
 */
async function clearWorkspaceSessionState(ctx, sessionIds) {
  let registry
  try {
    registry = ctx.get('workspaceRegistry')
  } catch {
    return
  }
  if (registry === undefined) return

  let archived = []
  let pinned = []
  try {
    if (Array.isArray(registry.archivedSessionIds)) archived = registry.archivedSessionIds
  } catch {
    /* derived state */
  }
  try {
    if (Array.isArray(registry.pinnedSessionIds)) pinned = registry.pinnedSessionIds
  } catch {
    /* derived state */
  }
  let workspaces = []
  try {
    if (typeof registry.list === 'function') workspaces = registry.list()
  } catch {
    /* derived state */
  }

  for (const id of sessionIds) {
    for (const workspace of Array.isArray(workspaces) ? workspaces : []) {
      try {
        // Detach is idempotent and also prunes filtered candidates. Calling it
        // even when the filtered getter no longer lists the id removes a stale
        // durable account entry that a concurrent header refresh may hide.
        if (typeof workspace?.detachSession === 'function') await workspace.detachSession(id)
      } catch {
        /* registry accounting is derived state */
      }
    }
    if (archived.includes(id)) {
      try {
        if (typeof registry.unarchiveSession === 'function') await registry.unarchiveSession(id)
      } catch {
        /* registry accounting is derived state */
      }
    }
    if (pinned.includes(id)) {
      try {
        if (typeof registry.unpinSession === 'function') await registry.unpinSession(id)
      } catch {
        /* registry accounting is derived state */
      }
    }
  }
}

/**
 * Resolve the Session a reminder would deliver to. A `new` target creates a
 * fresh Session and names none; `session` and `new_once` name an existing or
 * reserved id.
 * @param task - current schedule catalog entry.
 * @returns the target Session id, or undefined for a `new` target/unknown entry.
 */
function scheduleTargetSessionId(task) {
  const target = task?.target
  if (target === null || typeof target !== 'object') return undefined
  if (target.kind === 'new') return undefined
  return typeof target.sessionId === 'string' ? target.sessionId : undefined
}

/**
 * Delete one reminder through the current schedule API.
 * @param schedule - schedule service.
 * @param task - catalog entry.
 * @returns `deleted`, `absent`, or `conflict`.
 */
async function deleteScheduleTask(schedule, task) {
  if (typeof schedule.edit !== 'function') {
    throw new Error('the mounted schedule service exposes no edit API')
  }
  const result = await schedule.edit({
    id: task.id,
    action: 'delete',
    ...(typeof task.updatedAt === 'string' ? { expectedUpdatedAt: task.updatedAt } : {}),
  })
  if (result?.deleted === true) return 'deleted'
  if (result?.code === 'schedule_not_found') return 'absent'
  if (result?.code === 'schedule_conflict') return 'conflict'
  throw new Error(`unexpected schedule edit result: ${JSON.stringify(result)}`)
}

/**
 * Read every stored reminder once, preferring the unpaged catalog.
 * @param schedule - the schedule service.
 * @returns every task the service holds.
 */
async function listScheduleTasks(schedule) {
  if (typeof schedule.catalog === 'function') {
    const catalog = await schedule.catalog()
    if (Array.isArray(catalog)) return catalog
  }
  const tasks = []
  let offset = 0
  for (;;) {
    const page = await schedule.list({ limit: 500, offset })
    if (Array.isArray(page)) throw new Error('the mounted schedule service uses the unsupported pre-0.2.2 API')
    const items = Array.isArray(page?.items) ? page.items : []
    if (items.length === 0) break
    const before = tasks.length
    tasks.push(...items)
    const total = typeof page.total === 'number' && Number.isSafeInteger(page.total) && page.total >= 0
      ? page.total
      : undefined
    if (total !== undefined && tasks.length >= total) break
    if (tasks.length === before) break
    offset += items.length
  }
  return tasks
}

/**
 * Remove the per-Session projection checkpoint files for the deleted ids. They
 * are a derived cache, so a failure here never turns a completed deletion into
 * an error; the cache service simply reads a missing record as absent.
 *
 * The storage backend's record keys are restricted, so ids outside that set
 * cannot own a per-record cache document and are skipped. The directory and its
 * `storages` ancestor are resolved and checked before any entry is removed.
 * @param storagesRoot - the resolved storage-domain root, or undefined when
 * the mounted storage backend exposes no confirmable root.
 * @param directory - the projection-cache session directory.
 * @param sessionIds - Sessions being deleted.
 * @returns the number of removed cache files.
 */
async function deleteProjectionCache(storagesRoot, directory, sessionIds) {
  if (storagesRoot === undefined || directory === undefined) return 0
  const safeIds = sessionIds.filter((id) => STORAGE_RECORD_KEY.test(id))
  if (safeIds.length === 0) return 0
  const baseInfo = await realpathOrError(storagesRoot)
  if (baseInfo.error !== undefined) return 0
  const directoryInfo = await inspectPath(directory)
  if (directoryInfo.entry === undefined || !directoryInfo.entry.isDirectory() || directoryInfo.entry.isSymbolicLink()) {
    return 0
  }
  const realDirectory = await realpathOrError(directory)
  if (realDirectory.error !== undefined || !isStrictlyInside(baseInfo.path, realDirectory.path)) return 0
  if (relative(baseInfo.path, realDirectory.path) !== join('session_projcache', 'sessions')) return 0
  let entries
  try {
    entries = await readdir(realDirectory.path)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of entries) {
    for (const id of safeIds) {
      if (name !== `${id}.json` && !name.startsWith(`${id}.json.bak.`)) continue
      try {
        await rm(join(realDirectory.path, name), { force: true })
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
 * Resolve the storage roots this installation actually uses.
 *
 * The JSONL backend exposes its validated config, so the Session root follows a
 * relocated backend. The attachment store exposes its resolved `root` too,
 * which keeps a profile-configured `dshHome` correct. A service that exposes no
 * root is not assumed to use the default directory: deleting files there could
 * touch another backend's data.
 *
 * The local spill backend exposes `root`; a remote spill backend does not, and
 * its files are left to that backend's retention. `spillRootIsPrivate` records
 * that this root is a per-process `dsh-spill-*` temp root, so prior roots must
 * also be considered when reclaiming one Session's spill files.
 *
 * Derived caches follow the mounted `storage` hub's JSON backend root. Without
 * a confirmable backend root, projection-cache cleanup is skipped.
 * @param ctx - Host context.
 * @param persistence - already-resolved Session persistence service.
 * @returns resolved roots; `sessionRoot`, `attachmentsRoot`, `spillRoot`, and
 * `storagesRoot` are undefined when the mounted service does not expose one.
 */
function resolveLocations(ctx, persistence = ctx?.get?.('sessionPersistence')) {
  // The backend's resolved `root` is authoritative. `config.root` remains the
  // public fallback for a wrapper backend that does not expose the resolved
  // path; resolving it again here would depend on the current working directory.
  const resolvedRoot = persistence?.root
  const configuredRoot = typeof resolvedRoot === 'string' && resolvedRoot !== ''
    ? resolvedRoot
    : persistence?.config?.root
  const sessionRoot = typeof configuredRoot === 'string' && configuredRoot !== ''
    ? resolve(configuredRoot)
    : undefined

  const attachmentRoot = ctx?.get?.('attachments')?.root
  const attachmentsRoot = typeof attachmentRoot === 'string' && attachmentRoot !== ''
    ? resolve(attachmentRoot)
    : undefined
  const spillStore = ctx?.get?.('spillStore')
  const spillRootValue = spillStore?.root
  const spillRoot = typeof spillRootValue === 'string' && spillRootValue !== ''
    ? resolve(spillRootValue)
    : undefined
  const spillRootIsPrivate = spillRoot !== undefined
    && typeof spillStore?.config?.root !== 'string'
    && SPILL_ROOT_NAME.test(basename(spillRoot))
  const storagesRoot = resolveStorageRoot(ctx)

  return {
    sessionRoot,
    attachmentsRoot,
    spillRoot,
    spillRootIsPrivate,
    storagesRoot,
    projectionCacheRoot: storagesRoot === undefined
      ? undefined
      : join(storagesRoot, 'session_projcache', 'sessions'),
  }
}

/**
 * Resolve the storage-json backend root used by the projection cache.
 *
 * The shipped composition mounts the `storage` hub over a `json` backend whose
 * root is itself configurable. Reading that root is preferable to assuming
 * `<DSH_HOME>/storages`: deleting the assumed path while the real cache lives
 * elsewhere could touch another profile's derived data. When the hub is absent,
 * or its backend root cannot be inspected, cache cleanup is skipped rather than
 * guessing.
 * @param ctx - Host context.
 * @returns the backend root, or undefined when it cannot be confirmed.
 */
function resolveStorageRoot(ctx) {
  const storage = ctx?.get?.('storage')
  if (storage === undefined) return undefined
  let backend
  try {
    backend = storage.backend?.get?.('json')
  } catch {
    return undefined
  }
  const root = typeof backend?.root === 'string' && backend.root !== ''
    ? backend.root
    : backend?.config?.root
  return typeof root === 'string' && root !== '' ? resolve(root) : undefined
}

/**
 * Start the attachment phase's shared budget.
 *
 * The timer is unref'd so a finished request never keeps the process alive; the
 * signal is forwarded to every open and read, and the caller clears it when the
 * whole phase settles.
 * @param configured - optional budget override, in milliseconds.
 * @returns the abort signal and the stop function.
 */
function startBudget(configured) {
  const ms = Number.isFinite(configured) && configured > 0 ? configured : REFERENCE_SCAN_BUDGET_MS
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new Error('attachment reference scan exceeded its budget')),
    ms,
  )
  timer.unref?.()
  return { signal: controller.signal, stop: () => clearTimeout(timer) }
}

/**
 * Resolve every stored directory for one Session id across all project
 * directories. A directory that cannot be inspected for a reason other than
 * absence is an error, never silently "missing".
 * @param root - the sessions root.
 * @param sessionId - exact stored Session id.
 * @param directoryCache - optional per-request cache of the project listing.
 * @returns the existing Session directories.
 */
async function findSessionDirectories(root, sessionId, directoryCache) {
  let projects = directoryCache?.get(root)
  if (projects === undefined) {
    try {
      projects = await readdir(root, { withFileTypes: true })
    } catch (error) {
      if (isAbsentError(error)) return []
      throw error
    }
    directoryCache?.set(root, projects)
  }
  const directories = []
  for (const project of projects) {
    if (!project.isDirectory() || project.isSymbolicLink()) continue
    const directory = join(root, project.name, encodeSegment(sessionId))
    const info = await inspectPath(directory)
    if (info.error !== undefined) throw info.error
    if (info.entry === undefined || !info.entry.isDirectory() || info.entry.isSymbolicLink()) continue
    directories.push(directory)
  }
  return directories
}

/**
 * Resolve the exact directory every Session in the tree will remove.
 *
 * A snapshot's `location.path` is the backend's authoritative artifact path, so
 * its parent is used directly when present. Without a location (older
 * backends/pending sessions), zero or one scanned directory is accepted; more
 * than one is ambiguous and refuses the whole operation. Duplicate ids that
 * both carry locations are caught by the catalog preflight.
 * @param root - the sessions root.
 * @param sessionIds - the deletion tree, root first.
 * @param byId - catalog snapshots keyed by Session id.
 * @returns planned directories, or an error that must abort before any deletion.
 */
async function planSessionDirectories(root, sessionIds, byId) {
  const plans = []
  const directoryCache = new Map()
  for (const id of sessionIds) {
    const locationPath = byId.get(id)?.location?.path
    if (typeof locationPath === 'string' && isAbsolute(locationPath)) {
      // The catalog already names the authoritative artifact. Use its parent
      // directly and only prove it is a plain Session directory under the root.
      const directory = resolve(dirname(locationPath))
      try {
        assertContained(root, directory)
      } catch (error) {
        return { code: 'delete-failed', detail: describe(error) }
      }
      if (!samePath(basename(directory), encodeSegment(id))) {
        return {
          code: 'ambiguous',
          detail: `session "${id}" catalog directory name does not match its encoded id`,
          failed: [{ sessionId: id, code: 'ambiguous', directory }],
        }
      }
      const info = await inspectPath(directory)
      if (info.error !== undefined) return { code: 'delete-failed', detail: describe(info.error) }
      if (info.entry === undefined) {
        // The catalog may be stale or another copy may exist under a different
        // project. A missing authoritative directory is only "already gone" when
        // no scanned copy exists; otherwise the id is ambiguous.
        let scanned
        try {
          scanned = await findSessionDirectories(root, id, directoryCache)
        } catch (error) {
          return { code: 'delete-failed', detail: describe(error) }
        }
        if (scanned.length > 0) {
          return {
            code: 'ambiguous',
            detail: `session "${id}" has a stored directory that does not match its catalog location`,
            failed: [{ sessionId: id, code: 'ambiguous', directory: scanned[0], expected: directory }],
          }
        }
        plans.push({ id })
        continue
      }
      if (!info.entry.isDirectory() || info.entry.isSymbolicLink()) {
        return {
          code: 'ambiguous',
          detail: `session "${id}" catalog directory is not a plain directory`,
          failed: [{ sessionId: id, code: 'ambiguous', directory }],
        }
      }
      plans.push({ id, directory })
      continue
    }

    // Pending sessions and older catalogs carry no location. Fall back to the
    // encoded directory scan and refuse more than one copy.
    let directories
    try {
      directories = await findSessionDirectories(root, id, directoryCache)
    } catch (error) {
      return { code: 'delete-failed', detail: describe(error) }
    }
    if (directories.length > 1) {
      return {
        code: 'ambiguous',
        detail: `session "${id}" has ${directories.length} stored directories`,
        failed: directories.map((directory) => ({ sessionId: id, code: 'ambiguous', directory })),
      }
    }
    if (directories.length === 0) {
      plans.push({ id })
      continue
    }
    const directory = directories[0]
    try {
      assertContained(root, directory)
    } catch (error) {
      return { code: 'delete-failed', detail: describe(error) }
    }
    plans.push({ id, directory })
  }
  return { plans }
}

/**
 * Re-prove immediately before removal that the backend still maps one Session
 * id to the planned directory. `stat()` reads only the header, so this catches
 * a replaced log or a moved materialized location without reading the full log
 * again. Backends without `stat()` are left to the path checks below.
 * @param persistence - Session persistence service.
 * @param sessionId - Session whose directory is about to be removed.
 * @param directory - planned directory under the session root.
 */
async function verifySessionDirectory(persistence, sessionId, directory) {
  if (typeof persistence.stat !== 'function') return
  const snapshot = await persistence.stat(sessionId)
  const location = snapshot?.location?.path
  if (typeof location !== 'string' || !isAbsolute(location)) {
    const error = new Error(`session "${sessionId}" no longer has a materialized stored log`)
    error.code = 'SESSION_GONE'
    throw error
  }
  const actual = await realpathOrError(dirname(location))
  if (actual.error !== undefined) {
    if (isAbsentError(actual.error)) {
      const error = new Error(`session "${sessionId}" stored log disappeared`)
      error.code = 'SESSION_GONE'
      throw error
    }
    throw actual.error
  }
  const expected = await realpathOrError(directory)
  if (expected.error !== undefined) {
    if (isAbsentError(expected.error)) {
      const error = new Error(`session "${sessionId}" stored directory disappeared`)
      error.code = 'SESSION_GONE'
      throw error
    }
    throw expected.error
  }
  if (!samePath(actual.path, expected.path)) {
    throw new Error(`session "${sessionId}" moved to a different stored directory during deletion`)
  }
}

/**
 * Whether a failed root removal raced another process that already removed the
 * Session. The caller must first observe a `SESSION_GONE` error, and the
 * directory must be absent with no materialized catalog entry.
 * @param persistence - Session persistence service.
 * @param sessionId - Session whose root removal failed.
 * @param directory - planned root directory.
 * @returns true when the Session is already gone.
 */
async function isSessionGone(persistence, sessionId, directory) {
  const info = await inspectPath(directory)
  if (info.entry !== undefined || info.error !== undefined) return false
  if (typeof persistence.stat !== 'function') return true
  try {
    return await persistence.stat(sessionId) === undefined
  } catch {
    return false
  }
}

/**
 * Remove one planned Session directory after re-proving it has not been
 * replaced by a link since planning. This re-resolves both sides immediately
 * before removal, narrowing the path-swap window.
 * @param root - the sessions root.
 * @param directory - the planned directory under the root.
 * @param sessionId - Session whose directory was planned, when known.
 */
async function removeSessionDirectory(root, directory, sessionId) {
  const expectedName = sessionId === undefined ? undefined : encodeSegment(sessionId)
  const rootInfo = await realpathOrError(root)
  if (rootInfo.error !== undefined) throw rootInfo.error
  if (expectedName !== undefined && !samePath(basename(directory), expectedName)) {
    throw new Error('refusing to delete a directory whose planned name does not match the session id')
  }
  const originalInfo = await inspectPath(directory)
  if (originalInfo.error !== undefined) throw originalInfo.error
  if (originalInfo.entry === undefined) {
    const error = new Error('refusing to delete a session directory that no longer exists')
    error.code = 'SESSION_GONE'
    throw error
  }
  if (!originalInfo.entry.isDirectory() || originalInfo.entry.isSymbolicLink()) {
    throw new Error('refusing to delete a session directory that is no longer a plain directory')
  }
  const directoryInfo = await realpathOrError(directory)
  if (directoryInfo.error !== undefined) {
    if (isAbsentError(directoryInfo.error)) {
      const error = new Error('refusing to delete a session directory that no longer exists')
      error.code = 'SESSION_GONE'
      throw error
    }
    throw directoryInfo.error
  }
  if (!isStrictlyInside(rootInfo.path, directoryInfo.path)) {
    throw new Error('refusing to delete a directory that resolves outside the session root')
  }
  if (!samePath(dirname(dirname(directoryInfo.path)), rootInfo.path)) {
    throw new Error('refusing to delete a directory that is not exactly two levels below the session root')
  }
  if (expectedName !== undefined && !samePath(basename(directoryInfo.path), expectedName)) {
    throw new Error('refusing to delete a directory whose resolved name does not match the session id')
  }
  if (!samePath(basename(directoryInfo.path), basename(directory))) {
    throw new Error('refusing to delete a directory whose resolved name changed')
  }
  const info = await inspectPath(directoryInfo.path)
  if (info.error !== undefined) throw info.error
  if (info.entry === undefined) {
    const error = new Error('refusing to delete a session directory that no longer exists')
    error.code = 'SESSION_GONE'
    throw error
  }
  if (!info.entry.isDirectory() || info.entry.isSymbolicLink()) {
    throw new Error('refusing to delete a session directory that is no longer a plain directory')
  }
  // Remove the resolved path, not the pre-resolution spelling: a project
  // directory swapped between realpath() and rm() cannot redirect this call
  // to a different leaf with the same relative name.
  await rm(directoryInfo.path, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 })
}

/**
 * Whether an exact-shaped private spill root is safe to sweep.
 *
 * Mirrors the protection in DSH's own startup sweep: on POSIX the root must be
 * owned by this process's user and not writable by group/other, and every
 * ancestor must either be non-writable by others or sticky (so `/tmp` remains
 * valid while a world-writable non-sticky ancestor does not). Windows has no
 * equivalent ownership/mode model here; an existing directory is accepted.
 * @param path - candidate private spill root.
 * @returns true when another local user cannot replace the root's children.
 */
async function isTrustedSpillRoot(path) {
  let stats
  try {
    stats = await lstat(path)
  } catch {
    return false
  }
  if (!stats.isDirectory()) return false
  if (process.platform === 'win32' || process.geteuid === undefined) return true
  const uid = process.geteuid()
  if (stats.uid !== uid || (stats.mode & 0o022) !== 0) return false

  let child = path
  let childStats = stats
  for (;;) {
    const parent = dirname(child)
    if (parent === child) return true
    let parentStats
    try {
      parentStats = await lstat(parent)
    } catch {
      return false
    }
    if (!parentStats.isDirectory()) return false
    const writableByOthers = (parentStats.mode & 0o022) !== 0
    const sticky = (parentStats.mode & 0o1000) !== 0
    if (writableByOthers && !sticky) return false
    if (writableByOthers && childStats.uid !== uid) return false
    child = parent
    childStats = parentStats
  }
}

/**
 * Resolve every local spill root that can own one deleted Session's locators.
 *
 * A local backend configured with an explicit root is stable. The default
 * root is a per-process `dsh-spill-*` temp directory, so files written by an
 * earlier process live under a sibling root. Discover those siblings by the
 * exact `mkdtemp` shape the backend uses for its startup sweep; an unrelated
 * `dsh-spill-*` directory is never treated as a backend root.
 * @param locations - resolved store roots.
 * @returns the roots to inspect, or undefined when no local spill root exists.
 */
async function resolveSpillRoots(locations) {
  const root = locations.spillRoot
  if (root === undefined) return undefined
  if (locations.spillRootIsPrivate !== true) {
    // A configured root is not necessarily private. Mirror the local backend's
    // startup sweep: only an existing, non-symlinked, trusted directory may be
    // swept. An absent root has no spill files and is safe to pass through.
    const info = await inspectPath(root)
    if (info.entry === undefined) return info.error === undefined ? [root] : []
    if (!info.entry.isDirectory() || info.entry.isSymbolicLink()) return []
    return await isTrustedSpillRoot(root) ? [root] : []
  }
  if (!await isTrustedSpillRoot(root)) return []
  const parent = dirname(root)
  let entries
  try {
    entries = await readdir(parent, { withFileTypes: true })
  } catch {
    return [root]
  }
  const roots = new Set([root])
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    if (!SPILL_ROOT_NAME.test(entry.name)) continue
    const candidate = join(parent, entry.name)
    if (!await isTrustedSpillRoot(candidate)) continue
    roots.add(candidate)
  }
  return [...roots]
}

/**
 * Remove the spill directory owned by deleted Sessions when no surviving
 * Session descends from the deleted tree.
 *
 * Spill locators are file paths inside the owning Session's spill directory.
 * Forked or spawned descendants inherit the parent's events and may keep using
 * those paths, so a surviving descendant keeps every deleted tree's spill files
 * rather than risking a broken locator. Current DSH ordinary forks carry only
 * `isSeeded`, not `parentSession`; any surviving seeded Session is therefore
 * treated as a possible fork source. Non-local spill backends expose no `root`;
 * their retention policy owns cleanup.
 * @param roots - resolved local spill roots, or undefined when unavailable.
 * @param byId - refreshed catalog snapshots keyed by Session id.
 * @param sessionIds - Sessions whose directories are gone.
 * @param catalog - the refreshed stored-directory catalog; incomplete keeps all.
 * @returns counts, or undefined when no local spill root is available.
 */
async function deleteSpillDirectories(roots, byId, sessionIds, catalog) {
  if (roots === undefined) return undefined
  if (roots.length === 0) {
    return { deleted: 0, kept: sessionIds.length, failed: 0, status: 'unverified' }
  }
  if (catalog === undefined || catalog.incomplete === true
    || catalog.unaccountedPaths.length > 0 || catalog.duplicates.length > 0) {
    return { deleted: 0, kept: sessionIds.length, failed: 0, status: 'unverified' }
  }
  if (hasSurvivingDescendant(byId, new Set(sessionIds))) {
    return { deleted: 0, kept: sessionIds.length, failed: 0 }
  }

  const resolvedRoots = []
  for (const root of roots) {
    const rootInfo = await realpathOrError(root)
    if (rootInfo.error !== undefined) {
      if (isAbsentError(rootInfo.error)) continue
      return { deleted: 0, kept: sessionIds.length, failed: 0, status: 'unavailable' }
    }
    const info = await inspectPath(rootInfo.path)
    if (info.error !== undefined || info.entry === undefined || !info.entry.isDirectory()) {
      return { deleted: 0, kept: sessionIds.length, failed: 0, status: 'unavailable' }
    }
    if (!resolvedRoots.includes(rootInfo.path)) resolvedRoots.push(rootInfo.path)
  }
  if (resolvedRoots.length === 0) return { deleted: 0, kept: 0, failed: 0 }

  let deleted = 0
  let failed = 0
  for (const root of resolvedRoots) {
    for (const id of sessionIds) {
      const directory = join(root, spillSessionKey(id))
      const info = await inspectPath(directory)
      if (info.error !== undefined) {
        failed += 1
        continue
      }
      if (info.entry === undefined) continue
      if (!info.entry.isDirectory() || info.entry.isSymbolicLink()) {
        failed += 1
        continue
      }
      const realDirectory = await realpathOrError(directory)
      if (realDirectory.error !== undefined
        || !isStrictlyInside(root, realDirectory.path)
        || !samePath(dirname(realDirectory.path), root)
        || !samePath(basename(realDirectory.path), spillSessionKey(id))) {
        failed += 1
        continue
      }
      try {
        await rm(realDirectory.path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
        deleted += 1
      } catch {
        failed += 1
      }
    }
  }
  return { deleted, kept: 0, failed }
}

/**
 * Whether any surviving Session descends from the deleted tree.
 *
 * Parent-chain descent covers subagent children. It does not cover current
 * ordinary forks, which intentionally omit `parentSession`; a surviving
 * `isSeeded` Session is therefore an unprovable potential fork source and
 * keeps spill files. Keeping extra spill files is safe; deleting a locator a
 * fork inherited is not.
 * @param byId - refreshed catalog snapshots keyed by Session id.
 * @param deleted - deleted Session ids.
 * @returns true when a surviving Session may descend from a deleted id.
 */
function hasSurvivingDescendant(byId, deleted) {
  for (const [id, snapshot] of byId) {
    if (deleted.has(id)) continue
    if (snapshot?.header?.isSeeded === true) return true
    if (snapshot?.header?.origin !== 'subagent') continue
    let parent = String(snapshot?.header?.parentSession ?? '')
    // A subagent without a parent link, or inside a parent cycle, cannot prove
    // it does not descend from the deleted tree; keep every spill locator.
    if (parent === '') return true
    const seen = new Set([id])
    while (parent !== '') {
      if (deleted.has(parent)) return true
      if (seen.has(parent)) return true
      seen.add(parent)
      const parentSnapshot = byId.get(parent)
      // An unresolved parent may itself descend from the deleted tree. Keeping
      // spill files is safe; deleting a surviving descendant's locators is not.
      if (parentSnapshot === undefined) return true
      // A fork owns its own subagent children; the chain does not continue
      // through an independent non-subagent parent.
      if (parentSnapshot.header?.origin !== 'subagent') break
      parent = String(parentSnapshot.header?.parentSession ?? '')
      if (parent === '') return true
    }
  }
  return false
}

/**
 * The stable spill directory name for one Session id.
 * @param sessionId - exact Session id.
 * @returns `session-<12 hex chars>`.
 */
function spillSessionKey(sessionId) {
  return `session-${createHash('sha256').update(sessionId).digest('hex').slice(0, 12)}`
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
  if (suffix === '' || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw new Error('refusing to delete outside the session root')
  }
  if (suffix.split(sep).length !== 2) {
    throw new Error('refusing to delete outside a project session directory')
  }
}

/**
 * Carry the number of already-removed reminders on a later failure.
 *
 * Reminder removal is necessarily ordered before log removal; if a later
 * liveness check or a directory delete fails, the logs stay but the reminders
 * are already gone. Report that side effect instead of leaving it silent.
 * @param result - failure result.
 * @param count - reminders removed before the failure.
 * @returns the same result with `schedules` when non-zero.
 */
function withSchedulesRemoved(result, count) {
  if (count > 0) result.schedules = count
  return result
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
    case 'busy':
    case 'ambiguous':
    case 'tree-incomplete':
    case 'directory-missing':
    case 'subagent-session':
      return 409
    case 'unsupported':
      return 501
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
