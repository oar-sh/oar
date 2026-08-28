/**
 * The relay's `preview` tool for the Claude worker, shaped as an SDK MCP tool
 * definition (`{ name, description, inputSchema, handler }`) so the adapter can
 * hand it to `createSdkMcpServer` and this module never imports the agent SDK.
 */

import * as z from 'zod';

import {
  PREVIEW_TOOL_DESCRIPTION,
  PREVIEW_TOOL_INPUT_SCHEMA,
  PREVIEW_TOOL_NAME,
  executePreviewTool,
} from '../../shared/preview-tool-core.mjs';

const FIELDS = PREVIEW_TOOL_INPUT_SCHEMA.properties;

/**
 * The shared JSON schema mirrored as a zod raw shape: the SDK's MCP layer
 * accepts zod only and throws on a plain JSON Schema object, so the two
 * spellings have to coexist. Descriptions are read from the shared schema
 * rather than retyped, and the value constraints (port range, token pattern,
 * label length) are deliberately left off — a value rejected here never
 * reaches the handler, and the core's validator returns a message written for
 * the model instead of an MCP schema error.
 */
export const PREVIEW_TOOL_ZOD_SHAPE = {
  action: z.enum(['create', 'list', 'close']).describe(FIELDS.action.description),
  port: z.number().optional().describe(FIELDS.port.description),
  dir: z.string().optional().describe(FIELDS.dir.description),
  label: z.string().optional().describe(FIELDS.label.description),
  token: z.string().optional().describe(FIELDS.token.description),
};

export function createPreviewToolDefinition({ api, getConversationId = () => '', dbg = () => {} } = {}) {
  return {
    name: PREVIEW_TOOL_NAME,
    description: PREVIEW_TOOL_DESCRIPTION,
    inputSchema: PREVIEW_TOOL_ZOD_SHAPE,
    handler: async (args) => {
      let result;
      try {
        result = await executePreviewTool(args, {
          api,
          conversationId: String(getConversationId() || ''),
        });
      } catch (error) {
        // A tool exception would surface as a failed MCP call and can abort
        // the turn; a refusal the model can read cannot.
        const message = error?.message || String(error);
        dbg('preview tool failed', message);
        result = { ok: false, error: message };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  };
}
