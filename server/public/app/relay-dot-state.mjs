/**
 * Resolves the relay status dot's colour and tooltip.
 *
 * The dot's primary meaning is unchanged: grey when the web relay is
 * unreachable, coloured when it answers. Cloudflare Tunnel mode adds a third
 * colour so it is obvious at a glance that the relay is reachable from the
 * internet rather than only from this machine.
 *
 * A managed-but-disconnected tunnel stays green rather than going grey: the
 * relay itself is still reachable, and grey would claim otherwise. The tooltip
 * carries the bad news instead. Note this state is only ever visible locally —
 * a remote browser whose tunnel is down cannot load the page at all.
 *
 * `tone` is the same state as `className`, minus the dot's CSS baggage. The
 * mobile burger toggle dyes its bars from it, because the dot itself sits in
 * the off-canvas sidebar and is invisible whenever the conversation list is
 * closed. Both indicators read the one tone so they cannot disagree.
 */

function normalizeTunnel(tunnel) {
  if (!tunnel || typeof tunnel !== 'object') return null;
  const mode = String(tunnel.mode || '').trim().toLowerCase();
  const managed = mode === 'managed' || tunnel.enabled === true;
  if (!managed) return null;
  return {
    connected: tunnel.connected === true,
    lastError: String(tunnel.lastError || '').trim(),
  };
}

function describeWorkers({ processingCount = 0, errorCount = 0, questionCount = 0 } = {}) {
  const plural = (count) => (count === 1 ? '' : 's');
  if (processingCount > 0) return `${processingCount} session worker${plural(processingCount)} processing`;
  if (errorCount > 0) return `${errorCount} session worker${plural(errorCount)} degraded`;
  if (questionCount > 0) return `${questionCount} session worker${plural(questionCount)} waiting on a question`;
  return '';
}

export function resolveRelayDotState({
  relayOnline = false,
  cliOnline = false,
  cloudflaredTunnel = null,
  processingCount = 0,
  errorCount = 0,
  questionCount = 0,
} = {}) {
  if (!relayOnline) {
    return { className: 'offline', tone: 'offline', title: 'Web relay unreachable' };
  }

  const tunnel = normalizeTunnel(cloudflaredTunnel);
  const tunnelled = !!tunnel && tunnel.connected;
  const tone = tunnelled ? 'tunnelled' : 'online';
  const className = tunnelled ? 'online tunnelled' : 'online';

  let reach = 'Web relay reachable';
  if (tunnelled) {
    reach = 'Web relay reachable via Cloudflare Tunnel';
  } else if (tunnel) {
    reach = tunnel.lastError
      ? `Web relay reachable; Cloudflare tunnel disconnected (${tunnel.lastError})`
      : 'Web relay reachable; Cloudflare tunnel disconnected';
  }

  if (!cliOnline) return { className, tone, title: `${reach}; CLI offline` };

  const workers = describeWorkers({ processingCount, errorCount, questionCount });
  return { className, tone, title: workers ? `${reach}; ${workers}` : reach };
}
