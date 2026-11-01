/**
 * The per-session launch mutex, one for the whole relay process, keyed by
 * sdkSessionId.
 *
 * What runs under it: the Change CWD relaunch, the launch route and the
 * delete and archive routes (sessions-routes.mjs), the worker recycle's
 * recycle, archived stop and launch retry (worker-recycle-service.mjs), and
 * the archived sweep at relay start (sweepArchivedWorkers there). What does
 * not: the Claude billing swap, which keeps the old worker away from the
 * rows by its own delivery fence; the send path's ensureWorker; and the kill
 * route (messages-routes.mjs), so a Kill that lands in a recycle's window
 * between its stop and its launch (about 3 s) can look undone, because the
 * launch starts a fresh idle worker. No turn is cut by that. Taking the
 * mutex in those places is a follow-up.
 *
 * It used to be built inside the sessions routes' registration, where nothing
 * outside the routes could take it, so a recycle could stop a worker while a
 * relaunch was half done. A module singleton is the one place both import.
 */

import { createKeyedMutex } from './keyed-mutex-service.mjs';

export const sessionLaunchMutex = createKeyedMutex();
