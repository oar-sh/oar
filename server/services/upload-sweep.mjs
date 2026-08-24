// Reclaims upload blobs that no reference will ever point at.
//
// Uploads are eager, so a blob can exist before anything references it: pasting
// into a conversation that is then abandoned, or switching conversations while
// an upload is in flight. Conversation-scoped sweeps only ever visit blobs that
// already have a reference, so these would otherwise stay on disk forever.

export const UNREFERENCED_UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

/**
 * Selects unreferenced blobs old enough that no upload can still be in flight
 * for them. Rows without a usable timestamp are left alone rather than guessed
 * at, since deleting a blob that is still being attached is far worse than
 * keeping a stale one.
 */
export function collectUnreferencedUploads(rows = [], {
  now = Date.now(),
  maxAgeMs = UNREFERENCED_UPLOAD_MAX_AGE_MS,
} = {}) {
  const cutoff = now - Math.max(0, Number(maxAgeMs) || 0);
  const collected = [];
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const sha256 = String(row?.sha256 || '').trim().toLowerCase();
    if (!SHA256_PATTERN.test(sha256)) continue;
    const createdAt = Date.parse(String(row?.created_at || ''));
    if (!Number.isFinite(createdAt)) continue;
    if (createdAt >= cutoff) continue;
    collected.push(sha256);
  }
  return collected;
}

export const UNREFERENCED_UPLOADS_QUERY = `
  SELECT f.sha256, f.created_at
  FROM uploaded_files f
  LEFT JOIN upload_refs r ON r.file_sha256 = f.sha256
  WHERE r.id IS NULL
`;

/**
 * Runs one sweep. Never throws: a failed reclaim must not take the relay down.
 */
export function sweepUnreferencedUploads({
  listUnreferenced,
  deleteUploads,
  now = Date.now(),
  maxAgeMs = UNREFERENCED_UPLOAD_MAX_AGE_MS,
} = {}) {
  try {
    if (typeof listUnreferenced !== 'function' || typeof deleteUploads !== 'function') return 0;
    const stale = collectUnreferencedUploads(listUnreferenced() || [], { now, maxAgeMs });
    if (!stale.length) return 0;
    deleteUploads(stale);
    return stale.length;
  } catch {
    return 0;
  }
}
