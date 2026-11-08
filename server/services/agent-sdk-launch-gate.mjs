'use strict';

/**
 * The launch gate of the agent SDKs (agent-sdk-store.mjs): which SDK folder
 * a worker is launched with, and what happens while there is none.
 *
 * A worker kind on an SDK (the Claude workers on Claude's, Cursor on its
 * own) gets the store's ready folder, which it keeps for its whole life. A
 * checkout's devDependency needs no folder. A missing SDK is never waited
 * for: the gate starts (or joins) its install, puts an "Installing the …
 * SDK" note in the conversation, and answers `deferred` at once. The
 * supervisor counts that as no launch and no failure, so the request that
 * asked for the worker (a new chat, a send, the queue's prime) answers right
 * away and the turn stays queued. When the install ends, and whenever the
 * SDK turns ready later (the Retry button, the automatic retry), the
 * sessions that met the gate get their launch back (`onSessionsReleased`):
 * their restart schedule is cleared and the queue is woken.
 *
 * An SDK that failed, or has no build for this platform, stops the launch
 * with one line naming the Settings tab; the worker launch note carries it
 * and the message stays queued for the Retry.
 */

export const AGENT_SDK_INSTALLING = 'agent-sdk-installing';

/**
 * Whether a stale worker of `kind` may lose its SDK's files to an update,
 * so the recycle replaces it before its next message: a kind on an agent
 * SDK the store installs. One whose SDK comes from a git checkout's
 * node_modules keeps its files across a restart on new code, and is
 * recycled like any worker (between turns, once its CLI child is idle).
 */
export function staleWorkerLosesAgentSdk(kind, { sdkForWorkerKind, fromCheckout }) {
  const sdk = sdkForWorkerKind(kind);
  return sdk !== null && !fromCheckout(sdk);
}

export function createAgentSdkLaunchGate({
  store,
  sdkForWorkerKind,
  resolveSource,
  noteInstalling = () => {},
  onSessionsReleased = () => {},
  logger = console,
} = {}) {
  if (!store) throw new Error('createAgentSdkLaunchGate requires a store');
  // Per SDK, the sessions whose launch met the gate and waits for it.
  const waiting = new Map();
  // Per SDK, an install this gate already follows to its end.
  const following = new Set();

  const log = (message) => {
    try { logger?.log?.(`[agent-sdk] ${message}`); } catch {}
  };

  function remember(sdk, sdkSessionId) {
    if (!waiting.has(sdk)) waiting.set(sdk, new Set());
    waiting.get(sdk).add(sdkSessionId);
  }

  /** Hands every session that waited on `sdk` its launch back. */
  function release(sdk, reason) {
    const sessions = [...(waiting.get(sdk) || [])];
    waiting.delete(sdk);
    if (!sessions.length) return [];
    log(`${sdk}: ${reason}; ${sessions.length} waiting session(s) may launch`);
    try { onSessionsReleased({ sdk, sessions, reason }); } catch (error) {
      log(`${sdk}: releasing the waiting sessions failed: ${error?.message || error}`);
    }
    return sessions;
  }

  function follow(sdk) {
    if (following.has(sdk)) return;
    following.add(sdk);
    Promise.resolve(store.ensure(sdk, { reason: 'first chat' }))
      .catch((error) => log(`${sdk}: install failed: ${error?.message || error}`))
      .finally(() => {
        following.delete(sdk);
        // Ready or failed: the next launch says which.
        release(sdk, 'install ended');
      });
  }

  /**
   * What the launch of `sdkSessionId` (worker kind `workerKind`) does:
   * `{ sdk: null }` (no SDK, or a checkout's devDependency),
   * `{ sdk, dir }` (launch with this folder), or `{ sdk, deferred }` (not
   * launched now). Throws for an SDK that failed or has no build here.
   */
  function check(sdkSessionId, workerKind) {
    const sdk = sdkForWorkerKind(workerKind);
    if (!sdk) return { sdk: null };
    const found = resolveSource(sdk);
    if (found?.source === 'checkout') return { sdk: null };
    if (found?.dir) return { sdk, dir: found.dir };
    const status = store.status(sdk);
    const label = store.getDescriptor?.(sdk)?.label || status?.label || sdk;
    if (status && ['error', 'unsupported'].includes(status.state) && !status.active) {
      // Remembered too: a Retry that brings the SDK back launches it.
      remember(sdk, sdkSessionId);
      const tab = sdk === 'cursor' ? 'Cursor' : 'Claude';
      const why = status.state === 'unsupported'
        ? `${label} is not available on this platform`
        : `${label} could not be installed: ${status.error || 'unknown error'}`;
      throw new Error(`${why} (Settings → Providers → ${tab})`);
    }
    remember(sdk, sdkSessionId);
    try { noteInstalling(sdkSessionId, { sdk, label }); } catch {}
    follow(sdk);
    return { sdk, deferred: AGENT_SDK_INSTALLING };
  }

  /** The store's ready hook: an SDK that came back launches its waiters. */
  function onReady(sdk) {
    return release(sdk, 'ready');
  }

  return {
    check,
    onReady,
    waitingSessions: (sdk) => [...(waiting.get(sdk) || [])],
  };
}
