// The relay's `remote_relay` tool for Copilot SDK sessions: a plain SDK
// `Tool` (`{ name, description, parameters, skipPermission, handler }`) built
// from the shared contract and forwarded through the shared tool core. The
// module never imports the SDK; the session process hands the definition to
// `SessionConfig.tools`.
//
// `skipPermission`: the relay does the approving. A write action in ask or
// plan mode raises its own question card server-side, so a runtime permission
// prompt on top would ask the user twice for one action.

import {
  REMOTE_RELAY_CALL_FAILED,
  REMOTE_RELAY_TOOL_DESCRIPTION,
  REMOTE_RELAY_TOOL_NAME,
  cloneRemoteRelayToolInputSchema,
  executeRemoteRelayTool,
  formatRemoteRelayToolResult,
} from '../../shared/remote-relay-tool-core.mjs';

/**
 * `runCall(fn)` wraps every execution — the session process uses it to hold
 * its stall watchdog and idle shutdown while the relay waits on a remote turn.
 * The handler never throws: a failure answers in-band as JSON the model can
 * read, which is what the runtime passes back to it anyway.
 *
 * `getSignal(invocation)` is the call's cancellation. By default the SDK's
 * own `invocation.signal`, which aborts when the runtime completes the
 * request or the session disconnects; the session process adds the turn's
 * Stop to it.
 */
export function buildCopilotRemoteRelayTool({
  api,
  getConversationId = () => '',
  runCall = (fn) => fn(),
  getSignal = (invocation) => invocation?.signal || null,
  dbg = () => {},
} = {}) {
  return {
    name: REMOTE_RELAY_TOOL_NAME,
    description: REMOTE_RELAY_TOOL_DESCRIPTION,
    parameters: cloneRemoteRelayToolInputSchema(),
    skipPermission: true,
    handler: async (args, invocation) => {
      let result;
      try {
        result = await runCall(() => executeRemoteRelayTool(args, {
          api,
          conversationId: String(getConversationId() || ''),
          signal: getSignal(invocation) || null,
        }));
      } catch (error) {
        const message = error?.message || String(error);
        dbg('remote_relay tool failed', message);
        result = { ok: false, code: REMOTE_RELAY_CALL_FAILED, error: message };
      }
      return formatRemoteRelayToolResult(result);
    },
  };
}
