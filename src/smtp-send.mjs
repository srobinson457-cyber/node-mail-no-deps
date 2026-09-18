#!/usr/bin/env node
/**
 * Send mail over SMTP with zero dependencies.
 *
 * SMTP is a line protocol over TLS, so raw sockets are enough for AUTH / MAIL /
 * RCPT / DATA. Writing it out is maybe 120 lines, and it keeps the credential
 * out of any third-party package: nothing in your dependency tree, at any depth,
 * ever holds the password to a real mailbox.
 *
 * *** THIS SENDS REAL MAIL TO REAL PEOPLE. ***
 * DRY RUN BY DEFAULT. It prints the envelope and the head of the body and sends
 * nothing. You must pass --send.
 *
 * Configuration, all from the environment, nothing hardcoded:
 *   SMTP_HOST       e.g. smtp.gmail.com
 *   SMTP_PORT       default 465 (implicit TLS)
 *   SMTP_USER       the mailbox to authenticate and send as
 *   SMTP_PASS       app password / token. Never printed, logged, or echoed.
 *   SMTP_FROM_NAME  optional display name
 *
 *   node src/smtp-send.mjs --to a@b.com --subject "Hi" --body msg.txt
 *   node src/smtp-send.mjs --to a@b.com --cc c@d.com --subject "Hi" \
 *                          --body msg.txt --attach letter.pdf --send
 *
 *   --to        required, repeatable
 *   --cc        repeatable
 *   --subject   required
 *   --body      required, path to a UTF-8 plain-text file
 *   --attach    repeatable, content type guessed from the extension
 *   --send      actually send. Without it, nothing leaves the machine.
 *
 * A 250 from SMTP proves ACCEPTANCE, not delivery. If it matters, verify in the
 * sent folder afterwards; imap-check.mjs is the tool for that.
 */
import { readFileSync, existsSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { connectWithRetry, describe } from './tls-connect.mjs';

const HOST = process.env.SMTP_HOST;
const PORT = Number(process.env.SMTP_PORT ?? 465);
const USER = process.env.SMTP_USER;
const FROM_NAME = process.env.SMTP_FROM_NAME ?? '';

if (!HOST || !USER || !process.env.SMTP_PASS) {
  console.error('SMTP_HOST, SMTP_USER and SMTP_PASS must all be set in the environment.');
  process.exit(2);
}
// Read once, here, so it is never passed around or captured in a closure that
// might end up in a log line.
const PASS = process.env.SMTP_PASS.replace(/\s+/g, '');

// ---- args -----------------------------------------------------------------
const argv = process.argv.slice(2);
const many = (flag) => argv.reduce((a, v, i) => (v === flag ? [...a, argv[i + 1]] : a), []);
const one = (flag) => many(flag).at(-1);

const to = many('--to');
const cc = many('--cc');
const subject = one('--subject');
const bodyFile = one('--body');
const attach = many('--attach');
const live = argv.includes('--send');

if (!to.length || !subject || !bodyFile) {
  console.error(
    'usage: smtp-send.mjs --to <addr> --subject <text> --body <file> [--cc <addr>] [--attach <file>] [--send]',
  );
  process.exit(2);
}
for (const f of [bodyFile, ...attach]) {
  if (!existsSync(f)) {
    console.error(`no such file: ${f}`);
    process.exit(2);
  }
}
const body = readFileSync(bodyFile, 'utf8');

// ---- MIME -----------------------------------------------------------------
const b64 = (b) => Buffer.from(b).toString('base64');
const wrapB64 = (s) => s.replace(/(.{1,76})/g, '$1\r\n').trimEnd();
// RFC 2047 encoded-word, so a non-ASCII header survives the wire.
const enc = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(Buffer.from(s, 'utf8'))}?=`);

const TYPES = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
const typeOf = (f) => TYPES[extname(f).toLowerCase()] ?? 'application/octet-stream';

const date = new Date().toUTCString().replace('GMT', '+0000');
const msgId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@${USER.split('@')[1] ?? 'localhost'}>`;
const bound = `=_mail_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

const headers = [
  FROM_NAME ? `From: ${enc(FROM_NAME)} <${USER}>` : `From: ${USER}`,
  `To: ${to.join(', ')}`,
  ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []),
  `Subject: ${enc(subject)}`,
  `Date: ${date}`,
  `Message-ID: ${msgId}`,
  'MIME-Version: 1.0',
];

const textPart = ['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit', '', body];

let message;
if (attach.length) {
  const parts = [`--${bound}`, ...textPart];
  for (const f of attach) {
    parts.push(
      `--${bound}`,
      `Content-Type: ${typeOf(f)}; name="${basename(f)}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${basename(f)}"`,
      '',
      wrapB64(b64(readFileSync(f))),
    );
  }
  parts.push(`--${bound}--`, '');
  message = [...headers, `Content-Type: multipart/mixed; boundary="${bound}"`, '', ...parts].join('\r\n');
} else {
  message = [...headers, ...textPart].join('\r\n');
}

// ---- dry run --------------------------------------------------------------
const recipients = [...to, ...cc];
if (!live) {
  console.log('DRY RUN — nothing sent. Add --send to actually send.\n');
  console.log(`From:    ${FROM_NAME ? FROM_NAME + ' ' : ''}<${USER}>`);
  console.log(`To:      ${to.join(', ')}`);
  if (cc.length) console.log(`Cc:      ${cc.join(', ')}`);
  console.log(`Subject: ${subject}`);
  for (const f of attach) {
    console.log(`Attach:  ${basename(f)}  (${typeOf(f)}, ${readFileSync(f).length} bytes)`);
  }
  console.log(`Body:    ${bodyFile} — ${body.split('\n').length} lines, ${body.length} chars`);
  console.log('\n--- first 15 lines of body ---');
  console.log(body.split('\n').slice(0, 15).join('\n'));
  process.exit(0);
}

// ---- SMTP -----------------------------------------------------------------
const sock = await connectWithRetry({ host: HOST, port: PORT, label: 'smtp' });
sock.setEncoding('utf8');
let buf = '';
let waiter = null;

/**
 * Set the instant the server returns 250 for the DATA payload. Past this point
 * the message is IN THE SERVER'S HANDS and a socket error means nothing about
 * delivery.
 *
 * THE BUG THIS FLAG EXISTS FOR, because it is the expensive kind: the error
 * handler used to be unconditional, so the server dropping the connection after
 * QUIT — which many do, routinely — printed "connection failed" and exited 1 for
 * mail that had ALREADY BEEN ACCEPTED.
 *
 * The natural human response to "SEND FAILED" is to send again. So the bug's
 * consequence was not a confusing log line, it was a DUPLICATE MESSAGE to a real
 * person, caused by the tool reporting failure for something that succeeded.
 */
let accepted = false;

sock.on('data', (c) => {
  buf += c;
  pump();
});
sock.on('error', (e) => {
  if (accepted) {
    console.error(`(post-acceptance socket close: ${describe(e)} — message was already accepted, not resending)`);
    return;
  }
  console.error('connection failed:', describe(e));
  sock.destroy();
  // NOT process.exit(1): calling it while the TLS socket is closing trips a
  // libuv assertion and exits 127. Set the code and let the loop drain.
  process.exitCode = 1;
});

function pump() {
  if (!waiter) return;
  // A reply is COMPLETE only on "NNN<space>". "NNN-" is a continuation line, so
  // matching on the code alone truncates multi-line greetings and EHLO replies.
  const m = buf.match(/^\d{3} [^\r\n]*\r\n/m);
  if (!m) return;
  const end = m.index + m[0].length;
  const reply = buf.slice(0, end);
  buf = buf.slice(end);
  const { codes, resolve, reject } = waiter;
  waiter = null;
  const got = Number(reply.match(/^(\d{3})/m)[1]);
  codes.includes(got) ? resolve(reply) : reject(new Error(`expected ${codes}, got: ${reply.trim()}`));
}

/**
 * Every wait is bounded. Without this, a reply that never arrives leaves the
 * top-level await unsettled forever: node prints "Detected unsettled top-level
 * await" and exits 13.
 *
 * Measured: that is exactly what happened when a server accepted the message and
 * then vanished instead of answering QUIT. A SENT message reported failure to
 * the caller, which is the same duplicate-send hazard as above by another route.
 */
const expect = (codes, timeoutMs = 30_000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (waiter) { waiter = null; reject(new Error(`timed out after ${timeoutMs / 1000}s waiting for ${codes}`)); }
    }, timeoutMs);
    waiter = {
      codes,
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    };
    pump();
  });

// A close with a reply outstanding is a failed wait, not a hang. Reject at once
// rather than sitting out the full timeout.
sock.on('close', () => {
  if (waiter) { const w = waiter; waiter = null; w.reject(new Error('connection closed before reply')); }
});

const cmd = (line, codes, secret = false, timeoutMs = 30_000) => {
  console.log(secret ? '> <redacted>' : `> ${line}`);
  const p = expect(codes, timeoutMs);
  sock.write(line + '\r\n');
  return p;
};

// CRLF endings, and dot-stuff any line starting with "." so a line of the body
// can never be read as the end-of-data marker.
const dotStuff = (s) => s.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');

try {
  await expect([220]);
  await cmd('EHLO localhost', [250]);
  await cmd(`AUTH PLAIN ${b64(Buffer.from(`\0${USER}\0${PASS}`, 'utf8'))}`, [235], true);
  await cmd(`MAIL FROM:<${USER}>`, [250]);
  for (const r of recipients) await cmd(`RCPT TO:<${r}>`, [250, 251]);
  await cmd('DATA', [354]);
  sock.write(dotStuff(message) + '\r\n.\r\n');
  const ok = await expect([250]);
  accepted = true; // MUST be set BEFORE QUIT — servers often drop the socket there
  console.log(`\naccepted for delivery: ${ok.trim()}`);
  console.log(`recipients: ${recipients.join(', ')}`);
  console.log('NOTE: acceptance is not delivery. Confirm in the sent folder if it matters.');
  // A failed QUIT after a 250 is cosmetic. The message is already accepted, and
  // reporting failure here would invite exactly the duplicate send this guards.
  try {
    await cmd('QUIT', [221], false, 5_000);
  } catch (e) {
    console.error(`(QUIT did not complete cleanly: ${e.message} — message was already accepted)`);
  }
  sock.end();
} catch (e) {
  if (accepted) {
    // Cannot be a send failure: the 250 already happened.
    console.error(`(error after acceptance, message was still sent: ${e.message})`);
    sock.destroy();
  } else {
    console.error(`\nSEND FAILED: ${e.message}`);
    sock.destroy();
    process.exitCode = 1;
  }
}
