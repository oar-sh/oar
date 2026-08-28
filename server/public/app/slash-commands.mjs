// The composer's slash-command registry: the one place a command declares its
// name, description, and completion structure. DOM-free by design — the menu
// (slash-autocomplete.mjs) renders whatever completionsFor() returns, and the
// typo guard in sendMessage() asks matchesKnownCommand(). Adding a command is
// one entry here plus its intercept in sendMessage.

export const SLASH_COMMANDS = [
  {
    name: 'compact',
    description: 'Branch to a fresh conversation seeded with summary context',
    usage: '/compact',
    subcommands: [],
    argHints: [],
  },
  {
    name: 'preview',
    description: 'Publish a port or folder on the public preview URL',
    usage: '/preview <port|dir> [label]',
    subcommands: [
      { name: 'list', description: 'List live previews' },
      { name: 'close', description: 'Close a preview', dynamicArgs: 'previews' },
    ],
    argHints: [
      { hint: '<port>', description: 'proxy an already-running dev server' },
      { hint: '<dir>', description: 'serve a folder statically' },
    ],
  },
];

function commandByName(name) {
  const lower = String(name || '').toLowerCase();
  return SLASH_COMMANDS.find((command) => command.name === lower) || null;
}

/**
 * True when the first token would actually parse as a registered command.
 * Exact name only: the guard runs at send time, where a prefix the user never
 * completed is precisely the typo being guarded against.
 */
export function matchesKnownCommand(text) {
  const trimmed = String(text || '');
  if (!trimmed.startsWith('/')) return false;
  const first = trimmed.slice(1).split(/\s+/, 1)[0] || '';
  return commandByName(first) !== null;
}

export const UNKNOWN_COMMAND_REPEAT_WINDOW_MS = 8000;

/**
 * Warn-once decision for the unknown-command send guard. Pure: the composer
 * holds the slot and passes it back on the next attempt. Returns
 * `{ warn, notice?, slot }` — warn=true blocks the send and stores `slot`;
 * warn=false lets it through (and clears the slot).
 *
 * Only single-line, attachment-free text that starts with "/" and parses as no
 * known command is guarded: multi-line text is clearly prose, and an
 * attachment send was never a command.
 */
export function evaluateUnknownCommandGuard(text, { slot = null, now = Date.now(), hasAttachments = false } = {}) {
  const value = String(text || '');
  if (hasAttachments || !value.startsWith('/') || value.includes('\n') || matchesKnownCommand(value)) {
    return { warn: false, slot: null };
  }
  if (slot?.text === value && now - slot.at <= UNKNOWN_COMMAND_REPEAT_WINDOW_MS) {
    return { warn: false, slot: null };
  }
  return {
    warn: true,
    notice: `Unknown command ${value.split(/\s+/, 1)[0]} — press send again to send as text.`,
    slot: { text: value, at: now },
  };
}

function commandItems(prefix) {
  const lower = prefix.toLowerCase();
  return SLASH_COMMANDS
    .filter((command) => command.name.startsWith(lower))
    .map((command) => ({
      kind: 'command',
      insert: `/${command.name}`,
      display: `/${command.name}`,
      description: command.description,
    }));
}

function subcommandItems(command, prefix, previews, conversationId) {
  const lower = prefix.toLowerCase();
  const items = command.subcommands
    .filter((sub) => sub.name.startsWith(lower))
    .map((sub) => ({
      kind: 'subcommand',
      insert: sub.name,
      display: sub.name,
      description: sub.description,
    }));
  // Hint rows only while nothing has been typed yet: once the user starts a
  // token they have chosen a shape, and a non-insertable row would sit in the
  // way of Tab-accepting a real match.
  if (!prefix) {
    for (const hint of command.argHints) {
      items.push({
        kind: 'hint',
        insert: null,
        display: hint.hint,
        description: hint.description,
      });
    }
  }
  return items;
}

function previewTokenItems(prefix, previews, conversationId) {
  const lower = prefix.toLowerCase();
  const entries = (Array.isArray(previews) ? previews : [])
    .filter((entry) => entry && typeof entry.token === 'string')
    .filter((entry) => entry.token.startsWith(lower));
  const convId = String(conversationId || '').trim();
  // This conversation's previews first — closing what you just made is the
  // common case; foreign ones follow with their owning session shown.
  const mine = entries.filter((entry) => convId && entry.conversationId === convId);
  const others = entries.filter((entry) => !(convId && entry.conversationId === convId));
  return [...mine, ...others].map((entry) => ({
    kind: 'preview-token',
    insert: entry.token,
    display: entry.token.slice(0, 8),
    description: mine.includes(entry) || !entry.conversationId
      ? String(entry.label || '')
      : `${entry.label || ''} · session ${String(entry.conversationId).slice(0, 8)}`,
  }));
}

/**
 * Completions for the caret position, or null when the menu must close.
 *
 * Only the message head is completed: the command grammar lives entirely
 * before the free-text label, so completion stops once the caret moves past
 * the token the grammar can still predict. `replaceRange` is [start, end) in
 * the input string; accepting a completion replaces that range with
 * `item.insert` plus a trailing space.
 */
export function completionsFor(text, caret, { previews = [], conversationId = '' } = {}) {
  const value = String(text || '');
  const position = Number.isFinite(caret) ? caret : value.length;
  // Position-0 gating: a slash anywhere else is a path, never a command.
  if (!value.startsWith('/')) return null;
  // Completion only makes sense while the caret is in the head of the message.
  if (value.slice(0, position).includes('\n')) return null;

  const head = value.slice(0, position);
  const afterSlash = head.slice(1);
  const tokens = afterSlash.split(/\s+/);

  // Still typing the command name (no space yet).
  if (tokens.length === 1) {
    const items = commandItems(tokens[0]);
    if (!items.length) return null;
    return { items, replaceRange: [0, position] };
  }

  const command = commandByName(tokens[0]);
  if (!command) return null;

  const tokenStart = head.length - tokens[tokens.length - 1].length;

  // Typing the second token: subcommands + shape hints.
  if (tokens.length === 2) {
    const items = subcommandItems(command, tokens[1], previews, conversationId);
    if (!items.length) return null;
    return { items, replaceRange: [tokenStart, position] };
  }

  // Third token of "/preview close ": live preview tokens.
  if (tokens.length === 3) {
    const sub = command.subcommands.find((entry) => entry.name === tokens[1].toLowerCase());
    if (sub?.dynamicArgs === 'previews') {
      const items = previewTokenItems(tokens[2], previews, conversationId);
      if (!items.length) return null;
      return { items, replaceRange: [tokenStart, position] };
    }
  }

  return null;
}
