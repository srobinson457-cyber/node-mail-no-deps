#!/usr/bin/env node
/**
 * Protocol tests: tls-connect and the two CLIs against fake servers on
 * 127.0.0.1 (see fixtures/fake-servers.mjs). No credentials, no internet.
 *
 * The smoke tests cover the dry-run default; these cover what happens on the
 * wire, including the guards the README describes. Each guard case was checked
 * by removing that guard and watching the case fail.
 */
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TRUSTED_CERT, listen, fakeSmtp, fakeImap, pause } from './fixtures/fake-servers.mjs';
import { connectOnce, connectWithRetry, describe } from '../src/tls-connect.mjs';

// NODE_EXTRA_CA_CERTS is read once at startup, so the in-process connects below
// only trust the test certificate if this process was started with it.
if (process.env.NODE_EXTRA_CA_CERTS !== TRUSTED_CERT) {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    stdio: 'inherit', env: { ...process.env, NODE_EXTRA_CA_CERTS: TRUSTED_CERT },
  });
  process.exit(r.status ?? 1);
}

let failed = 0;
const ok = (name) => console.log(`  ok    ${name}`);
const bad = (name, detail) => { failed++; console.log(`  FAIL  ${name}\n        ${detail}`); };
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

const SMTP = fileURLToPath(new URL('../src/smtp-send.mjs', import.meta.url));
const IMAP = fileURLToPath(new URL('../src/imap-check.mjs', import.meta.url));

/**
 * Spawned asynchronously, not with execFileSync: the fake server runs in this
 * process and has to keep answering while the CLI runs. A run still going at
 * limitMs is killed. `afterMark` is how long the process lived after `mark`
 * first appeared in its output.
 */
function run(script, args, env, { limitMs = 8_000, mark = null } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let markedAt = null;
    const collect = (d) => {
      out += d;
      if (mark && markedAt === null && mark.test(out)) markedAt = Date.now();
    };
    child.stdout.setEncoding('utf8').on('data', collect);
    child.stderr.setEncoding('utf8').on('data', collect);
    let killed = false;
    const limit = setTimeout(() => { killed = true; child.kill(); }, limitMs);
    child.on('close', (code) => {
      clearTimeout(limit);
      const now = Date.now();
      resolve({ code, killed, out, ms: now - t0, afterMark: markedAt === null ? null : now - markedAt });
    });
  });
}

const show = (r) =>
  `exit=${r.code}${r.killed ? ' (still running, killed at the limit)' : ''} after ${r.ms}ms` +
  `${r.afterMark !== null ? `, ${r.afterMark}ms after the marker line` : ''}\n` +
  r.out.trim().split('\n').map((l) => `        | ${l}`).join('\n');

// Settles to { v } or { e }, or { hung: true } if the promise is still pending at ms.
const within = (p, ms) => {
  let timer;
  const hung = new Promise((r) => { timer = setTimeout(() => r({ hung: true }), ms); });
  return Promise.race([p.then((v) => ({ v }), (e) => ({ e })), hung]).finally(() => clearTimeout(timer));
};

// ---- tls-connect -----------------------------------------------------------
console.log('tls-connect:');

{
  // Accepts TCP and never answers the ClientHello.
  const srv = await listen(() => {}, { tls: false });
  const t0 = Date.now();
  const r = await within(connectOnce({ host: '127.0.0.1', port: srv.port, timeoutMs: 300 }), 5_000);
  const ms = Date.now() - t0;
  r.v?.destroy();
  await srv.close();
  check('connectOnce: a handshake that never completes rejects ETIMEDOUT near timeoutMs',
    r.e?.code === 'ETIMEDOUT' && ms >= 290 && ms < 2_000,
    r.hung ? 'still pending after 5s' : `got ${r.e ? describe(r.e) : 'a connected socket'} after ${ms}ms`);
}

{
  const srv = await listen(async (s) => {
    await s.secure;
    for (let line; (line = await s.line()) !== null;) s.send(`echo ${line}`);
  });
  const r = await within(connectOnce({ host: '127.0.0.1', port: srv.port, timeoutMs: 200 }), 5_000);
  let pass = false;
  let detail = r.hung ? 'connect still pending after 5s' : `connect failed: ${describe(r.e)}`;
  if (r.v) {
    const sock = r.v;
    let err = null;
    sock.on('error', (e) => { err = e; });
    await pause(600); // three times timeoutMs
    const reply = new Promise((res) => sock.once('data', (d) => res(String(d))));
    sock.write('ping\r\n');
    const got = await within(reply, 2_000);
    pass = !err && got.v === 'echo ping\r\n';
    detail = err ? `session was destroyed: ${describe(err)}` : `reply: ${got.hung ? '(none within 2s)' : JSON.stringify(got.v)}`;
    sock.destroy();
  }
  await srv.close();
  check('connectOnce: a connected session survives past timeoutMs', pass, detail);
}

{
  // Resets every connection as soon as it is accepted: a retryable ECONNRESET.
  const srv = await listen((raw) => raw.resetAndDestroy(), { tls: false });
  const logs = [];
  const r = await within(connectWithRetry({
    host: '127.0.0.1', port: srv.port, attempts: 3, timeoutMs: 2_000, backoff: [20], log: (m) => logs.push(m),
  }), 10_000);
  r.v?.destroy();
  await srv.close();
  check('connectWithRetry: a retryable failure is tried `attempts` times',
    r.e && srv.stats.connections === 3 && logs.length === 2,
    `${srv.stats.connections} connections, ${r.hung ? 'still pending' : r.e ? describe(r.e) : 'connected'}\n        ${logs.join('\n        ')}`);
}

{
  const srv = await listen(() => {}, { cert: 'untrusted' });
  const logs = [];
  const r = await within(connectWithRetry({
    host: '127.0.0.1', port: srv.port, attempts: 4, timeoutMs: 2_000, backoff: [200], log: (m) => logs.push(m),
  }), 15_000);
  r.v?.destroy();
  await srv.close();
  check('connectWithRetry: a certificate error is not retried',
    /CERT/.test(r.e?.code ?? '') && srv.stats.connections === 1,
    `${srv.stats.connections} connections, ${r.hung ? 'still pending' : r.e ? describe(r.e) : 'connected'}\n        ${logs.join('\n        ')}`);
}

// ---- smtp-send ---------------------------------------------------------------
console.log('\nsmtp-send:');

const dir = mkdtempSync(path.join(tmpdir(), 'mailproto-'));
// 'exit' also fires on process.exit() and on an uncaught error, so a failed
// check or a crash removes the directory too.
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
const bodyFile = path.join(dir, 'body.txt');
writeFileSync(bodyFile, 'first line\n.leading dot\n.\nlast line\n');
const send = (port) => run(SMTP, ['--to', 'rcpt@example.com', '--subject', 'Test', '--body', bodyFile, '--send'], {
  SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_USER: 'sender@example.com', SMTP_PASS: 'fake-password',
});

{
  // A reset, not a clean close: only a reset makes the client see a socket error.
  const srv = await fakeSmtp({ onQuit: 'reset' });
  const r = await send(srv.port);
  await srv.close();
  check('reset after QUIT: exits 0 and says the message was already accepted',
    r.code === 0 && /accepted for delivery/.test(r.out) && /post-acceptance socket close/.test(r.out) &&
      !/SEND FAILED/.test(r.out),
    show(r));
}

{
  const srv = await fakeSmtp({ afterData: 'reset' });
  const r = await send(srv.port);
  await srv.close();
  check('dropped before the 250: exits 1 with SEND FAILED',
    srv.seen.data !== null && r.code === 1 && /SEND FAILED/.test(r.out) && !/accepted for delivery/.test(r.out),
    show(r));
}

{
  const srv = await fakeSmtp({ greeting: ['220-fake.test ESMTP', '220-a greeting in three lines', '220 ready'] });
  const r = await send(srv.port);
  await srv.close();
  check('multi-line 220- greeting is read to its last line',
    r.code === 0 && /accepted for delivery/.test(r.out) && srv.seen.commands[0] === 'EHLO',
    show(r));
}

{
  const srv = await fakeSmtp();
  const r = await send(srv.port);
  await srv.close();
  const data = srv.seen.data ?? [];
  check('a body line starting with "." arrives dot-stuffed',
    r.code === 0 && data.includes('..leading dot') && data.includes('..') && data.includes('last line'),
    `server received DATA lines: ${JSON.stringify(data.slice(-6))}\n        ${show(r)}`);
}

// ---- imap-check --------------------------------------------------------------
console.log('\nimap-check:');

const imap = (port, opts) => run(IMAP, ['--to', 'support@example.com'], {
  IMAP_HOST: '127.0.0.1', IMAP_PORT: String(port), IMAP_USER: 'reader@example.com', IMAP_PASS: 'fake-password',
}, opts);

{
  const srv = await fakeImap();
  const r = await imap(srv.port, { mark: /READ-ONLY check passed/ });
  await srv.close();
  check('a passing check exits 0 within 2s of reporting success',
    r.code === 0 && r.afterMark !== null && r.afterMark < 2_000, show(r));
  check('reports the counts from the server replies',
    /INBOX\s+3 messages/.test(r.out) && /unread\s+1\n/.test(r.out) &&
      /support@example\.com\s+2 message/.test(r.out) && /mailboxes\s+2\n/.test(r.out),
    show(r));
}

{
  const srv = await fakeImap({ closeOn: 'EXAMINE' });
  const r = await imap(srv.port, { mark: /> EXAMINE/ });
  await srv.close();
  check('server closing mid-command: exits 1 within 2s, reporting the closed connection',
    r.code === 1 && r.afterMark !== null && r.afterMark < 2_000 && /connection closed/i.test(r.out), show(r));
}

{
  const srv = await fakeImap({ greetDelayMs: 1_000 });
  const r = await imap(srv.port);
  await srv.close();
  check('waits for a slow greeting before sending anything',
    r.code === 0 && !srv.seen.early && srv.seen.commands[0] === 'LOGIN',
    `a command arrived before the greeting: ${srv.seen.early}\n        ${show(r)}`);
}

{
  const srv = await fakeImap({ greeting: '* BYE too many connections' });
  const r = await imap(srv.port);
  await srv.close();
  check('a BYE greeting fails at once with the server\'s reason',
    r.code === 1 && /too many connections/.test(r.out) && r.ms < 4_000, show(r));
}

{
  const srv = await fakeImap({ resetOn: 'LOGOUT' });
  const r = await imap(srv.port);
  await srv.close();
  check('reset during LOGOUT: still exits 0, every check had passed',
    r.code === 0 && /READ-ONLY check passed/.test(r.out), show(r));
}

{
  // The limit is past the 20 s command timeout, so a LOGOUT that waits it out
  // shows up as a 20 s run rather than as a kill.
  const srv = await fakeImap({ silentOn: 'LOGOUT' });
  const r = await imap(srv.port, { mark: /> LOGOUT/, limitMs: 25_000 });
  await srv.close();
  check('LOGOUT never answered: exits 0 after the 5s LOGOUT timeout, not the 20s one',
    r.code === 0 && /READ-ONLY check passed/.test(r.out) && /timed out after 5s waiting for LOGOUT/.test(r.out) &&
      r.afterMark !== null && r.afterMark < 8_000,
    show(r));
}

console.log(failed ? `\n${failed} FAILED` : '\nall protocol tests passed.');
process.exit(failed ? 1 : 0);
