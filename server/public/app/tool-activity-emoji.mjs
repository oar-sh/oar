// Leading emoji for a tool-activity line ("Tool (PowerShell): …" → "🪓 Tool
// (PowerShell): …"), shared by the transcript's activity rows and the
// composer's background-tasks panel so a tool reads the same everywhere.
// Text that already starts with an emoji is returned unchanged.
export function prefixToolActivityEmoji(text) {
  const value = String(text || '').trim();
  if (!value) return '';
  if (/^[\u{1F300}-\u{1FAFF}☀-➿]/u.test(value)) return value;
  if (value.startsWith('● ')) return `🔄 ${value.slice(2).trim()}`;
  if (/^Model selected:/i.test(value)) return `🧠 ${value}`;
  if (/^Search \((glob|grep)\)/i.test(value)) return `🔍 ${value}`;
  if (/^Tool \(ask_user\)/i.test(value)) return `❓ ${value}`;
  if (/^Tool \(view\)/i.test(value)) return `👀 ${value}`;
  if (/^Tool \(apply_patch\)/i.test(value)) return `🪡 ${value}`;
  if (/^Tool \(powershell\)/i.test(value)) return `🪓 ${value}`;
  if (/^Tool \(edit\)/i.test(value)) return `📝 ${value}`;
  if (/^Tool \(read_file\)/i.test(value)) return `📄 ${value}`;
  if (/^Tool \((grep_search|file_search)\)/i.test(value)) return `🔎 ${value}`;
  if (/^Tool \(semantic_search\)/i.test(value)) return `🧭 ${value}`;
  if (/^Tool \(vscode_listCodeUsages\)/i.test(value)) return `🔗 ${value}`;
  if (/^Tool \(vscode_renameSymbol\)/i.test(value)) return `✏️ ${value}`;
  if (/^Tool \(list_dir\)/i.test(value)) return `📂 ${value}`;
  if (/^Tool \(create_directory\)/i.test(value)) return `📁 ${value}`;
  if (/^Tool \((delete|remove)\)/i.test(value)) return `🗑️ ${value}`;
  if (/^Tool \(execution_subagent\)/i.test(value)) return `🚀 ${value}`;
  if (/^Tool \(get_errors\)/i.test(value)) return `🚨 ${value}`;
  if (/^Tool \(debug_[^)]+\)/i.test(value)) return `🐞 ${value}`;
  if (/^Tool \(fetch_webpage\)/i.test(value)) return `🌐 ${value}`;
  if (/^Tool \(github_[^)]+\)/i.test(value)) return `🐙 ${value}`;
  if (/^Tool \(run_in_terminal\)/i.test(value)) return `🖥️ ${value}`;
  if (/^Tool \((create_file|write)\)/i.test(value)) return `🆕 ${value}`;
  if (/^Tool \((bash|shell|terminal)\)/i.test(value)) return `🔧 ${value}`;
  if (/^Tool \((sql|sqlite)\)/i.test(value)) return `🗄️ ${value}`;
  if (/^Tool \(/i.test(value)) return `🛠️ ${value}`;
  return `ℹ️ ${value}`;
}
