#!/usr/bin/env node
/**
 * Read-only IMAP connectivity check, with zero dependencies.
 *
 * IMAP is a line protocol over TLS, so raw sockets are enough for LOGIN /
 * EXAMINE / SEARCH / LIST, and it keeps the credential out of any third-party
 * package.
 *
 * DELIBERATELY READ-ONLY. It uses EXAMINE, not SELECT, so the SERVER ITSELF
 * refuses any write and \Seen flags are never set as a side effect of looking.
 * That is a stronger guarantee than "this code does not call STORE", because it
 * does not depend on this code being correct. There is no SMTP in this file by
 * design: it cannot send, whatever you pass it.
 *
 * Configuration, all from the environment:
 *   IMAP_HOST   e.g. imap.gmail.com
 *   IMAP_PORT   default 993
 *   IMAP_USER   the mailbox
 *   IMAP_PASS   app password / token. Never printed, logged, or echoed.
 *
 *   node src/imap-check.mjs
 *   node src/imap-check.mjs --to support@example.com --to billing@example.com
 *
 *   --to  optional, repeatable. Counts messages addressed to each, which is
 *         useful for verifying that forwarding or routing actually works.
 */
import { connectWithRetry, describe } from './tls-connect.mjs';

const HOST = process.env.IMAP_HOST;
const PORT = Number(process.env.IMAP_PORT ?? 993);
const USER = process.env.IMAP_USER;

if (!HOST || !USER || !process.env.IMAP_PASS) {
  console.error('IMAP_HOST, IMAP_USER and IMAP_PASS must all be set in the environment.');
  process.exit(2);
}
const PASS = process.env.IMAP_PASS.replace(/\s+/g, '');

const argv = process.argv.slice(2);
const searchTo = argv.reduce((a, v, i) => (v === '--to' ? [...a, argv[i + 1]] : a), []).filter(Boolean);

/**
 * Retried. This is the tool you reach for AFTER something else failed, so
 * without a retry it shares the exact failure mode of the thing it is meant to
 * diagnose: one transient ETIMEDOUT and it prints "connection failed", which
 * reads as "IMAP is broken" when IMAP is fine.
 */
const sock = await connectWithRetry({ host: HOST, port: PORT, label: 'imap' });

/**
 * Set before LOGOUT. Servers commonly drop the TCP connection immediately as
 * they process LOGOUT, and an unguarded error handler turns that into a false
 * "connection failed" and exit 1 on a check that actually PASSED.
 */
let done = false;
let buf = '';
let seq = 0;
const pending = new Map();

sock.setEncoding('utf8');
sock.on('data', (chunk) => {
  buf += chunk;
  for (const [tag, { lines, resolve, reject }] of pending) {
    const re = new RegExp(`^${tag} (OK|NO|BAD)([^\r\n]*)`, 'm');
    const m = buf.match(re);
    if (!m) continue;
    lines.push(...buf.slice(0, m.index).split(/\r?\n/).filter(Boolean));
    buf = buf.slice(m.index + m[0].length);
    pending.delete(tag);
    m[1] === 'OK' ? resolve(lines) : reject(new Error(`${m[1]}${m[2]}`));
  }
});
sock.on('error', (e) => {
  if (done) return; // post-LOGOUT teardown, not a failure
  console.error('connection failed:', describe(e));
  sock.destroy();
  process.exitCode = 1;
});

const cmd = (text, secret = false) =>
  new Promise((resolve, reject) => {
    const tag = `a${++seq}`;
    pending.set(tag, { lines: [], resolve, reject });
    process.stdout.write(secret ? '  > LOGIN <credential withheld>\n' : `  > ${text}\n`);
    sock.write(`${tag} ${text}\r\n`);
    setTimeout(() => {
      if (pending.has(tag)) {
        pending.delete(tag);
        reject(new Error(`${text.split(' ')[0]} timed out`));
      }
    }, 20_000);
  });

// connectWithRetry already resolved ON 'secureConnect', so re-listening for it
// would hang forever. Only the greeting settle remains.
await new Promise((r) => setTimeout(r, 400));
buf = '';                                   // drop the server greeting
console.log(`connected  ${HOST}:${PORT}  TLS ${sock.getProtocol()}`);
console.log(`account    ${USER}`);

const searchCount = (lines) =>
  (lines.find((l) => l.startsWith('* SEARCH')) || '').split(/\s+/).slice(2).filter(Boolean).length;

try {
  await cmd(`LOGIN "${USER}" "${PASS}"`, true);
  console.log('login      OK');

  // EXAMINE is a read-only SELECT. It cannot modify the mailbox.
  const inbox = await cmd('EXAMINE INBOX');
  const exists = (inbox.find((l) => /EXISTS/.test(l)) || '').match(/(\d+) EXISTS/);
  console.log(`INBOX      ${exists ? exists[1] : '?'} messages (opened READ-ONLY)`);

  console.log(`unread     ${searchCount(await cmd('SEARCH UNSEEN'))}`);

  for (const addr of searchTo) {
    const n = searchCount(await cmd(`SEARCH TO "${addr}"`));
    console.log(`to ${addr.padEnd(30)} ${n} message(s)`);
  }

  const boxes = await cmd('LIST "" "*"');
  console.log(`mailboxes  ${boxes.filter((l) => l.startsWith('* LIST')).length}`);

  done = true; // set BEFORE LOGOUT: the server may RST as it processes it
  await cmd('LOGOUT');
  console.log('\nREAD-ONLY check passed. Nothing was modified, nothing was sent.');
  sock.end();
} catch (e) {
  const hint = /AUTHENTICATIONFAILED|Invalid credentials/i.test(e.message)
    ? '\nThe app password was rejected. If it is a Google app password, check it is\n' +
      'the 16 characters with the SPACES REMOVED, and that it was created for this\n' +
      'same account.'
    : '';
  console.error(`\nfailed: ${e.message}${hint}`);
  sock.end();
  process.exit(1);
}
