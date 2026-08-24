// Pure planning helpers for incremental streaming renders: streamed markdown
// and activity logs grow at the tail, so a render only needs to touch nodes
// from the first divergence onward instead of rebuilding the whole container.

export function computeStablePrefixLength(previous = [], next = []) {
  const limit = Math.min(previous.length, next.length);
  let index = 0;
  while (index < limit && previous[index] === next[index]) index += 1;
  return index;
}

/**
 * Plan how to bring a rendered list of rows up to date. Returns `reset: true`
 * (rebuild everything) when existing rows diverge from the expected list;
 * otherwise only the missing tail is appended.
 */
export function planListPatch(currentTexts = [], expectedTexts = []) {
  const stable = computeStablePrefixLength(currentTexts, expectedTexts);
  if (stable < currentTexts.length) {
    return { reset: true, appends: [...expectedTexts] };
  }
  return { reset: false, appends: expectedTexts.slice(currentTexts.length) };
}
