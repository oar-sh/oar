// The About OAR modal, as HTML from a GET /api/about payload. No DOM here;
// about-ui.js opens the modal and wires it.

export const OAR_REPO_URL = 'https://github.com/oar-sh/oar';
export const OAR_SITE_URL = 'https://oar.sh';
export const OAR_RELEASES_URL = 'https://github.com/oar-sh/oar/releases';

const STATE_LABELS = Object.freeze({
  online: 'online',
  offline: 'offline',
  idle: 'idle',
});

const USAGE_LABELS = Object.freeze({
  github: 'GitHub Copilot',
  cursor: 'Cursor',
  grok: 'Grok',
  'claude-cloud': 'Claude Cloud',
});

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function aboutMenuLabel(version) {
  const text = String(version || '').trim();
  return text && text !== '0.0.0' ? `ℹ️ About OAR · ${text}` : 'ℹ️ About OAR';
}

export function formatCount(value) {
  const number = finite(value);
  return number === null ? '–' : Math.round(number).toLocaleString('en-US');
}

/** Tokens and other large amounts: 1 234, 12.3 k, 4.56 M. */
export function formatAmount(value) {
  const number = finite(value);
  if (number === null) return '–';
  if (Math.abs(number) >= 1e9) return `${(number / 1e9).toFixed(2)} B`;
  if (Math.abs(number) >= 1e6) return `${(number / 1e6).toFixed(2)} M`;
  if (Math.abs(number) >= 1e4) return `${(number / 1e3).toFixed(1)} k`;
  return Number.isInteger(number) ? number.toLocaleString('en-US') : number.toFixed(2);
}

export function formatUsd(value) {
  const number = finite(value);
  return number === null ? '–' : `USD ${number.toFixed(2)}`;
}

export function formatBytes(value) {
  const number = finite(value);
  if (number === null || number < 0) return '–';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = number;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${Math.round(size)} B` : `${size.toFixed(size >= 100 ? 0 : 1)} ${units[unit]}`;
}

export function formatUptime(seconds) {
  const total = finite(seconds);
  if (total === null || total < 0) return '–';
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  if (days > 0) return `${days} d ${hours} h`;
  if (hours > 0) return `${hours} h ${minutes} min`;
  if (minutes > 0) return `${minutes} min`;
  return `${Math.floor(total)} s`;
}

function defaultFormatDateTime(iso) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '–';
  return new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function defaultFormatDate(iso) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '–';
  return new Date(at).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

function row(label, value, { hint = '', title = '' } = {}) {
  return `<tr><td><div class="plan-usage-detail-label"><span>${esc(label)}</span>${hint ? `<span class="plan-usage-detail-hint">${esc(hint)}</span>` : ''}</div></td>`
    + `<td class="plan-usage-detail-value"${title ? ` title="${esc(title)}"` : ''}>${value}</td></tr>`;
}

function section(id, title, inner, { subtitle = '' } = {}) {
  return `<section class="plan-usage-card about-section" data-about-section="${esc(id)}">`
    + `<div class="plan-usage-card-head"><div class="plan-usage-card-titles"><span class="plan-usage-card-title">${esc(title)}</span>`
    + `${subtitle ? `<span class="plan-usage-account">${esc(subtitle)}</span>` : ''}</div></div>${inner}</section>`;
}

function table(rows) {
  return rows.length ? `<table class="plan-usage-detail-table"><tbody>${rows.join('')}</tbody></table>` : '';
}

function note(text) {
  return `<div class="plan-usage-detail-note">${text}</div>`;
}

function externalLink(href, text) {
  return `<a class="plan-usage-link" href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>`;
}

function providerDetails(provider) {
  const parts = [];
  if (provider.engine === 'extension') parts.push('extension engine');
  if (provider.engine === 'sdk') parts.push('SDK engine');
  if (provider.cliVersion) parts.push(`CLI ${provider.cliVersion}`);
  if (provider.sdkVersion) parts.push(`SDK ${provider.sdkVersion}`);
  return parts.join(' · ');
}

function providerState(provider) {
  const state = STATE_LABELS[provider.state] ? provider.state : 'idle';
  const workers = finite(provider.runningWorkers) || 0;
  const count = workers > 0 ? ` · ${workers} ${workers === 1 ? 'worker' : 'workers'}` : '';
  return `<span class="about-state" data-state="${esc(state)}">${esc(STATE_LABELS[state])}</span>${esc(count)}`;
}

function usageRows(id, usage) {
  if (id === 'github') {
    return [row('Premium requests', esc(formatAmount(usage.premiumRequests)), { hint: `over ${formatCount(usage.turns)} replies` })];
  }
  if (id === 'cursor') {
    return [
      row('Tokens', esc(formatAmount(usage.totalTokens)), {
        hint: `${formatAmount(usage.inputTokens)} in · ${formatAmount(usage.outputTokens)} out · ${formatAmount((finite(usage.cacheReadTokens) || 0) + (finite(usage.cacheWriteTokens) || 0))} cache`,
      }),
      row('Cost', esc(formatUsd(usage.rawCostUsd)), { hint: `model price over ${formatCount(usage.runs)} runs; charged ${formatUsd(usage.chargedUsd)}` }),
    ];
  }
  if (id === 'grok') {
    return [
      row('Tokens', esc(formatAmount(usage.totalTokens)), { hint: `${formatAmount(usage.inputTokens)} in · ${formatAmount(usage.outputTokens)} out` }),
      row('Cost', esc(formatUsd(usage.costUsd)), { hint: `over ${formatCount(usage.turns)} turns` }),
    ];
  }
  if (id === 'claude-cloud') {
    return [row('Cost', esc(formatUsd(usage.costUsd)), { hint: `over ${formatCount(usage.sessions)} cloud sessions` })];
  }
  return [];
}

function buildUpdateSection(update, formatDateTime) {
  if (update.checkEnabled) {
    if (update.available && update.latestVersion) {
      return section('update', 'Updates', note(`Latest: ${esc(update.latestVersion)} · ${externalLink(update.notesUrl || OAR_RELEASES_URL, 'release notes')}`));
    }
    const checked = update.lastCheckedAt ? `, checked ${esc(formatDateTime(update.lastCheckedAt))}` : '';
    return section('update', 'Updates', note(update.lastCheckedAt ? `Up to date${checked}.` : 'Not checked yet.'));
  }
  if (update.checkKilled) {
    return section('update', 'Updates', note('Update checks are turned off on this relay (OAR_NO_UPDATE_CHECK).'));
  }
  return section('update', 'Updates', note(
    'Update checks are off. Turn on <button type="button" class="plan-usage-link about-inline-button" data-about-open-settings>Settings › General › Check for updates automatically</button> to see the latest version here.',
  ));
}

/**
 * @param {object} about the GET /api/about payload
 * @param {object} [options]
 * @param {(iso: string) => string} [options.formatDateTime]
 * @param {(iso: string) => string} [options.formatDate]
 */
export function buildAboutModalHtml(about = {}, {
  formatDateTime = defaultFormatDateTime,
  formatDate = defaultFormatDate,
} = {}) {
  const sections = [];

  const commit = String(about.commit || '').trim();
  const install = about.installMethod === 'git-checkout' ? 'git checkout' : (about.installMethod === 'npm-global' ? 'npm package' : '');
  sections.push(section('build', 'OAR', table([
    row('Version', esc(about.version || '–'), install ? { hint: install } : {}),
    ...(commit ? [row('Commit', `<code>${esc(commit.slice(0, 7))}</code>`, { title: commit })] : []),
    row('Started', esc(about.startedAt ? formatDateTime(about.startedAt) : '–')),
    row('Uptime', esc(formatUptime(about.uptimeSeconds))),
  ])));

  const providers = Array.isArray(about.providers) ? about.providers : [];
  sections.push(section('providers', 'Providers', providers.length
    ? table(providers.map((provider) => row(provider.label || provider.id, providerState(provider), { hint: providerDetails(provider) })))
      + (providers.some((provider) => provider.state === 'idle')
        ? note('Idle: on, with no worker running right now; one starts with the next turn.')
        : '')
    : note('No provider is turned on.')));

  const stats = about.stats || {};
  const turnsByProvider = Array.isArray(stats.turnsByProvider) ? stats.turnsByProvider : [];
  const archived = finite(stats.archivedConversations) || 0;
  sections.push(section('activity', 'Activity', table([
    row('Conversations', esc(formatCount(stats.conversations)), archived ? { hint: `${formatCount(archived)} archived` } : {}),
    row('Turns', esc(formatCount(stats.turns)), { hint: 'replies written by an agent' }),
    row('Messages', esc(formatCount(stats.messages))),
    ...turnsByProvider.map((entry) => row(`Turns on ${entry.label || entry.id}`, esc(formatCount(entry.turns)))),
  ]), { subtitle: stats.firstConversationAt ? `since ${formatDate(stats.firstConversationAt)}` : '' }));

  const usage = about.usage && typeof about.usage === 'object' ? about.usage : {};
  const usageIds = Object.keys(USAGE_LABELS).filter((id) => usage[id]);
  sections.push(section('usage', 'Usage', (usageIds.length
    ? usageIds.map((id) => `<div class="about-usage-provider">${esc(USAGE_LABELS[id])}</div>${table(usageRows(id, usage[id]))}`).join('')
    : note('No provider has reported usage yet.'))
    + note('What the providers report and this relay keeps: Copilot premium requests per reply, Cursor and Grok tokens and cost per billing cycle, Claude Cloud cost per session. Claude Code and OpenAI turns keep no usage here.')));

  const relay = about.relay || {};
  sections.push(section('relay', 'Relay', table([
    row('Uptime', esc(formatUptime(relay.uptimeSeconds))),
    row('Database', esc(formatBytes(relay.dbBytes)), { hint: `${formatBytes(relay.dbFileBytes)} + ${formatBytes(relay.walBytes)} WAL` }),
    row('Running workers', esc(formatCount(relay.runningWorkers))),
  ])));

  sections.push(buildUpdateSection(about.update || {}, formatDateTime));

  sections.push(`<div class="about-links" data-about-section="links">${externalLink(OAR_REPO_URL, 'github.com/oar-sh/oar')}${externalLink(OAR_SITE_URL, 'oar.sh')}</div>`);

  return `<div class="about-modal">${sections.join('')}</div>`;
}
