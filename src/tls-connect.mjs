/**
 * Bounded, retrying TLS connect. Each choice here rests on a measurement written
 * up in the README under "The Node networking findings".
 */
import { connect } from 'node:tls';

// Unwraps an AggregateError's inner codes and addresses, which its message and
// stack leave out. See README: "AggregateError stringifies to the empty string".
export function describe(e) {
  if (!e) return '(no error)';
  const inner = e.errors?.length
    ? ` [${[...new Set(e.errors.map((x) => `${x.code}@${x.address}`))].join(', ')}]`
    : '';
  return `${e.constructor?.name ?? 'Error'}: ${e.code ?? ''}${e.message ? ' ' + e.message : ''}${inner}`.trim();
}

// Only network faults are retried: a certificate or protocol error fails the same
// way every time. See README: "Retry the network, not the certificate".
export const RETRYABLE = new Set([
  'ETIMEDOUT', 'ABORT_ERR', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED',
  'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND',
]);

export const isRetryable = (e) =>
  RETRYABLE.has(e?.code) || (e?.errors?.length > 0 && e.errors.every((x) => RETRYABLE.has(x.code)));

/**
 * One attempt, bounded by an AbortController that is aborted only if the connect
 * has not finished by timeoutMs; it then rejects with ETIMEDOUT. Not
 * AbortSignal.timeout(): the signal stays attached for the socket's whole life,
 * so it would kill a live session. See README: "AbortSignal.timeout() does not
 * bound a connect" and "options.timeout and socket.setTimeout() do not bound a
 * connect either".
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
 * Retries in time, since a retry re-resolves DNS (README: "Retry in time is the
 * only redundancy you actually have"). Worst case with the defaults: 4 x 10s of
 * attempts plus 5s + 15s + 45s of backoff = 105s. Under a scheduler with an
 * execution time limit, check that still fits before tuning these up.
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
        log(`${what} connect failed unretryably (${describe(e)}): not a transient network fault`);
        break;
      }
      if (i === attempts - 1) break;
      const wait = backoff[Math.min(i, backoff.length - 1)];
      log(`${what} connect attempt ${i + 1}/${attempts} failed (${describe(e)}), retrying in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  const err = new Error(
    `could not connect to ${host}:${port} after ${attempts} attempts, last error: ${describe(last)}`,
  );
  err.code = last?.code ?? 'ECONNFAIL';
  err.cause = last;
  throw err;
}
