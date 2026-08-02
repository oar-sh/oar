/**
 * The relay's ask_user custom tool for the Cursor worker. SDK-free: the
 * adapter passes the returned `{ description, inputSchema, execute }` into
 * `customTools.ask_user`, and all relay traffic goes through the injected
 * shared ask-user bridge.
 */

export const ASK_USER_TOOL_DESCRIPTION =
  'Ask the user one or more clarifying questions and wait for their answers. '
  + 'This is the ONLY way to ask the user anything: a question written as plain '
  + 'reply text is NOT shown interactively and ends the turn unanswered. Call '
  + 'this tool whenever user input would materially change the result, before '
  + 'making assumptions. Provide 2-4 concise options per question; the user can '
  + 'always answer in free text instead. This tool blocks until the user '
  + 'responds; on timeout it returns an instruction to continue under the '
  + 'current relay mode.';

export const ASK_USER_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      minItems: 1,
      maxItems: 4,
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          header: { type: 'string' },
          multiSelect: { type: 'boolean', default: false },
          options: {
            type: 'array',
            minItems: 2,
            maxItems: 6,
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                description: { type: 'string' },
              },
              required: ['label'],
            },
          },
        },
        required: ['question', 'options'],
      },
    },
  },
  required: ['questions'],
};

export function createAskUserTool({ bridge, getAbortSignal, dbg = () => {} } = {}) {
  async function execute(args) {
    const signal = getAbortSignal?.();
    try {
      const { answers, timedOut } = await bridge.handleAskUserQuestion(args, { signal });
      const entries = Object.entries(answers || {});
      const text = entries.length
        ? entries.map(([question, answer]) => `Q: ${question}\nA: ${answer}`).join('\n\n')
        : 'No user response.';
      return {
        structuredContent: { answers, timedOut },
        content: [{ type: 'text', text }],
      };
    } catch (error) {
      // A tool exception must never kill the run.
      const message = error?.message || String(error);
      dbg('ask_user bridge failed', message);
      return {
        content: [{
          type: 'text',
          text: `ask_user failed: ${message}. Continue without user input.`,
        }],
      };
    }
  }
  return {
    name: 'ask_user',
    description: ASK_USER_TOOL_DESCRIPTION,
    inputSchema: ASK_USER_INPUT_SCHEMA,
    execute,
  };
}
