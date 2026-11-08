// The media gallery's logic without the DOM: the query a view asks
// GET /api/media with, month sections, how a gallery item becomes an item of
// the file viewer, what the viewer says about it, and which buttons it gets.

export const MEDIA_TEXT = Object.freeze({
  title: 'Media',
  tabMedia: 'Media',
  tabFiles: 'Files',
  tabContext: 'Context',
  sourceAll: 'All',
  sourceMine: 'Mine',
  sourceAgent: 'Agent',
  sourceGenerated: 'Generated',
  allProviders: 'All providers',
  allSessions: 'All sessions',
  hideArchived: 'Hide archived',
  search: 'Search name, alt text, session',
  emptyMedia: 'No pictures or videos yet.',
  emptyFiles: 'No files yet.',
  emptyFiltered: 'Nothing matches these filters.',
  loading: 'Loading…',
  loadMore: 'Load more',
  failed: 'Could not load the media.',
  indexing: (count) => `Indexing older messages… (${count >= 10001 ? '10,000+' : count} left)`,
  missing: (count) => `${count} missing ${count === 1 ? 'file is' : 'files are'} not shown.`,
  sourceLabel: 'Source',
  providerLabel: 'Provider',
  sessionLabel: 'Session',
  untitled: 'picture',
  copied: 'Copied.',
  copyFailed: 'Could not copy.',
  openInSession: 'Open in session',
  copyPath: 'Copy path',
  copyLink: 'Copy link',
  fromYou: '👤 You',
  fromAgent: '🤖 Agent',
  generated: '✨ Generated',
  remote: '🌐',
  archived: 'archived',
  inMessages: (count) => `in ${count} messages`,
});

export const MEDIA_PAGE_SIZE = 60;

/** The query string of one page of a gallery view. */
export function mediaQuery({
  category = 'media',
  conversationId = '',
  source = 'all',
  provider = '',
  hideArchived = false,
  q = '',
  cursor = '',
  limit = MEDIA_PAGE_SIZE,
} = {}) {
  const params = new URLSearchParams();
  params.set('category', category === 'file' ? 'file' : 'media');
  if (conversationId) params.set('conversationId', conversationId);
  if (source && source !== 'all') params.set('source', source);
  if (provider) params.set('provider', provider);
  if (hideArchived) params.set('archived', 'hide');
  const text = String(q || '').trim();
  if (text) params.set('q', text);
  if (cursor) params.set('cursor', cursor);
  params.set('limit', String(limit));
  return params.toString();
}

/** Items grouped by the month of their message, newest first as they come: `[{ key, label, items }]`. */
export function groupByMonth(items, { locale, timeZone } = {}) {
  const sections = [];
  for (const item of Array.isArray(items) ? items : []) {
    const date = new Date(item?.timestamp);
    const valid = !Number.isNaN(date.getTime());
    const parts = valid
      ? new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', timeZone }).formatToParts(date)
      : [];
    const year = parts.find((part) => part.type === 'year')?.value || '';
    const month = parts.find((part) => part.type === 'month')?.value || '';
    const key = valid ? `${year}-${month}` : 'unknown';
    let section = sections[sections.length - 1];
    if (!section || section.key !== key) {
      const label = valid ? date.toLocaleDateString(locale, { year: 'numeric', month: 'long', timeZone }) : '';
      section = { key, label, items: [] };
      sections.push(section);
    }
    section.items.push(item);
  }
  return sections;
}

export function formatMediaSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/** The icon of a row of the Files tab. */
export function mediaFileIcon(item) {
  if (item?.mediaKind === 'pdf') return '📄';
  if (item?.mediaKind === 'audio') return '🎵';
  return '📎';
}

/** The badge of an item: who it came from. */
export function mediaSourceBadge(item) {
  if (item?.origin === 'generated') return MEDIA_TEXT.generated;
  return item?.sender === 'me' ? MEDIA_TEXT.fromYou : MEDIA_TEXT.fromAgent;
}

/** The address the viewer loads an item from (the relay's route, or the remote picture itself). */
export function mediaHref(item, base = '') {
  if (item?.contentUrl) return `${base}${item.contentUrl}`;
  // Only a web address is loaded from elsewhere (the server sends no other kind).
  const remote = String(item?.remoteUrl || '');
  return /^https?:\/\//i.test(remote) ? remote : '';
}

/** A file viewer gallery item for a media item. */
export function mediaViewerItem(item, base = '') {
  return {
    key: `media:${item.id}`,
    source: 'upload',
    href: mediaHref(item, base),
    name: String(item?.name || item?.alt || MEDIA_TEXT.untitled),
    mime: String(item?.mime || (item?.mediaKind === 'video' ? 'video/mp4' : item?.mediaKind === 'image' ? 'image/png' : '')),
    size: Number.isFinite(item?.sizeBytes) ? item.sizeBytes : 0,
    media: item,
  };
}

export function formatMediaDate(timestamp, locale = undefined) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(locale, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** The caption line: session title · date · who · how often · archived. */
export function mediaCaption(item, { locale } = {}) {
  if (!item) return '';
  const parts = [
    String(item.conversationTitle || '').trim(),
    formatMediaDate(item.timestamp, locale),
    mediaSourceBadge(item) + (item.remoteUrl ? ` ${MEDIA_TEXT.remote}` : ''),
  ];
  if (Number(item.occurrences) > 1) parts.push(MEDIA_TEXT.inMessages(Number(item.occurrences)));
  if (item.archived) parts.push(MEDIA_TEXT.archived);
  return parts.filter(Boolean).join(' · ');
}

/** What "Copy path / Copy link" copies, or '' when there is nothing useful (uploads, data images). */
export function mediaCopyTarget(item) {
  if (item?.path) return { label: MEDIA_TEXT.copyPath, text: String(item.path) };
  if (item?.remoteUrl) return { label: MEDIA_TEXT.copyLink, text: String(item.remoteUrl) };
  return null;
}

/**
 * The viewer gallery for a list of media items, open at `index`. `loadMore`
 * resolves the next page of media items (or null); `actions` carries what
 * the page does for "Open in session" and copying.
 */
export function mediaViewerGallery(items, index, {
  base = '',
  hasMore = false,
  loadMore = null,
  openInSession = null,
  copyText = null,
  locale,
} = {}) {
  const viewerItems = items.map((item) => mediaViewerItem(item, base));
  return {
    source: 'media',
    items: viewerItems,
    index,
    hasMore: Boolean(hasMore && loadMore),
    loadMore: loadMore
      ? async () => {
        const page = await loadMore();
        return {
          items: (page?.items || []).map((item) => mediaViewerItem(item, base)),
          hasMore: Boolean(page?.hasMore),
        };
      }
      : null,
    describe(viewerItem) {
      const item = viewerItem?.media;
      if (!item) return null;
      const actions = [];
      if (typeof openInSession === 'function' && item.conversationId && item.messageId) {
        actions.push({ id: 'open-in-session', label: MEDIA_TEXT.openInSession, run: () => openInSession(item) });
      }
      const copy = mediaCopyTarget(item);
      if (copy && typeof copyText === 'function') {
        actions.push({ id: 'copy-location', label: copy.label, run: () => copyText(copy.text) });
      }
      return { caption: mediaCaption(item, { locale }), actions };
    },
  };
}
