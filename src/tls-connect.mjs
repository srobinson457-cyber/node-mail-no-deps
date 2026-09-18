/**
 * Bounded, retrying TLS connect.
 *
 * Everything below is measured behaviour, not documentation reading. Each note is
 * a bug that shipped, or nearly shipped, and the measurement that settled it.
 *
 * ── WHY A CONNECT NEEDS BOUNDING AT ALL ─────────────────────────────────────
 *
 * A transient reachability gap to BOTH of a host's A records failed a whole
 * scheduled run, and the alert that came out of it was an AggregateError whose
 * message is the EMPTY STRING. Two separate problems: the connect was unbounded,
 * and the error was unreportable.
 *
 *  - Node's Happy Eyeballs per-attempt timer is armed ONLY for non-final
 *    addresses. So a host with two A records costs 250ms on the first plus the
 *    FULL OS SYN-retransmit budget on the second, measured at ~21.3s on Windows
 *    (initial RTO 1000ms, 4 retransmissions). It is not the 500ms hair-trigger
 *    people assume.
 *
 *  - `options.timeout` and `socket.setTimeout()` do NOT bound a connect. They are
 *    INACTIVITY timers: they emit an event and leave the socket live. Only an
 *    AbortSignal actually aborts the attempt (verified: ABORT_ERR at 3004ms).
 *
 *  - Do NOT "fix" a slow connect with `autoSelectFamily:false`, `family:4`, or a
 *    raised `autoSelectFamilyAttemptTimeout`. All three are measured REGRESSIONS.
 *    Blackhole-to-real failover succeeds in 322ms at the 250ms default but takes
 *    3037ms at 3000ms, and collapsing to one address turns a survivable
 *    first-address failure into a hard ~21s failure.
 *
 *  - Retry in TIME is the only real redundancy available here. Large providers
 *    return ADJACENT addresses in the same /24, same route and same front-end
 *    rack, so Happy Eyeballs' second attempt is a draw from the same failure
 *    domain. DNS TTLs are typically short, so a RETRY re-resolves onto a
 *    different front end. That is the redundancy that actually exists.
 *
 * ── AND THE ONE THAT ALMOST GOT AWAY ────────────────────────────────────────
 *
 * See `connectOnce`: using `AbortSignal.timeout(n)` to bound a connect silently
 * destroys the LIVE connection n milliseconds later, mid-session.
 */
import { connect } from 'node:tls';

/**
 * An AggregateError stringifies to the EMPTY STRING and its `.stack` omits
 * `.errors`, so an alert built from it reads as "AggregateError [ETIMEDOUT]:"
 * with two node-internal frames and nothing actionable. Always unwrap the inner
 * codes before reporting.
 */
export function describe(e) {
  if (!e) return '(no error)';
  const inner = e.errors?.length
    ? ` [${[...new Set(e.errors.map((x) => `${x.code}@${x.address}`))].join(', ')}]`
    : '';
  return `${e.constructor?.name ?? 'Error'}: ${e.code ?? ''}${e.message ? ' ' + e.message : ''}${inner}`.trim();
}

/**
 * Only the network is worth retrying. A certificate or protocol error is a
 * standing condition: retrying it four times just delays the alert by a minute
 * for something that will fail identically every time, and a certificate failure
 * is exactly the sort of thing that should surface FAST.
 *
 * ABORT_ERR is our own deadline firing. ETIMEDOUT is the OS giving up.
 */
export const RETRYABLE = new Set([
  'ETIMEDOUT', 'ABORT_ERR', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED',
  'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND',
]);

export const isRetryable = (e) =>
  RETRYABLE.has(e?.code) || (e?.errors?.length > 0 && e.errors.every((x) => RETRYABLE.has(x.code)));

/**
 * One connect attempt, bounded by an AbortSignal, which is the only thing that
 * bounds a connect.
 *
 * ⚠️ IT MUST BE AN AbortController WE CANCEL, NOT `AbortSignal.timeout(n)`.
 *
 * The signal stays attached to the socket for its ENTIRE LIFE. So a bare
 * `AbortSignal.timeout(n)` does not merely bound the connect: it destroys the
 * live, working connection n milliseconds later, mid-session.
 *
 * This shipped that way for a few hours and killed an IMAP session at exactly
 * 10 seconds with "AbortError: ABORT_ERR". Typical sessions ran about 9 seconds,
 * so it was one slow day away from failing in production while looking like a
 * remote-server problem. Clearing the timer on `secureConnect` means the
 * controller is never aborted and the socket lives as long as it needs to.
 */
export function connectOnce({ host, port, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const ac = new AbortController();
    const timer = setTimeout(() => {
      const e = new Error(`connect timed out after ${timeoutMs}ms`);
      e.code = 'ETIMEDOUT';
      ac.abort(e);
    }, timeoutMs);
    const sock = connect({ host, port, servername: host, signal: ac.signal });
    const settle = (fn) => (arg) => { clearTimeout(timer); fn(arg); };
    const onError = settle((e) => { sock.destroy(); reject(ac.signal.reason ?? e); });
    sock.once('error', onError);
    sock.once('secureConnect', settle(() => {
      sock.removeListener('error', onError);
      resolve(sock);
    }));
  });
}

/**
 * Worst case with the defaults: 4 x 10s of attempts plus 5s + 15s + 45s of
 * backoff = 105s. If you run this under a scheduler with an execution time
 * limit, check that these still fit inside it before tuning them up.
 */
export async function connectWithRetry({
  host, port, attempts = 4, timeoutMs = 10_000, backoff = [5_000, 15_000, 45_000],
  label = null, log = console.error,
}) {
  const what = label ?? `${host}:${port}`;
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const sock = await connectOnce({ host, port, timeoutMs });
      if (i > 0) log(`${what} connect recovered on attempt ${i + 1}/${attempts}`);
      return sock;
    } catch (e) {
      last = e;
      if (!isRetryable(e)) {
        log(`${what} connect failed unretryably (${describe(e)}) — not a transient network fault`);
        break;
      }
      if (i === attempts - 1) break;
      const wait = backoff[Math.min(i, backoff.length - 1)];
      log(`${what} connect attempt ${i + 1}/${attempts} failed (${describe(e)}) — retrying in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  const err = new Error(
    `could not connect to ${host}:${port} after ${attempts} attempts — last error: ${describe(last)}`,
  );
  err.code = last?.code ?? 'ECONNFAIL';
  err.cause = last;
  throw err;
}
