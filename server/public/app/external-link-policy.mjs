const EXTERNAL_LINK_PROTOCOLS = new Set(['http:', 'https:']);

export function isExternalNavigationHref(rawHref, baseHref) {
  const href = String(rawHref || '').trim();
  if (!href || href.startsWith('#')) return false;
  try {
    const url = new URL(href, baseHref);
    return EXTERNAL_LINK_PROTOCOLS.has(url.protocol);
  } catch {
    return false;
  }
}

function isInAppLink(anchor) {
  return anchor.matches('a.workspace-file-link[data-workspace-path]')
    || Boolean(anchor.closest('.file-preview-markdown'));
}

export function openExternalNavigation(url, onFallback = null) {
  const opened = window.open(url, '_blank');
  if (opened) opened.opener = null;
  if (!opened && typeof onFallback === 'function') onFallback(url);
  return !!opened;
}

function secureExternalLink(anchor, baseHref, onFallback) {
  if (
    !(anchor instanceof HTMLAnchorElement)
    || anchor.hasAttribute('download')
    || isInAppLink(anchor)
    || !isExternalNavigationHref(anchor.getAttribute('href'), baseHref)
  ) {
    return;
  }

  if (anchor.target !== '_blank') anchor.target = '_blank';
  const relTokens = new Set(String(anchor.rel || '').split(/\s+/).filter(Boolean));
  relTokens.add('noopener');
  relTokens.add('noreferrer');
  anchor.rel = Array.from(relTokens).join(' ');
}

export function installExternalLinkPolicy({ documentRef = document, onFallback = null } = {}) {
  if (!documentRef || documentRef.documentElement?.dataset.externalLinkPolicy === 'installed') return;
  documentRef.documentElement.dataset.externalLinkPolicy = 'installed';

  const secureLinksIn = (root) => {
    if (root instanceof HTMLAnchorElement) {
      secureExternalLink(root, documentRef.baseURI, onFallback);
      return;
    }
    if (!(root instanceof Element)) return;
    root.querySelectorAll('a[href]').forEach((anchor) => secureExternalLink(anchor, documentRef.baseURI, onFallback));
  };

  secureLinksIn(documentRef.documentElement);
  documentRef.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    const anchor = target?.closest?.('a[href]');
    if (!anchor || isInAppLink(anchor)) return;
    secureExternalLink(anchor, documentRef.baseURI, onFallback);
    if (!isExternalNavigationHref(anchor.getAttribute('href'), documentRef.baseURI)) return;
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    openExternalNavigation(anchor.href, onFallback);
  }, true);

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') secureLinksIn(record.target);
      for (const node of record.addedNodes) secureLinksIn(node);
    }
  });
  observer.observe(documentRef.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'download', 'href', 'target'],
  });
}
