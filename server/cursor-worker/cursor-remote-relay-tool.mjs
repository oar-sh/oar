/**
 * The relay's `remote_relay` custom tool for the Cursor worker. SDK-free: the
 * turn runner passes the returned `{ description, inputSchema, execute }` into
 * `customTools.remote_relay`, and every call goes through the shared tool core
 * to the local relay endpoint.
 *
 * A call can legitimately run for many minutes (a remote turn plus an approval
 * card), during which the SDK emits nothing. `onCallStart`/`onCallEnd` bracket
 * every execution — errors included — so the runner can count it as pending
 * client work and hold its stall watchdog, exactly as it does for ask_user.
 *
 * The SDK hands `execute` no cancellation of its own (the context is only
 * `{ toolCallId }`), so `getAbortSignal` supplies the running turn's: a Stop
 * aborts it, which cancels the pending relay request and ends the hold.
 */

import {
  REMOTE_RELAY_CALL_FAILED,
  REMOTE_RELAY_TOOL_DESCRIPTION,
  REMOTE_RELAY_TOOL_NAME,
  cloneRemoteRelayToolInputSchema,
  executeRemoteRelayTool,
  formatRemoteRelayToolResult,
} from '../../shared/remote-relay-tool-core.mjs';

export function createRemoteRelayTool({
  api,
  getConversationId = () => '',
  onCallStart = () => {},
  onCallEnd = () => {},
  getAbortSignal = () => null,
  dbg = () => {},
} = {}) {
  async function execute(args) {
    onCallStart();
    try {
      const result = await executeRemoteRelayTool(args, {
        api,
        conversationId: String(getConversationId() || ''),
        signal: getAbortSignal?.() || null,
      });
      return {
        structuredContent: result,
        content: [{ type: 'text', text: formatRemoteRelayToolResult(result) }],
      };
    } catch (error) {
      // A tool exception must never kill the run.
      const message = error?.message || String(error);
      dbg('remote_relay tool failed', message);
      const result = { ok: false, code: REMOTE_RELAY_CALL_FAILED, error: message };
      return {
        structuredContent: result,
        content: [{ type: 'text', text: formatRemoteRelayToolResult(result) }],
      };
    } finally {
      onCallEnd();
    }
  }
  return {
    name: REMOTE_RELAY_TOOL_NAME,
    description: REMOTE_RELAY_TOOL_DESCRIPTION,
    inputSchema: cloneRemoteRelayToolInputSchema(),
    execute,
  };
}
