/**
 * Reply reader shared by smtp-send and imap-check, so a fix to one is a fix to
 * both.
 *
 * Each wait() brings its own "reply complete" rule, a RegExp whose first match
 * ends the reply. Every wait is bounded by a timer, and that timer is cleared
 * however the wait ends: reply, timeout, socket close or socket error. A timer
 * left armed holds the process open long after the work is done.
 */
export function replyReader(sock) {
  let buf = '';
  let waiter = null;
  let gone = null; // why the socket can no longer answer, once it can't

  const finish = (err, reply) => {
    const w = waiter;
    waiter = null;
    clearTimeout(w.timer);
    if (err) w.reject(err);
    else w.resolve(reply);
  };

  const pump = () => {
    if (!waiter) return;
    const m = buf.match(waiter.complete);
    if (m) {
      const end = m.index + m[0].length;
      const reply = buf.slice(0, end);
      buf = buf.slice(end);
      finish(null, reply);
    } else if (gone) {
      finish(new Error(`${gone} while waiting for ${waiter.label}`));
    }
  };

  sock.setEncoding('utf8');
  sock.on('data', (chunk) => { buf += chunk; pump(); });
  sock.on('error', (e) => { gone ??= `connection error (${e.code ?? e.message})`; pump(); });
  sock.on('close', () => { gone ??= 'connection closed'; pump(); });

  /** Resolves with the raw reply text, from the buffer start to the end of the first `complete` match. */
  const wait = (label, complete, timeoutMs) =>
    new Promise((resolve, reject) => {
      if (waiter) return reject(new Error(`already waiting for ${waiter.label}`));
      const timer = setTimeout(
        () => finish(new Error(`timed out after ${timeoutMs / 1000}s waiting for ${label}`)),
        timeoutMs,
      );
      waiter = { label, complete, resolve, reject, timer };
      pump();
    });

  return { wait };
}
