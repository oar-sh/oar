// Text for Settings → Sharing: a share row's detail line and an access log
// entry. DOM-free so it is unit-testable.

// The same steps as a preview's age (preview-cards.mjs), which this module
// cannot import without the API client.
function age(iso, now) {
  const at = Date.parse(String(iso || ''));
  if (!Number.isFinite(at) || at <= 0) return '';
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

/** "shared 3 d ago · new link 2 h ago · last opened 5 min ago · 4 opens · 2 viewers" */
export function describeShare(share, now = Date.now()) {
  const parts = [];
  const since = age(share?.sharedSince, now);
  if (since) parts.push(`shared ${since}`);
  const renewed = age(share?.renewedAt, now);
  if (renewed) parts.push(`new link ${renewed}`);
  const opened = age(share?.lastOpenedAt, now);
  parts.push(opened ? `last opened ${opened}` : 'never opened');
  const opens = Math.max(0, Math.trunc(Number(share?.openCount) || 0));
  const viewers = Math.max(0, Math.trunc(Number(share?.viewerCount) || 0));
  parts.push(plural(opens, 'open', 'opens'));
  parts.push(plural(viewers, 'viewer', 'viewers'));
  if (share?.archived) parts.push('archived');
  return parts.join(' · ');
}

/** "16 Oct 2026, 14:05 · DE · 203.0.113.7 · viewer 1a2b3c4d" */
export function describeShareOpen(open, { locale } = {}) {
  const parts = [];
  const at = Date.parse(String(open?.openedAt || ''));
  if (Number.isFinite(at)) {
    parts.push(new Date(at).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }));
  }
  if (open?.country) parts.push(String(open.country));
  parts.push(open?.ip ? String(open.ip) : 'IP not stored');
  if (open?.viewer) parts.push(`viewer ${open.viewer}`);
  return parts.join(' · ');
}
