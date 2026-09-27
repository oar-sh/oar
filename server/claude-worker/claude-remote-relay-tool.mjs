/**
 * The relay's `remote_relay` tool for the Claude worker, shaped as an SDK MCP
 * tool definition (`{ name, description, inputSchema, handler }`) so the
 * adapter can hand it to `createSdkMcpServer` next to the preview tool. On the
 * wire it is `mcp__relay__remote_relay`; the module never imports the SDK.
 */

import * as z from 'zod';

import {
  REMOTE_RELAY_ACTIONS,
  REMOTE_RELAY_IF_BUSY,
  REMOTE_RELAY_MODES,
  REMOTE_RELAY_PROVIDERS,
  REMOTE_RELAY_SESSION_SCOPES,
} from '../../shared/remote-relay-contract.mjs';
import {
  REMOTE_RELAY_CALL_FAILED,
  REMOTE_RELAY_TOOL_DESCRIPTION,
  REMOTE_RELAY_TOOL_INPUT_SCHEMA,
  REMOTE_RELAY_TOOL_NAME,
  executeRemoteRelayTool,
  formatRemoteRelayToolResult,
} from '../../shared/remote-relay-tool-core.mjs';

const FIELDS = REMOTE_RELAY_TOOL_INPUT_SCHEMA.properties;

function text(field) {
  return z.string().optional().describe(FIELDS[field].description);
}

function choice(field, values) {
  return z.enum([...values]).optional().describe(FIELDS[field].description);
}

function number(field) {
  return z.number().optional().describe(FIELDS[field].description);
}

/**
 * The contract's JSON schema mirrored as a zod raw shape (the SDK's MCP layer
 * accepts zod only). Descriptions and enum values are read from the contract,
 * so the model sees the same field docs on every provider. Numeric bounds are
 * left off on purpose, as on the preview tool: the contract's validator clamps
 * wait_seconds / limit / last / max_chars instead of failing the call.
 */
export const REMOTE_RELAY_TOOL_ZOD_SHAPE = {
  action: z.enum([...REMOTE_RELAY_ACTIONS]).describe(FIELDS.action.description),
  relay: text('relay'),
  session: text('session'),
  text: text('text'),
  message_id: text('message_id'),
  wait_seconds: number('wait_seconds'),
  scope: choice('scope', REMOTE_RELAY_SESSION_SCOPES),
  query: text('query'),
  limit: number('limit'),
  cursor: text('cursor'),
  last: number('last'),
  before: text('before'),
  include_activity: z.boolean().optional().describe(FIELDS.include_activity.description),
  max_chars: number('max_chars'),
  provider: choice('provider', REMOTE_RELAY_PROVIDERS),
  model: text('model'),
  cwd: text('cwd'),
  mode: choice('mode', REMOTE_RELAY_MODES),
  effort: text('effort'),
  title: text('title'),
  question_id: text('question_id'),
  answer: text('answer'),
  choices: z.array(z.string()).optional().describe(FIELDS.choices.description),
  if_busy: choice('if_busy', REMOTE_RELAY_IF_BUSY),
};

export function createRemoteRelayToolDefinition({ api, getConversationId = () => '', dbg = () => {} } = {}) {
  return {
    name: REMOTE_RELAY_TOOL_NAME,
    description: REMOTE_RELAY_TOOL_DESCRIPTION,
    inputSchema: REMOTE_RELAY_TOOL_ZOD_SHAPE,
    // `extra.signal` is the MCP request's: the SDK aborts it when the CLI
    // cancels the call (a Stop interrupting the turn) or the process's MCP
    // transport closes, and the pending relay request goes with it.
    handler: async (args, extra) => {
      let result;
      try {
        result = await executeRemoteRelayTool(args, {
          api,
          conversationId: String(getConversationId() || ''),
          signal: extra?.signal || null,
        });
      } catch (error) {
        // A tool exception would surface as a failed MCP call and can abort
        // the turn; a refusal the model can read cannot.
        const message = error?.message || String(error);
        dbg('remote_relay tool failed', message);
        result = { ok: false, code: REMOTE_RELAY_CALL_FAILED, error: message };
      }
      return { content: [{ type: 'text', text: formatRemoteRelayToolResult(result) }] };
    },
  };
}
