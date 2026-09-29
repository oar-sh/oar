// What a failed request to the relay says about the relay.
//
// A worker talks to its relay over HTTP on the same host. Requests fail when
// the relay restarts, when a connection is reset, and when a proxy in front of
// it answers in its place; none of that says anything about the thing that
// was asked. A 4xx is the relay's own answer and does.

const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN']);

function errorCode(error) {
  return String(error?.cause?.code || error?.code || '').trim().toUpperCase();
}

/**
 * The request did not get through, or something between here and the relay
 * answered for it: worth asking again. A request the caller aborted itself
 * (`AbortError`) is not; one that ran into its time limit (`TimeoutError`) is.
 */
export function isTransientRelayError(error) {
  if (error?.name === 'AbortError') return false;
  const status = Number(error?.status);
  if (!Number.isFinite(status) || status <= 0) return true;
  return status >= 500 || status === 408 || status === 429;
}

/** The request provably never reached the relay, so sending it again cannot do it twice. */
export function isRelayUnreachableError(error) {
  const status = Number(error?.status);
  if (Number.isFinite(status) && status > 0) return false;
  return UNREACHABLE_CODES.has(errorCode(error));
}
