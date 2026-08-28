/**
 * The relay's preview custom tool for the Cursor worker. SDK-free: the adapter
 * passes the returned `{ description, inputSchema, execute }` into
 * `customTools.preview`, and every verb runs through the shared preview core
 * against the worker's injected relay API helper.
 */

import {
  PREVIEW_TOOL_DESCRIPTION,
  PREVIEW_TOOL_INPUT_SCHEMA,
  PREVIEW_TOOL_NAME,
  executePreviewTool,
} from '../../shared/preview-tool-core.mjs';

export function createPreviewTool({ api, getConversationId = () => '', dbg = () => {} } = {}) {
  async function execute(args) {
    try {
      const result = await executePreviewTool(args, {
        api,
        conversationId: String(getConversationId() || ''),
      });
      return {
        structuredContent: result,
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    } catch (error) {
      // A tool exception must never kill the run.
      const message = error?.message || String(error);
      dbg('preview tool failed', message);
      return {
        content: [{
          type: 'text',
          text: `preview failed: ${message}. Continue without publishing a preview.`,
        }],
      };
    }
  }
  return {
    name: PREVIEW_TOOL_NAME,
    description: PREVIEW_TOOL_DESCRIPTION,
    inputSchema: PREVIEW_TOOL_INPUT_SCHEMA,
    execute,
  };
}
