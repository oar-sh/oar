/**
 * What to tell the user when a restart request failed. An HTTP answer is a
 * refusal and says so (`refused`, shown as an alert); no answer at all can
 * mean the relay took the request and began restarting before it could
 * reply (`unanswered`, shown as a notice).
 */
export function describeRelayRestartError(error) {
  const message = String(error?.message || '').trim();
  if (Number(error?.status) > 0) {
    return { kind: 'refused', text: `The relay refused the restart: ${message || `HTTP ${Number(error.status)}`}` };
  }
  return {
    kind: 'unanswered',
    text: `${message || 'The relay did not answer.'} If it took the restart, the connection comes back once it has restarted.`,
  };
}
