// Where a Claude background shell writes its output, read off the SDK stream.
//
// The CLI writes every Bash task (and every Monitor tool task, which is a
// `local_bash` task of kind "monitor") to `<tasks dir>/<taskId>.output`, and
// tells the model the path in the Bash tool's result text: "Command running in
// background with ID: <id>. Output is being written to: <path>." (wording
// read from the bundled CLI, SDK 0.3.292). The structured result
// (`SDKUserMessage.tool_use_result`, a BashOutput) names the task id as
// `backgroundTaskId` but carries no path of its own. `task_notification`
// repeats the path as `output_file` when the task ends.
import nodePath from 'node:path';

/** Task types whose output is a shell's stdout/stderr (getTaskOutput serves these too). */
export const SHELL_TASK_TYPES = new Set(['local_bash', 'monitor', 'monitor_mcp', 'monitor_ws']);
export const MAX_OUTPUT_PATH_CHARS = 1024;
// The command line a shell row carries. The relay scrubs it, then cuts it
// to 2,000 characters: a cut here first could split a credential it would
// no longer recognise, so this one is only a bound on the post.
export const MAX_TASK_COMMAND_CHARS = 8000;
// The tools whose call starts a shell task: their input's `command` is the
// task's command line (the console marks a `| tail` from it).
const SHELL_TOOL_NAMES = new Set(['Bash', 'Monitor']);

const OUTPUT_MARKER = 'Output is being written to';
// The CLI's own file name: a path with spaces (a Windows profile dir) still
// reads whole, up to its `.output` and the sentence's full stop.
const OUTPUT_FILE_PATTERN = /Output is being written to:?\s+([^\n;]+?\.output)(?=[.;,]?(?:\s|$))/;
// Any other shape: one token, without the trailing punctuation.
const OUTPUT_TOKEN_PATTERN = /Output is being written to:?\s+(\S+?)[.;,]?(?:\s|$)/;
const TASK_ID_PATTERN = /\bID:\s*([A-Za-z0-9_-]+)/;
// What the CLI's own background notes start with (Bash, SDK 0.3.292). A
// foreground command that merely prints "Output is being written to: ..."
// must never bind a path to a task, so only these, the MCP form below, or a
// result whose structured output names the task are read.
const CLI_BACKGROUND_PREFIXES = [
  'Command running in background',
  'Command was manually backgrounded',
  'Command was moved to the background',
  'Command did not complete within',
];
// The backgrounded MCP task's note: no colon, then "; use <tool> on that path".
const MCP_BACKGROUND_PATTERN = /Output is being written to (\S[^\n;]*?\.output); use \S/;

export function isShellTaskType(taskType) {
  return SHELL_TASK_TYPES.has(String(taskType || '').trim());
}

/** An absolute path of sane length, or ''. Windows shapes count on every host. */
export function usableOutputPath(value) {
  const text = String(value || '').trim();
  if (!text || text.length > MAX_OUTPUT_PATH_CHARS) return '';
  return nodePath.posix.isAbsolute(text) || nodePath.win32.isAbsolute(text) ? text : '';
}

/** `.../tasks/b8k2m4x7q.output` → `b8k2m4x7q`. */
function taskIdFromOutputFile(filePath) {
  const base = String(filePath).split(/[\\/]/).pop() || '';
  return base.endsWith('.output') ? base.slice(0, -'.output'.length) : '';
}

/** The directory part of a path, for either separator. */
export function outputDirOf(filePath) {
  const text = String(filePath || '');
  const cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
  return cut > 0 ? text.slice(0, cut) : '';
}

function toolResultText(block) {
  const content = block?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

/** `{ taskId, outputPath }` from one tool result's text, or null. */
export function parseOutputAnnouncement(text, knownTaskId = '') {
  const source = String(text || '');
  if (!source.includes(OUTPUT_MARKER)) return null;
  const match = source.match(OUTPUT_FILE_PATTERN) || source.match(OUTPUT_TOKEN_PATTERN);
  const outputPath = usableOutputPath(match?.[1]);
  if (!outputPath) return null;
  const taskId = String(knownTaskId || '').trim()
    || taskIdFromOutputFile(outputPath)
    || (source.match(TASK_ID_PATTERN)?.[1] || '');
  return taskId ? { taskId, outputPath } : null;
}

/** The CLI's own note about a backgrounded call, not a command's printed output. */
function isBackgroundNote(text) {
  const source = String(text || '').trimStart();
  if (CLI_BACKGROUND_PREFIXES.some((prefix) => source.startsWith(prefix))) return true;
  const mcp = source.match(MCP_BACKGROUND_PATTERN);
  return Boolean(mcp && taskIdFromOutputFile(mcp[1]));
}

/**
 * `{ toolUseId, command }` of each Bash or Monitor call in an `assistant` SDK
 * message: the command line of the task such a call starts in the
 * background, cut at 8,000 characters (the relay cuts after scrubbing).
 */
export function shellCommandsOf(sdkMessage) {
  if (String(sdkMessage?.type || '') !== 'assistant') return [];
  const blocks = Array.isArray(sdkMessage?.message?.content) ? sdkMessage.message.content : [];
  const found = [];
  for (const block of blocks) {
    if (block?.type !== 'tool_use' || !SHELL_TOOL_NAMES.has(String(block.name || ''))) continue;
    const toolUseId = String(block.id || '').trim();
    const command = typeof block.input?.command === 'string' ? block.input.command.trim().slice(0, MAX_TASK_COMMAND_CHARS) : '';
    if (toolUseId && command) found.push({ toolUseId, command });
  }
  return found;
}

/**
 * Every task output file a `user` SDK message announces: the tool_result
 * blocks of backgrounded Bash (and Monitor) calls, with the id of the call
 * (`toolUseId`, '' when the block names none). The structured result's
 * `backgroundTaskId` names the task when the message answers a single call.
 */
export function discoverTaskOutputPaths(sdkMessage) {
  if (String(sdkMessage?.type || '') !== 'user') return [];
  const blocks = Array.isArray(sdkMessage?.message?.content) ? sdkMessage.message.content : [];
  const results = blocks.filter((block) => block?.type === 'tool_result');
  if (!results.length) return [];
  const structured = sdkMessage.tool_use_result && typeof sdkMessage.tool_use_result === 'object'
    ? sdkMessage.tool_use_result
    : null;
  const structuredTaskId = results.length === 1 ? String(structured?.backgroundTaskId || '').trim() : '';
  const found = [];
  for (const block of results) {
    const text = toolResultText(block);
    if (!structuredTaskId && !isBackgroundNote(text)) continue;
    const announced = parseOutputAnnouncement(text, structuredTaskId);
    if (announced) found.push({ ...announced, toolUseId: String(block.tool_use_id || '').trim() });
  }
  return found;
}

/**
 * The exit code a shell task's settle summary names: `Background command
 * "npm test" failed with exit code 2` / `... completed (exit code 0)`.
 * The last mention wins (the command's own description may say "exit code").
 */
export function exitCodeFromSummary(summary) {
  const matches = [...String(summary || '').matchAll(/exit code (-?\d+)/gi)];
  if (!matches.length) return null;
  const code = Number(matches[matches.length - 1][1]);
  return Number.isInteger(code) ? code : null;
}
