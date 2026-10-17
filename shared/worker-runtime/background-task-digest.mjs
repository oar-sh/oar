import { createHash } from "node:crypto";

/**
 * The digest of a background-task set, as a worker's heartbeat carries it and
 * the relay computes it for the set it holds: `{ count, digest }` over the
 * sorted task ids only. Descriptions, summaries and token counts change every
 * few seconds and are no reason to send the set again; membership is.
 */
export function backgroundTaskDigest(taskIds) {
  const ids = [...new Set((Array.isArray(taskIds) ? taskIds : [])
    .map((id) => String(id ?? "").trim())
    .filter(Boolean))].sort();
  return {
    count: ids.length,
    digest: createHash("sha256").update(ids.join("\n")).digest("hex").slice(0, 16),
  };
}

/** A digest off the wire, or null when the sender gave none (it has no opinion). */
export function normalizeBackgroundTaskDigest(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const digest = String(raw.digest ?? "").trim();
  const count = Number(raw.count);
  if (!/^[0-9a-f]{16}$/.test(digest) || !Number.isInteger(count) || count < 0) return null;
  return { count, digest };
}

export function sameBackgroundTaskDigest(a, b) {
  return !!a && !!b && a.count === b.count && a.digest === b.digest;
}
