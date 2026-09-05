// Minimal version comparison for OAR's update check: releases are X.Y.Z or
// X.Y.Z-beta.N, nothing else. Not a general semver implementation on purpose —
// anything unparseable compares as "no update" instead of guessing.

export function parseSemverIsh(value) {
  const text = String(value ?? '').trim();
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(text);
  if (!match) return null;
  const prerelease = match[4]
    ? match[4].split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part))
    : null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

/** -1 | 0 | 1; a prerelease sorts below the release with the same triple. */
export function compareSemverIsh(a, b) {
  const left = typeof a === 'object' && a !== null ? a : parseSemverIsh(a);
  const right = typeof b === 'object' && b !== null ? b : parseSemverIsh(b);
  if (!left || !right) return 0;
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (!left.prerelease && !right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < length; i += 1) {
    const l = left.prerelease[i];
    const r = right.prerelease[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    if (typeof l === 'number' && typeof r === 'number') return l < r ? -1 : 1;
    if (typeof l === 'number') return -1; // numeric identifiers sort first
    if (typeof r === 'number') return 1;
    return l < r ? -1 : 1;
  }
  return 0;
}

export function channelForVersion(version) {
  const parsed = parseSemverIsh(version);
  const first = parsed?.prerelease?.[0];
  return typeof first === 'string' && first.toLowerCase().startsWith('beta') ? 'beta' : 'stable';
}
