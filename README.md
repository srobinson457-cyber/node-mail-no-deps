# node-mail-no-deps

SMTP and IMAP clients written directly against `node:tls`. No npm dependencies, at any depth.

Extracted in September 2026 from private code I run in production, built agent-first with
Claude Code; the history stays private because it contains private data. How I build and check
code: [REVIEWING.md](https://github.com/srobinson457-cyber/srobinson457-cyber/blob/main/REVIEWING.md).

```bash
node src/smtp-send.mjs --to a@b.com --subject "Hi" --body msg.txt   # dry run by default
node src/imap-check.mjs
```

The mail clients are the smaller half of this. The larger half is
[`src/tls-connect.mjs`](src/tls-connect.mjs), a bounded retrying TLS connect, and the
**measured** notes below on how Node actually behaves when a connect goes wrong. Most of
those apply to anything that opens a socket, not just mail.

---

## Why write SMTP yourself

Because SMTP is a line protocol. `AUTH`, `MAIL FROM`, `RCPT TO`, `DATA`, and a dot on its own
line. Implementing it is about 120 lines, and in exchange **nothing in your dependency tree, at
any depth, ever holds the password to a real mailbox.**

That is the entire argument. A mail library is a reasonable thing to install for most projects.
For a credential that can send as you, to anyone, the calculation is different, and 120 lines of
protocol you can read in one sitting is a fair price.

The same reasoning produced the IMAP side, which is deliberately **read-only**: it issues
`EXAMINE` rather than `SELECT`, so the *server* refuses any write and `\Seen` flags are never set
as a side effect of looking. That is a stronger guarantee than "this code does not call STORE",
because it does not depend on this code being correct.

---

## The Node networking findings

These are measurements, not documentation summaries. Each one is a bug that shipped or nearly
shipped.

### `AbortSignal.timeout()` does not bound a connect. It kills the connection later.

The signal stays attached to the socket **for its entire life**. Using
`AbortSignal.timeout(10_000)` to bound a connect does not stop at the connect: it destroys the
live, working session ten seconds in.

This shipped for a few hours and killed an IMAP session at exactly 10 seconds with
`AbortError: ABORT_ERR`. Typical sessions took about 9 seconds, so it was one slow day away
from failing in production while looking like a remote-server fault.

Use an `AbortController` you cancel yourself on `secureConnect`.

### `options.timeout` and `socket.setTimeout()` do not bound a connect either.

They are **inactivity** timers. They emit an event and leave the socket live. Only an
`AbortSignal` actually aborts the attempt (verified: `ABORT_ERR` at 3004ms).

### Happy Eyeballs does not bound the last address.

Node arms the per-attempt timer only for **non-final** addresses. A host with two A records
costs 250ms on the first plus the full OS SYN-retransmit budget on the second, measured at
**~21.3 seconds** on Windows (initial RTO 1000ms, four retransmissions).

### Do not "fix" that with `family: 4` or `autoSelectFamily: false`.

Both are measured regressions, as is raising `autoSelectFamilyAttemptTimeout`. Blackhole to
real failover succeeds in **322ms** at the 250ms default and takes **3037ms** at 3000ms, and
collapsing to a single address turns a survivable first-address failure into a hard 21-second
one.

### Retry in time is the only redundancy you actually have.

Large providers hand back adjacent addresses in the same `/24`: same route, same front-end
rack. Happy Eyeballs' second attempt is a draw from the same failure domain. DNS TTLs are short,
so a **retry** re-resolves onto a different front end. That is the redundancy that exists.

### `AggregateError` stringifies to the empty string.

Its `.stack` omits `.errors`. An alert built from one reads `AggregateError [ETIMEDOUT]:` with
two node-internal frames and nothing actionable. `describe()` unwraps the inner codes and
addresses before reporting.

### Retry the network, not the certificate.

A certificate or protocol failure is a standing condition. Retrying it four times delays the
alert by a minute for something that will fail identically every time, and a certificate
expiry is exactly the thing that should surface fast.

---

## The bug worth stealing the guard for

The SMTP sender tracks one boolean, `accepted`, set the instant the server returns 250 for the
`DATA` payload.

Before it existed, the socket error handler was unconditional. Servers routinely drop the
connection after `QUIT`, so the tool printed `connection failed` and exited 1 **for mail that
had already been accepted.**

The natural human response to "SEND FAILED" is to send again. So the consequence of that bug
was not a confusing log line. It was a **duplicate message to a real person**, caused by a tool
reporting failure for something that had succeeded.

The same class of error arrived by a second route: an unbounded wait left the top-level `await`
unsettled when a server accepted the message and then vanished instead of answering `QUIT`.
Node printed `Detected unsettled top-level await` and exited 13. Sent message, reported failure,
same hazard.

Both are guarded now, and the guard is the same idea in two places: **after acceptance, no
transport error can be a send failure.** `test/protocol.mjs` checks it against a fake server
that resets the connection after `QUIT`. It has to be a reset: a clean close never raises a
socket error, so the test would pass with the guard removed.

---

## Safety design

- **Dry run is the default.** `smtp-send.mjs` prints the envelope and the first fifteen lines of
  the body and sends nothing. You must pass `--send`. The smoke tests assert this, using an
  unresolvable host so that a dry run which ever starts opening a socket fails the test rather
  than quietly passing.
- **The credential is never printed.** `AUTH PLAIN` logs as `> <redacted>`, `LOGIN` as
  `> LOGIN <credential withheld>`, and tests assert the password never appears in dry-run or
  live output.
- **A 250 is acceptance, not delivery.** The tool says so on every send. Verify in the sent
  folder if it matters; `imap-check.mjs` is the tool for that.
- **Nothing is hardcoded.** Host, port, user and password all come from the environment.

---

## Use it

```bash
export SMTP_HOST=smtp.gmail.com
export SMTP_USER=you@example.com
export SMTP_PASS='your app password'     # 16 chars, spaces removed
export SMTP_FROM_NAME='Your Name'

node src/smtp-send.mjs --to someone@example.com \
                      --subject "Subject line" \
                      --body message.txt \
                      --attach report.pdf \
                      --send
```

```bash
export IMAP_HOST=imap.gmail.com
export IMAP_USER=you@example.com
export IMAP_PASS='your app password'

node src/imap-check.mjs --to support@example.com
```

`tls-connect.mjs` stands alone and has nothing to do with mail:

```js
import { connectWithRetry, describe, isRetryable } from './src/tls-connect.mjs';

const sock = await connectWithRetry({ host: 'example.com', port: 443, label: 'api' });
```

```bash
npm test      # 15 smoke tests + 18 protocol tests on fake servers at 127.0.0.1; no credentials, no internet
```

---

## Scope, honestly

`AUTH PLAIN` over implicit TLS only. No STARTTLS, no OAuth2, no connection pooling, no queue, no
bounce handling, no HTML multipart beyond `multipart/mixed` with attachments. IMAP does `LOGIN`,
`EXAMINE`, `SEARCH` and `LIST`, and nothing that writes.

If you need a mail *service*, use a library. This is for the case where a script needs to send
or check a mailbox and you would rather that credential stayed out of your dependency tree.

---

## License

MIT. See [LICENSE](LICENSE).
