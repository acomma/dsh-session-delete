/**
 * Single-process test entry.
 *
 * `node --test` spawns one child per file, which some sandboxes deny; importing
 * every suite registers its tests in this process instead, so `npm test` works
 * the same everywhere and still reports one combined summary.
 */
import './session-delete.test.mjs'
import './workspace-purge.test.mjs'
import './workspace-option.test.mjs'
import './routes.test.mjs'
