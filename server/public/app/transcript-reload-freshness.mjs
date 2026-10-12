// A reload of the transcript rebuilds it from what its request returned. A
// row the socket put on the page while that request was on its way can be
// missing from the answer (the relay stored it after the request read the
// conversation), and the rebuild would take it off the page again until the
// next reload. The socket's rows are counted (getTranscriptLiveRowEpoch in
// conversation-view.js); when the count moved during the request, the
// request is made again, now that the row is stored.

/** Requests before a reload gives up on an answer that keeps going stale. */
export const LIVE_ROW_RELOAD_ATTEMPTS = 3;

/**
 * `stale` is true when rows still arrived during the last attempt: the page
 * holds rows the answer lacks, so the caller leaves the transcript alone and
 * the next reload asks again.
 */
export async function loadKeepingLiveRows(load, getLiveRowEpoch, { attempts = LIVE_ROW_RELOAD_ATTEMPTS } = {}) {
  let response = null;
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
    const epoch = getLiveRowEpoch();
    response = await load();
    if (!response || getLiveRowEpoch() === epoch) return { response, stale: false };
  }
  return { response, stale: true };
}
