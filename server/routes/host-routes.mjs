'use strict';

// The host routes (the workspace root, the session worker launch, the
// deferred host suspend and the usage-limit pauses), registered by
// registerSessionsRoutes.
import { sessionLaunchMutex } from '../services/session-launch-mutex-service.mjs';
import { launchWorkspaceRootSession } from './sessions-helpers.mjs';

export function registerHostRoutes(app, deps, shared) {
  const {
    auth,
    io,
    runtimeState,
    workspaceRootPayload,
    setWorkspaceRoot,
    sessionWorkerSupervisor,
    sessionWorkerRegistry,
  } = deps;
  const {
    hostSuspendService,
    collectHostActivity,
    hostSuspendPlatform,
    usageLimitPauseService,
  } = shared;

  app.post('/api/workspace-root', auth, (req, res) => {
    const nextRootPath = String(req.body?.rootPath || req.body?.workspaceRootPath || '').trim();
    if (!nextRootPath) {
      return res.status(400).json({ error: 'Missing rootPath' });
    }
    if (typeof setWorkspaceRoot !== 'function') {
      return res.status(500).json({ error: 'Workspace root updates are unavailable' });
    }

    const result = setWorkspaceRoot(nextRootPath, { reason: 'manual-ui-change' });
    if (!result?.changed && result?.error) {
      return res.status(400).json({ error: result.error });
    }

    const payload = workspaceRootPayload();
    io.emit('workspace_root_changed', payload);
    return res.json({
      ok: true,
      changed: !!result?.changed,
      ...payload,
    });
  });

  app.post('/api/session-worker/:sdkSessionId/launch', auth, async (req, res) => {
    const sdkSessionId = String(req.params.sdkSessionId || '').trim();
    // Shares the launch path with the CWD relaunch route, so it must share the
    // lock too — otherwise it can interleave between that route's stop and spawn.
    const attempt = await sessionLaunchMutex.tryRunExclusive(
      sdkSessionId,
      () => launchWorkspaceRootSession(runtimeState, sessionWorkerSupervisor, sdkSessionId, sessionWorkerRegistry, {
        failCopilotRowsWithoutLaunch: deps.failCopilotRowsWithoutLaunch,
      }),
    );
    if (attempt.busy) {
      return res.status(409).json({
        ok: false,
        code: 'relaunch_in_progress',
        error: 'Another launch is already running for this session.',
      });
    }
    const result = attempt.result;
    if (!result?.ok) {
      return res.status(result?.statusCode || 400).json({
        ok: false,
        ...(result?.code ? { code: result.code } : {}),
        error: result?.error || 'launch-failed',
        worker: result?.worker || null,
        lifecycle: result?.lifecycle || null,
      });
    }
    return res.json({
      ok: true,
      ...result,
    });
  });

  // Deferred host suspend: the request is queued and fulfilled by the
  // host-suspend service once nothing runs any more (see
  // docs/plans/2026-09-27-deferred-host-suspend.md).
  app.get('/api/host/suspend', auth, (req, res) => {
    if (!hostSuspendService) {
      return res.status(501).json({ ok: false, error: 'Host suspend is unavailable' });
    }
    const state = hostSuspendService.refresh();
    let activity = null;
    if (!state.pending && typeof collectHostActivity === 'function') {
      try {
        activity = collectHostActivity({ request: null });
      } catch (error) {
        activity = { blockers: [], error: String(error?.message || error) };
      }
    }
    return res.json({
      ok: true,
      supported: hostSuspendPlatform === 'win32',
      state,
      blockers: state.pending ? state.blockers : (activity?.blockers || []),
      activity,
    });
  });

  app.post('/api/host/suspend', auth, (req, res) => {
    if (!hostSuspendService) {
      return res.status(501).json({ ok: false, error: 'Host suspend is unavailable' });
    }
    if (hostSuspendPlatform !== 'win32') {
      return res.status(501).json({ ok: false, error: 'Host suspend is only supported on Windows' });
    }
    const reason = String(req.body?.reason || 'manual-suspend').trim().slice(0, 140) || 'manual-suspend';
    const requestedBy = String(req.body?.requestedBy || 'localhost-api').trim().slice(0, 80) || 'localhost-api';
    const result = hostSuspendService.request({ reason, requestedBy });
    return res.status(202).json({
      ok: true,
      queued: true,
      accepted: result.accepted !== false,
      alreadyPending: !!result.alreadyPending,
      state: result.state,
    });
  });

  app.post('/api/host/suspend/cancel', auth, (req, res) => {
    if (!hostSuspendService) {
      return res.status(501).json({ ok: false, error: 'Host suspend is unavailable' });
    }
    const requestedBy = String(req.body?.requestedBy || 'localhost-api').trim().slice(0, 80) || 'localhost-api';
    const result = hostSuspendService.cancel({ requestedBy });
    return res.json({ ok: true, cancelled: !!result.cancelled, state: result.state });
  });

  // Turns paused at the Claude usage limit (usage-limit-pause-service): the
  // held follow-up can be sent before the reset, or dropped.
  app.get('/api/usage-limit', auth, (req, res) => {
    if (!usageLimitPauseService) {
      return res.status(501).json({ ok: false, error: 'Usage limit handling is unavailable' });
    }
    return res.json({
      ok: true,
      account: usageLimitPauseService.getAccountState(),
      pauses: usageLimitPauseService.listPauses(),
    });
  });

  app.post('/api/usage-limit/resume', auth, (req, res) => {
    if (!usageLimitPauseService) {
      return res.status(501).json({ ok: false, error: 'Usage limit handling is unavailable' });
    }
    const conversationId = String(req.body?.conversationId || '').trim();
    if (!conversationId) return res.status(400).json({ ok: false, error: 'Missing conversationId' });
    const result = usageLimitPauseService.resumeNow({ conversationId });
    return res.json({ ok: true, resumed: !!result.resumed, messageId: result.messageId || null, pause: result.state });
  });

  app.post('/api/usage-limit/cancel', auth, (req, res) => {
    if (!usageLimitPauseService) {
      return res.status(501).json({ ok: false, error: 'Usage limit handling is unavailable' });
    }
    const conversationId = String(req.body?.conversationId || '').trim();
    if (!conversationId) return res.status(400).json({ ok: false, error: 'Missing conversationId' });
    const result = usageLimitPauseService.cancel({ conversationId });
    return res.json({ ok: true, cancelled: !!result.cancelled, messageId: result.messageId || null, pause: result.state });
  });
}
