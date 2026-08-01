// ---------------------------------------------------------------------------
// Fixed-window rate limiter
//
// Extracted verbatim from the shared-presence limiter in routes/sessions-routes.mjs
// so the same behaviour can guard other endpoints. Buckets expire on a TTL and
// the oldest are evicted once maxBuckets is exceeded, so a hostile caller cannot
// grow the map without bound.
// ---------------------------------------------------------------------------

export function createFixedWindowRateLimiter({
  windowMs = 10_000,
  limit = 24,
  bucketTtlMs = 60_000,
  maxBuckets = 4_096,
  nowMs = Date.now,
} = {}) {
  const buckets = new Map();

  function prune(reference = nowMs()) {
    for (const [bucketKey, bucket] of buckets.entries()) {
      const lastSeenAt = Number(bucket?.lastSeenAt || 0);
      if (!Number.isFinite(lastSeenAt) || (reference - lastSeenAt) > bucketTtlMs) {
        buckets.delete(bucketKey);
      }
    }
    if (buckets.size <= maxBuckets) return;
    const entries = Array.from(buckets.entries());
    entries.sort((a, b) => Number(a[1]?.lastSeenAt || 0) - Number(b[1]?.lastSeenAt || 0));
    const overflow = buckets.size - maxBuckets;
    for (let index = 0; index < overflow; index += 1) {
      const key = entries[index]?.[0];
      if (!key) continue;
      buckets.delete(key);
    }
  }

  function consume(key, reference = nowMs()) {
    const bucketKey = String(key || '').trim();
    if (!bucketKey) return { ok: false, retryAfterSeconds: 1 };
    const existing = buckets.get(bucketKey) || {
      windowStartAt: reference,
      count: 0,
      lastSeenAt: reference,
    };
    if (!Number.isFinite(existing.windowStartAt) || (reference - existing.windowStartAt) >= windowMs) {
      existing.windowStartAt = reference;
      existing.count = 0;
    }
    existing.lastSeenAt = reference;
    if (existing.count >= limit) {
      buckets.set(bucketKey, existing);
      const retryAfterMs = Math.max(250, windowMs - (reference - existing.windowStartAt));
      prune(reference);
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
    }
    existing.count += 1;
    buckets.set(bucketKey, existing);
    prune(reference);
    return { ok: true, retryAfterSeconds: 0 };
  }

  return { consume, prune, size: () => buckets.size };
}
