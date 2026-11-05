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
 * The session log directory is the authoritative Session artifact. Derived
 * caches, local spill directories, and content-addressed attachment blobs live
 * elsewhere. On request the caller may also reclaim attachment objects, but
 * only those no surviving Session references: an attachment is
 * content-addressed and immutable, so resumed and forked Sessions may share it
 * (see README.md). Spill directories are removed only when the catalog is
 * complete and no surviving Session descends from the deleted tree.
 */
import { createHash } from 'node:crypto'
import { lstat, readdir, realpath, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Absolute Fetch path; the browser calls the document-relative `api/session.delete`. */
const ROUTE = '/api/session.delete'
/**
 * Record keys the JSON storage backend accepts as path segments. Projection
 * cache records use the Session id as their key; an id outside this set has no
 * per-record cache document even though its log is addressable through
 * `encodeSegment`.
 */
const STORAGE_RECORD_KEY = /^[A-Za-z0-9_-]+$/
/** Guards a pathological lineage against an unbounded walk. */
const MAX_TREE_DEPTH = 64
/** Durable attachment identity: the content addresses recorded in a Session log. */
const ATTACHMENT_ID = /^sha256:[a-f0-9]{64}$/
/** Logical events per persistence read while counting attachment references. */
const REFERENCE_READ_CHUNK = 2000
/** Bound on the whole attachment phase; after it nothing is deleted, because an unfinished count proves nothing. */
const REFERENCE_SCAN_BUDGET_MS = 30000
/** Staged attachment bytes older than this are abandoned writes, not in-flight uploads (generic files have no size limit, so the window is generous). */
const STAGING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

const FAILURE_MESSAGES = {
  'invalid-request': 'Expected a JSON body with a sessionId string.',
  'invalid-id': 'The session id must be a non-empty string.',
  unavailable: 'Session persistence is not mounted in this profile.',
  unsupported: 'This session backend has no resolved filesystem root; deletion is unsupported.',
  'not-found': 'No stored session has that id.',
  live: 'The session is live. Close it and stop its work before deleting it.',
  'live-check-failed': 'Liveness could not be determined, so deletion was refused.',
  ambiguous: 'The stored session directory is ambiguous or does not match the catalog.',
  'schedule-failed': 'The session reminders could not be removed; no session files were deleted.',
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
 * Order: resolve the stored tree, refuse anything live, read the attachment
 * references while the logs still exist, prove the catalog accounts for every
 * stored Session directory, plan every deletion target from the catalog-resolved
 * location, re-check liveness, clear reminders, re-check liveness once more,
 * remove child directories before the root, then remove derived caches, spill
 * files, and unshared attachment objects.
 *
 * The root directory is removed last so a child failure leaves the root and a
 * retry can finish the tree. A child directory already absent is treated as
 * already deleted; the root's absence is still a refusal.
 *
 * Only a Session that is neither in the live Session store nor held by a live
 * Agent nor running a background job may be deleted. Reminders targeting the
 * tree are removed before any session directory, because they can activate the
 * Session during deletion.
 * @param ctx - Host context carrying the services the deletion uses.
 * @param rawSessionId - requested Session id, used exactly as stored.
 * @param options - optional attachment cleanup (`deleteAttachments`); the internal
 * `attachmentsBudgetMs` override exists for tests.
 * @returns a structured result; `ok` is false for every refusal or partial delete.
 */
export async function deleteSession(ctx, rawSessionId, options = {}) {
  const deleteAttachments = options?.deleteAttachments === true
  if (!isSessionId(rawSessionId)) return failure('invalid-id', typeof rawSessionId === 'string' ? rawSessionId : '')
  const sessionId = rawSessionId

  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) return failure('unavailable')

  const backendName = typeof persistence.name === 'string' ? persistence.name : undefined
  if (backendName !== undefined && backendName !== 'session-persistence-jsonl') {
    return failure('unsupported', sessionId, `session persistence backend "${backendName}" is not the JSONL backend`)
  }
  const locations = resolveLocations(ctx)
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

  const tree = collectTree(byId, sessionId)
  const live = await checkLive(ctx, tree)
  if (live.error !== undefined) return failure('live-check-failed', sessionId, live.error)
  if (live.session !== undefined) return { ...failure('live', live.session.sessionId), reason: live.session.reason }

  const budget = deleteAttachments ? startBudget(options?.attachmentsBudgetMs) : undefined

  try {
    // Read what the tree references while its logs still exist: after the
    // directories are gone nothing can name the attachments that were in them.
    // The budget covers this read too, so a huge or stuck log cannot outlive it.
    const owned = budget === undefined ? undefined : await readAttachmentRefs(persistence, tree, budget.signal)

    // A stored directory the catalog cannot name is an unknown reference: its
    // Session may hold the only other reference to a candidate object, so an
    // incomplete catalog keeps every object. A scan failure never blocks the
    // deletion itself.
    let catalog
    if ((owned !== undefined && locations.attachmentsRoot !== undefined) || locations.spillRoot !== undefined) {
      try {
        catalog = await inspectCatalog(locations.sessionRoot, byId)
      } catch {
        catalog = { incomplete: true, unaccounted: [], duplicates: [] }
      }
    }

    // Narrow the refusal window: the Session may have been opened while its
    // references were being read. Nothing has been removed yet.
    const stillLive = await checkLive(ctx, tree)
    if (stillLive.error !== undefined) return failure('live-check-failed', sessionId, stillLive.error)
    if (stillLive.session !== undefined) {
      return { ...failure('live', stillLive.session.sessionId), reason: stillLive.session.reason }
    }

    // A live surviving Session whose log is still pending has attachment
    // references only in memory; opening its log would return an empty prefix.
    // Keep every attachment rather than treating that unknown as "none".
    const pendingSurvivor = hasPendingSurvivingSession(ctx, persistence, tree)

    // Resolve every directory before removing anything. A duplicate id or a
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

    // Reminders can activate a Session without leaving an Agent or Session
    // object in the registries until the delivery starts. Clear them before
    // touching logs, then check liveness again; `edit`/`delete` is serialized
    // behind an already running delivery.
    const scheduleOutcome = await clearSchedules(ctx, tree)
    if (scheduleOutcome.error !== undefined) return failure('schedule-failed', sessionId, scheduleOutcome.error)

    const afterSchedules = await checkLive(ctx, tree)
    if (afterSchedules.error !== undefined) return failure('live-check-failed', sessionId, afterSchedules.error)
    if (afterSchedules.session !== undefined) {
      return { ...failure('live', afterSchedules.session.sessionId), reason: afterSchedules.session.reason }
    }

    const deleted = []
    const failed = []
    const alreadyGone = []

    // Children first; the root is the last directory removed. A child failure
    // therefore leaves the root in place and a retry can finish the tree.
    const childPlans = planned.plans.filter((plan) => plan.id !== sessionId)
    for (const plan of [...childPlans].reverse()) {
      if (plan.directory === undefined) {
        alreadyGone.push(plan.id)
        continue
      }
      try {
        await removeSessionDirectory(locations.sessionRoot, plan.directory)
        deleted.push(plan.id)
      } catch (error) {
        failed.push({ sessionId: plan.id, code: 'delete-failed', message: describe(error) })
      }
    }

    if (failed.length > 0) {
      const result = {
        ok: false,
        code: 'partial',
        message: FAILURE_MESSAGES.partial,
        sessionId,
        deleted,
        failed,
        schedules: scheduleOutcome.removed,
      }
      return result
    }

    try {
      await removeSessionDirectory(locations.sessionRoot, rootPlan.directory)
      deleted.push(sessionId)
    } catch (error) {
      const result = {
        ok: false,
        code: 'partial',
        message: FAILURE_MESSAGES.partial,
        sessionId,
        deleted,
        failed: [{ sessionId, code: 'delete-failed', message: describe(error) }],
        schedules: scheduleOutcome.removed,
      }
      return result
    }

    const gone = [...deleted, ...alreadyGone]
    const caches = await deleteProjectionCache(
      locations.storagesRoot,
      locations.projectionCacheRoot,
      gone,
    )
    const spill = await deleteSpillDirectories(locations.spillRoot, byId, gone, catalog)
    // Attachment candidates come from directories actually removed. A child
    // directory already absent keeps its referenced objects: without a stored
    // log the references cannot be proven absent.
    const attachments = owned === undefined ? undefined : await settleAttachments(persistence, tree, deleted, owned, {
      signal: budget.signal,
      locations,
      catalog,
      pendingSurvivor,
    })

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

    const result = {
      ok: true,
      sessionId,
      deleted,
      schedules: scheduleOutcome.removed,
      caches,
      ...(spill === undefined ? {} : { spill }),
      ...(attachments === undefined ? {} : { attachments }),
    }
    return result
  } finally {
    budget?.stop()
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
  const result = { incomplete: false, unaccounted: [], duplicates: [] }
  const knownDirs = new Set()
  const knownNames = new Set()
  for (const snapshot of known.values()) {
    const path = snapshot?.location?.path
    if (typeof path === 'string' && isAbsolute(path)) knownDirs.add(resolve(dirname(path)))
    const id = String(snapshot?.header?.id ?? '')
    if (id !== '') knownNames.add(encodeSegment(id))
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
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const directory = join(sessionRoot, project.name, entry.name)
      if (knownDirs.has(resolve(directory)) || knownNames.has(entry.name)) {
        const count = (seen.get(entry.name) ?? 0) + 1
        seen.set(entry.name, count)
        if (count === 2) result.duplicates.push(entry.name)
        continue
      }
      const hasArtifact = await hasSessionArtifact(directory)
      if (hasArtifact === undefined) result.incomplete = true
      else if (hasArtifact) result.unaccounted.push(entry.name)
    }
  }
  return result
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
 * Whether one stored Session directory holds any file. A log is the expected
 * artifact, but the directory is Session-owned and may carry future artifacts, so
 * anything stored there counts: a directory the catalog cannot name must never be
 * silently ignored. An empty directory names nothing and is ignored.
 * @param directory - the candidate Session directory.
 * @returns true/false, or undefined when the directory cannot be read.
 */
async function hasSessionArtifact(directory) {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    return entries.some((entry) => entry.isFile() || entry.isSymbolicLink())
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
 * @param options - the shared budget, resolved store roots, and catalog findings.
 * @returns the attachment report carried by the response.
 */
async function settleAttachments(persistence, tree, deletedIds, owned, options) {
  const report = { status: 'applied', deleted: 0, kept: 0, failed: 0, missing: 0, bytes: 0, staging: 0 }
  if (options.locations.attachmentsRoot === undefined) {
    return { ...report, status: 'unverified', reason: 'unavailable' }
  }
  if (options.pendingSurvivor === true) {
    return { ...report, status: 'unverified', reason: 'pending' }
  }
  if (owned.unreadable.length > 0) {
    return { ...report, status: 'unverified', reason: options.signal.aborted ? 'timeout' : 'unreadable' }
  }
  if (options.catalog === undefined || options.catalog.incomplete === true) {
    return { ...report, status: 'unverified', reason: 'catalog' }
  }
  if (options.catalog.unaccounted.length > 0 || options.catalog.duplicates.length > 0) {
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
  try {
    snapshots = await persistence.list({ signal: options.signal })
  } catch {
    return { ...report, status: 'unverified', reason: options.signal.aborted ? 'timeout' : 'unreadable' }
  }
  for (const snapshot of snapshots) {
    if (pending.size === 0) break
    const id = String(snapshot.header.id)
    if (deleted.has(id) || owned.refs.has(id)) continue
    let found
    try {
      found = await scanSessionForAttachments(persistence, id, pending, options.signal)
    } catch {
      return { ...report, status: 'unverified', reason: options.signal.aborted ? 'timeout' : 'unreadable' }
    }
    for (const attachmentId of found) pending.delete(attachmentId)
  }

  for (const attachmentId of candidates) {
    if (!pending.has(attachmentId)) {
      report.kept += 1
      continue
    }
    try {
      const outcome = await deleteAttachmentObject(attachmentsRoot, attachmentId)
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
 * @returns `deleted`, `missing`, or `failed`, plus the bytes the freed objects held.
 */
async function deleteAttachmentObject(root, attachmentId) {
  if (!ATTACHMENT_ID.test(attachmentId)) return { outcome: 'missing', bytes: 0 }
  const digest = attachmentId.slice('sha256:'.length)
  const bucket = digest.slice(0, 2)
  const targets = [
    { path: join(root, 'objects', bucket, digest), directory: false },
    { path: join(root, 'file-objects', bucket, digest), directory: false },
    { path: join(root, 'files', bucket, digest), directory: true },
  ]

  const realRootInfo = await realpathOrError(root)
  if (realRootInfo.error !== undefined) {
    return { outcome: isAbsentError(realRootInfo.error) ? 'missing' : 'failed', bytes: 0 }
  }

  let removed = false
  let blocked = false
  let bytes = 0

  for (const target of targets) {
    const realParentInfo = await realpathOrError(dirname(target.path))
    if (realParentInfo.error !== undefined) {
      if (!isAbsentError(realParentInfo.error)) blocked = true
      continue
    }
    if (!isInside(realRootInfo.path, realParentInfo.path)) {
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
    try {
      await rm(target.path, { recursive: target.directory, force: true, maxRetries: 3, retryDelay: 100 })
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
  if (realDirectory.error !== undefined || !isInside(rootInfo.path, realDirectory.path)) return 0
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return 0
  }
  const cutoff = Date.now() - STAGING_MAX_AGE_MS
  let removed = 0
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const path = join(directory, entry.name)
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
 * Whether one resolved path stays inside another.
 * @param root - resolved parent directory.
 * @param path - resolved candidate.
 * @returns true when `path` is `root` or below it.
 */
function isInside(root, path) {
  const suffix = relative(root, path)
  return suffix === ''
    || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
}

/**
 * Compare two normalized paths with the host filesystem's case rules.
 * @param left - normalized path.
 * @param right - normalized path.
 * @returns whether they name the same path.
 */
function samePath(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
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
 * A failing job lookup is an error rather than "no job": an unknown writer must
 * not be mistaken for a cold Session.
 * @param ctx - Host context carrying the optional live registries.
 * @param sessionIds - Sessions about to be deleted.
 * @returns the live Session id and what holds it, or undefined when every one is cold.
 */
async function findLive(ctx, sessionIds) {
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
  return undefined
}

/**
 * Run the liveness check and keep an unavailable registry distinct from cold.
 * @param ctx - Host context.
 * @param sessionIds - Sessions about to be deleted.
 * @returns `{ session }` for a live one, `{ error }` when the check failed, or `{}`.
 */
async function checkLive(ctx, sessionIds) {
  try {
    const session = await findLive(ctx, sessionIds)
    return session === undefined ? {} : { session }
  } catch (error) {
    return { error: describe(error) }
  }
}

/**
 * Whether a live Session outside the deletion tree has an unmaterialized log.
 *
 * The JSONL backend keeps a just-created Session in memory until its first
 * append/flush. Reading it through `open(..., 'read')` returns an empty prefix,
 * so its attachment references cannot be discovered. This is an unknown
 * reference, not an empty one; attachment cleanup must keep everything.
 * @param ctx - Host context.
 * @param persistence - Session persistence service.
 * @param tree - Sessions being deleted.
 * @returns true when a surviving live Session is still pending.
 */
function hasPendingSurvivingSession(ctx, persistence, tree) {
  if (typeof persistence.hasPendingSession !== 'function') return false
  const sessions = ctx.get('sessions')
  if (sessions === undefined || typeof sessions.list !== 'function') return false
  const deleting = new Set(tree)
  let live
  try {
    live = sessions.list()
  } catch {
    return true
  }
  for (const session of live) {
    const id = String(session?.id ?? '')
    if (id === '' || deleting.has(id)) continue
    try {
      if (persistence.hasPendingSession(id)) return true
    } catch {
      return true
    }
  }
  return false
}

/**
 * Remove every reminder whose destination is one of the Sessions leaving the
 * catalog, so a later delivery cannot activate or write the Session during
 * deletion. This targets the schedule API shipped from 0.2.2-rc.1:
 * `target: { kind, sessionId }` plus `schedule.edit({ action: 'delete' })`.
 *
 * The list is re-read after deletion so a concurrent retarget/creation is not
 * silently missed. Any failure aborts the session deletion before log removal.
 * @param ctx - Host context; the schedule service is optional.
 * @param sessionIds - Sessions leaving the catalog.
 * @returns the removed count, or an error description.
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
      return { error: `reminder list failed: ${describe(error)}` }
    }
    const targets = []
    for (const task of tasks) {
      if (task !== null && typeof task === 'object' && task.target === undefined
        && typeof task.sessionId === 'string') {
        return { error: 'the mounted schedule service uses the unsupported pre-0.2.2 API' }
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
        return { error: `reminder "${String(task?.id)}" failed: ${describe(error)}` }
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
    if (!progress) return { error: 'reminder deletion made no progress' }
  }
  return { error: 'reminders still target the session after retries' }
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
    if (tasks.length >= Number(page.total ?? 0) || tasks.length === before) break
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
 * @param storagesRoot - the resolved storage-domain root.
 * @param directory - the projection-cache session directory.
 * @param sessionIds - Sessions being deleted.
 * @returns the number of removed cache files.
 */
async function deleteProjectionCache(storagesRoot, directory, sessionIds) {
  const safeIds = sessionIds.filter((id) => STORAGE_RECORD_KEY.test(id))
  if (safeIds.length === 0) return 0
  const baseInfo = await realpathOrError(storagesRoot)
  if (baseInfo.error !== undefined) return 0
  const directoryInfo = await inspectPath(directory)
  if (directoryInfo.entry === undefined || !directoryInfo.entry.isDirectory() || directoryInfo.entry.isSymbolicLink()) {
    return 0
  }
  const realDirectory = await realpathOrError(directory)
  if (realDirectory.error !== undefined || !isInside(baseInfo.path, realDirectory.path)) return 0
  if (relative(baseInfo.path, realDirectory.path) !== join('session_projcache', 'sessions')) return 0
  let entries
  try {
    entries = await readdir(directory)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of entries) {
    for (const id of safeIds) {
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
 * Resolve the storage roots this installation actually uses.
 *
 * The JSONL backend exposes its resolved `root` (and its validated config), so
 * the Session root follows a relocated backend. The attachment store exposes its
 * resolved `root` too, which keeps a profile-configured `dshHome` correct. A
 * service that exposes no root is not assumed to use the default directory:
 * deleting files there could touch another backend's data.
 *
 * The local spill backend exposes `root`; a remote spill backend does not, and
 * its files are left to that backend's retention.
 *
 * Derived caches remain under the Harness home: the shipped composition mounts
 * the storage-domain backend at `<home>/storages`.
 * @param ctx - Host context.
 * @returns resolved roots; `sessionRoot`, `attachmentsRoot`, and `spillRoot` are
 * undefined when the mounted service does not expose one.
 */
function resolveLocations(ctx) {
  const persistence = ctx?.get?.('sessionPersistence')
  const exposedRoot = persistence?.root
  const configuredRoot = typeof exposedRoot === 'string' && exposedRoot !== ''
    ? exposedRoot
    : persistence?.config?.root
  const sessionRoot = typeof configuredRoot === 'string' && configuredRoot !== ''
    ? resolve(configuredRoot)
    : undefined

  const home = resolveHome()
  const attachmentRoot = ctx?.get?.('attachments')?.root
  const attachmentsRoot = typeof attachmentRoot === 'string' && attachmentRoot !== ''
    ? resolve(attachmentRoot)
    : undefined
  const spillRootValue = ctx?.get?.('spillStore')?.root
  const spillRoot = typeof spillRootValue === 'string' && spillRootValue !== ''
    ? resolve(spillRootValue)
    : undefined
  const storagesRoot = join(home, 'storages')

  return {
    sessionRoot,
    attachmentsRoot,
    spillRoot,
    storagesRoot,
    projectionCacheRoot: join(storagesRoot, 'session_projcache', 'sessions'),
  }
}

/**
 * The harness home: `DSH_HOME` or `~/.dsh`, with the same tilde expansion and
 * absolute normalization as `resolveDshHome` in `dsh-home-paths`.
 * @returns the resolved Harness home.
 */
function resolveHome() {
  const configured = process.env.DSH_HOME
  const selected = configured === undefined || configured.trim() === ''
    ? join(homedir(), '.dsh')
    : expandHome(configured)
  return resolve(selected)
}

/**
 * Expand the tilde forms `resolveDshHome` accepts.
 * @param value - configured path.
 * @returns the expanded path.
 */
function expandHome(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
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
 * @returns the existing Session directories.
 */
async function findSessionDirectories(root, sessionId) {
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (isAbsentError(error)) return []
    throw error
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
 * A snapshot's `location.path` is the backend's authoritative artifact path.
 * When present, the scanned directory must be its parent, so a catalog that
 * names one copy of a duplicated id cannot delete another copy. Without a
 * location (older backends/pending sessions), zero or one scanned directory is
 * accepted; more than one is ambiguous and refuses the whole operation.
 * @param root - the sessions root.
 * @param sessionIds - the deletion tree, root first.
 * @param byId - catalog snapshots keyed by Session id.
 * @returns planned directories, or an error that must abort before any deletion.
 */
async function planSessionDirectories(root, sessionIds, byId) {
  const plans = []
  for (const id of sessionIds) {
    let directories
    try {
      directories = await findSessionDirectories(root, id)
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
    const locationPath = byId.get(id)?.location?.path
    const expected = typeof locationPath === 'string' && isAbsolute(locationPath)
      ? resolve(dirname(locationPath))
      : undefined
    if (expected !== undefined && !samePath(resolve(directory), expected)) {
      return {
        code: 'ambiguous',
        detail: `session "${id}" directory does not match its catalog location`,
        failed: [{ sessionId: id, code: 'ambiguous', directory, expected }],
      }
    }
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
 * Remove one planned Session directory after re-proving it has not been
 * replaced by a link since planning. This re-resolves both sides immediately
 * before removal, narrowing the path-swap window.
 * @param root - the sessions root.
 * @param directory - the planned directory under the root.
 */
async function removeSessionDirectory(root, directory) {
  const rootInfo = await realpathOrError(root)
  if (rootInfo.error !== undefined) throw rootInfo.error
  const directoryInfo = await realpathOrError(directory)
  if (directoryInfo.error !== undefined) throw directoryInfo.error
  if (!isInside(rootInfo.path, directoryInfo.path)) {
    throw new Error('refusing to delete a directory that resolves outside the session root')
  }
  const info = await inspectPath(directory)
  if (info.error !== undefined) throw info.error
  if (info.entry === undefined || !info.entry.isDirectory() || info.entry.isSymbolicLink()) {
    throw new Error('refusing to delete a session directory that is no longer a plain directory')
  }
  await rm(directory, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 })
}

/**
 * Remove the spill directory owned by deleted Sessions when no surviving
 * Session descends from the deleted tree.
 *
 * Spill locators are file paths inside the owning Session's spill directory.
 * Forked or spawned descendants inherit the parent's events and may keep using
 * those paths, so a surviving descendant keeps every deleted tree's spill files
 * rather than risking a broken locator. Non-local spill backends expose no
 * `root`; their retention policy owns cleanup.
 * @param root - resolved spill root, when the backend exposes one.
 * @param byId - catalog snapshots keyed by Session id.
 * @param sessionIds - Sessions whose directories are gone.
 * @param catalog - the stored-directory catalog; an incomplete catalog keeps all.
 * @returns counts, or undefined when no local spill root is available.
 */
async function deleteSpillDirectories(root, byId, sessionIds, catalog) {
  if (root === undefined) return undefined
  if (catalog === undefined || catalog.incomplete === true
    || catalog.unaccounted.length > 0 || catalog.duplicates.length > 0) {
    return { deleted: 0, kept: sessionIds.length, failed: 0, status: 'unverified' }
  }
  if (hasSurvivingDescendant(byId, new Set(sessionIds))) {
    return { deleted: 0, kept: sessionIds.length, failed: 0 }
  }
  const rootInfo = await realpathOrError(root)
  if (rootInfo.error !== undefined) {
    return isAbsentError(rootInfo.error)
      ? { deleted: 0, kept: 0, failed: 0 }
      : { deleted: 0, kept: 0, failed: 0, status: 'unavailable' }
  }
  let deleted = 0
  let failed = 0
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
    if (realDirectory.error !== undefined || !isInside(rootInfo.path, realDirectory.path)) {
      failed += 1
      continue
    }
    try {
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      deleted += 1
    } catch {
      failed += 1
    }
  }
  return { deleted, kept: 0, failed }
}

/**
 * Whether any surviving Session descends from the deleted tree.
 * @param byId - catalog snapshots keyed by Session id.
 * @param deleted - deleted Session ids.
 * @returns true when a surviving header's parent chain reaches a deleted id.
 */
function hasSurvivingDescendant(byId, deleted) {
  for (const [id, snapshot] of byId) {
    if (deleted.has(id)) continue
    let parent = String(snapshot?.header?.parentSession ?? '')
    const seen = new Set([id])
    for (let depth = 0; parent !== '' && depth < MAX_TREE_DEPTH; depth += 1) {
      if (deleted.has(parent)) return true
      if (seen.has(parent)) break
      seen.add(parent)
      parent = String(byId.get(parent)?.header?.parentSession ?? '')
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
    case 'ambiguous':
    case 'directory-missing':
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
