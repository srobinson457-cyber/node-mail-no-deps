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
import { replyReader } from './reply-reader.mjs';

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
let seq = 0;
const reader = replyReader(sock);
const TIMEOUT_MS = 20_000;

sock.on('error', (e) => {
  if (done) return; // post-LOGOUT teardown, not a failure
  console.error('connection failed:', describe(e));
  sock.destroy();
  process.exitCode = 1;
});

// Resolves with the untagged lines; a tagged NO or BAD rejects with its text.
const cmd = async (text, secret = false, timeoutMs = TIMEOUT_MS) => {
  const tag = `a${++seq}`;
  process.stdout.write(secret ? '  > LOGIN <credential withheld>\n' : `  > ${text}\n`);
  const reply = reader.wait(text.split(' ')[0], new RegExp(`^${tag} (OK|NO|BAD)[^\\r\\n]*\\r\\n`, 'm'), timeoutMs);
  sock.write(`${tag} ${text}\r\n`);
  const lines = (await reply).split(/\r?\n/).filter(Boolean);
  const status = lines.pop().slice(tag.length + 1);
  if (!status.startsWith('OK')) throw new Error(status);
  return lines;
};

const searchCount = (lines) =>
  (lines.find((l) => l.startsWith('* SEARCH')) || '').split(/\s+/).slice(2).filter(Boolean).length;

try {
  // The greeting is the first line the server sends. Read it rather than
  // sleeping past it, so nothing is sent before the server is ready.
  const greeting = (await reader.wait('greeting', /^[^\r\n]*\r\n/, TIMEOUT_MS)).trim();
  if (!/^\* OK\b/i.test(greeting)) throw new Error(`server did not greet with OK: ${greeting}`);
  console.log(`connected  ${HOST}:${PORT}  TLS ${sock.getProtocol()}`);
  console.log(`account    ${USER}`);

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
  // Every check has already passed, so a LOGOUT that fails is teardown, not a
  // failed check. Bounded at 5 s, as smtp-send bounds QUIT: a server that never
  // answers LOGOUT should not hold a passed check open for the full 20 s.
  try {
    await cmd('LOGOUT', false, 5_000);
  } catch (e) {
    console.error(`(LOGOUT did not complete cleanly: ${e.message}. The checks above had passed.)`);
  }
  console.log('\nREAD-ONLY check passed. Nothing was modified, nothing was sent.');
  sock.end();
} catch (e) {
  const hint = /AUTHENTICATIONFAILED|Invalid credentials/i.test(e.message)
    ? '\nThe app password was rejected. If it is a Google app password, check it is\n' +
      'the 16 characters with the SPACES REMOVED, and that it was created for this\n' +
      'same account.'
    : '';
  console.error(`\nfailed: ${e.message}${hint}`);
  // Set the code and let the loop drain, as smtp-send does, rather than calling
  // process.exit() while the socket closes. No timer is left armed, so the
  // process exits as soon as the socket is gone.
  sock.destroy();
  process.exitCode = 1;
}
