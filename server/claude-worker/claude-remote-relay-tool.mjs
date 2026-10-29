/**
 * The relay's `relay_tool` tool for the Claude worker, shaped as an SDK MCP
 * tool definition (`{ name, description, inputSchema, handler }`) so the
 * adapter can hand it to `createSdkMcpServer` next to the preview tool. On the
 * wire it is `mcp__relay__relay_tool`; the module never imports the SDK.
 */

import * as z from 'zod';

import {
  REMOTE_RELAY_ACTIONS,
  REMOTE_RELAY_IF_BUSY,
  REMOTE_RELAY_MODES,
  REMOTE_RELAY_SESSION_SCOPES,
  REMOTE_RELAY_THINKING_DISPLAYS,
} from '../../shared/remote-relay-contract.mjs';
import { RELAY_ASK_URGENCIES } from '../../shared/relay-asks.mjs';
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
  // Free text: the worker outlives relay updates, the relay checks the id.
  provider: text('provider'),
  model: text('model'),
  cwd: text('cwd'),
  repo: text('repo'),
  branch: text('branch'),
  mode: choice('mode', REMOTE_RELAY_MODES),
  effort: text('effort'),
  title: text('title'),
  // The one exception to the parity with the JSON schema: Claude may send
  // null for update_session's group (out of the group), as "none" does on
  // the providers whose strict schemas take a string only.
  group: z.string().nullable().optional().describe(FIELDS.group.description),
  auto_compact_window: number('auto_compact_window'),
  thinking_enabled: z.boolean().optional().describe(FIELDS.thinking_enabled.description),
  planOnly: z.boolean().optional().describe(FIELDS.planOnly.description),
  thinking_display: choice('thinking_display', REMOTE_RELAY_THINKING_DISPLAYS),
  question_id: text('question_id'),
  // ask: the contract's validator refuses a question or detail that is too
  // long, or more than eight options, with a message the model can act on.
  question: text('question'),
  options: z.array(z.string()).optional().describe(FIELDS.options.description),
  recommendation: text('recommendation'),
  detail: text('detail'),
  urgency: choice('urgency', RELAY_ASK_URGENCIES),
  answer: text('answer'),
  choices: z.array(z.string()).optional().describe(FIELDS.choices.description),
  if_busy: choice('if_busy', REMOTE_RELAY_IF_BUSY),
  sessions: z.array(z.string()).optional().describe(FIELDS.sessions.description),
  // Free text like effort: the relay checks the names and says which exist.
  events: z.array(z.string()).optional().describe(FIELDS.events.description),
  once: z.boolean().optional().describe(FIELDS.once.description),
  match: text('match'),
  stalled_minutes: number('stalled_minutes'),
  heartbeat_minutes: number('heartbeat_minutes'),
  digest_minutes: number('digest_minutes'),
  // Loose and every field optional: the contract's validator checks the
  // times and the zone and says what is wrong; an empty one is no option.
  quiet_hours: z.looseObject({
    from: z.string().optional().describe(FIELDS.quiet_hours.properties.from.description),
    to: z.string().optional().describe(FIELDS.quiet_hours.properties.to.description),
    tz: z.string().optional().describe(FIELDS.quiet_hours.properties.tz.description),
  }).optional().describe(FIELDS.quiet_hours.description),
  // A list, or the comma-separated text the contract takes as well.
  exclude: z.union([z.array(z.string()), z.string()]).optional().describe(FIELDS.exclude.description),
  subscription_id: text('subscription_id'),
  watcher: text('watcher'),
  from: text('from'),
  at: text('at'),
  every_minutes: number('every_minutes'),
  schedule_id: text('schedule_id'),
  task_id: text('task_id'),
  lines: number('lines'),
};

// What the tool registers: the shape as a loose object. A raw shape becomes a
// strict-stripping object in the SDK's MCP layer, which would drop a key the
// schema lacks before the contract's validator could refuse it (create_session)
// or name it in `ignored` (the other actions). The loose object lets it through.
export const REMOTE_RELAY_TOOL_ZOD_SCHEMA = z.looseObject(REMOTE_RELAY_TOOL_ZOD_SHAPE);

export function createRemoteRelayToolDefinition({ api, getConversationId = () => '', dbg = () => {} } = {}) {
  return {
    name: REMOTE_RELAY_TOOL_NAME,
    description: REMOTE_RELAY_TOOL_DESCRIPTION,
    inputSchema: REMOTE_RELAY_TOOL_ZOD_SCHEMA,
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
        dbg('relay_tool failed', message);
        result = { ok: false, code: REMOTE_RELAY_CALL_FAILED, error: message };
      }
      return { content: [{ type: 'text', text: formatRemoteRelayToolResult(result) }] };
    },
  };
}
