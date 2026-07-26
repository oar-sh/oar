const EXTERNAL_SCHEME = /^[a-z][a-z\d+.-]*:/i;

function decodeFragment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function resolveRelativePath(currentPath, hrefPath) {
  const baseParts = String(currentPath || '').replace(/\\/g, '/').split('/').filter(Boolean);
  baseParts.pop();
  const targetParts = String(hrefPath || '').replace(/\\/g, '/').split('/');
  for (const part of targetParts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!baseParts.length) return '';
      baseParts.pop();
      continue;
    }
    baseParts.push(part);
  }
  return baseParts.join('/');
}

export function resolveFilePreviewLink(rawHref, currentPath) {
  const href = String(rawHref || '').trim();
  if (!href) return { kind: 'none' };
  if (href.startsWith('#')) return { kind: 'fragment', fragment: decodeFragment(href.slice(1)) };
  if (href.startsWith('//') || EXTERNAL_SCHEME.test(href)) return { kind: 'external', href };

  const hashIndex = href.indexOf('#');
  const pathPart = hashIndex >= 0 ? href.slice(0, hashIndex) : href;
  const fragment = hashIndex >= 0 ? decodeFragment(href.slice(hashIndex + 1)) : '';
  if (pathPart.startsWith('/')) return { kind: 'none' };

  const path = resolveRelativePath(currentPath, pathPart);
  return path ? { kind: 'file', path, fragment } : { kind: 'none' };
}

export function markdownHeadingId(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
