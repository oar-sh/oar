// The commit-attribution row of the 🧠 context modal (Claude sessions only):
// what this repo folder's commits say, and a select to override the provider
// setting for the folder — the payload comes from /api/context (`attribution`).

const MODE_LABELS = Object.freeze({
  oar: 'OAR — Open Agent Relay (model)',
  vanilla: 'Vanilla — Claude Code\'s own',
  off: 'Off — none',
});

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function attributionEffectText({ effectiveMode, attributionExample } = {}) {
  if (effectiveMode === 'vanilla') return 'Commits keep Claude Code\'s own attribution.';
  if (effectiveMode === 'off') return 'Commits and pull requests carry no attribution line.';
  const trailer = String(attributionExample || '').trim();
  return trailer ? `Commits end with: ${trailer}` : 'Commits end with the Open Agent Relay trailer.';
}

/**
 * @param {object|null} attribution the `attribution` field of an /api/context response
 * @returns {string} the row's HTML, or '' when the payload has no folder to speak of
 */
export function renderAttributionControlHtml(attribution) {
  if (!attribution || typeof attribution !== 'object') return '';
  const path = String(attribution.path || '').trim();
  if (!path) return '';
  const folderMode = ['oar', 'vanilla', 'off'].includes(attribution.attributionMode) ? attribution.attributionMode : '';
  const providerMode = ['oar', 'vanilla', 'off'].includes(attribution.providerMode) ? attribution.providerMode : 'oar';
  const options = [
    `<option value=""${folderMode === '' ? ' selected' : ''}>Inherit (provider: ${esc(MODE_LABELS[providerMode].split(' — ')[0])})</option>`,
    ...['oar', 'vanilla', 'off'].map((mode) => `<option value="${mode}"${folderMode === mode ? ' selected' : ''}>${esc(MODE_LABELS[mode])}</option>`),
  ].join('');
  return `
    <div class="ctx-attribution" data-workspace-root="${esc(path)}">
      <div class="ctx-attribution-row">
        <span class="ctx-attribution-label">Commit attribution:</span>
        <select id="ctx-attribution-select" class="ctx-attribution-select" aria-label="Commit attribution for this folder" data-workspace-root="${esc(path)}">${options}</select>
      </div>
      <div class="ctx-attribution-note">For every Claude session in <code>${esc(path)}</code>. ${esc(attributionEffectText(attribution))} A change reaches running sessions with their next message.</div>
    </div>
  `;
}
