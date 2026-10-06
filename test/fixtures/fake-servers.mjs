/**
 * Fake SMTP and IMAP servers for the protocol tests: 127.0.0.1, an ephemeral
 * port, and a committed test-only certificate. Nothing here reaches the network.
 *
 * Connections are accepted on node:net and wrapped in TLS by hand, so a test can
 * still reach the raw TCP socket and send a reset: resetAndDestroy() needs a TCP
 * handle, which a tls.Server connection does not expose.
 */
import net from 'node:net';
import tls from 'node:tls';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const fixture = (name) => fileURLToPath(new URL(name, import.meta.url));

// Test-only key and certificates for localhost and 127.0.0.1. The trusted one is
// handed to child processes through NODE_EXTRA_CA_CERTS; nothing else trusts it.
export const TRUSTED_CERT = fixture('./localhost.crt');
const KEY = readFileSync(fixture('./localhost.key'));
const CERTS = { trusted: readFileSync(TRUSTED_CERT), untrusted: readFileSync(fixture('./untrusted.crt')) };

export const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Listen on 127.0.0.1:0. With `tls: false` the handler gets the raw socket and
 * no handshake ever happens. `connections` counts accepted TCP connections.
 */
export async function listen(onSession, { tls: useTls = true, cert = 'trusted' } = {}) {
  const open = new Set();
  const stats = { connections: 0 };
  const server = net.createServer((raw) => {
    stats.connections++;
    open.add(raw);
    raw.on('close', () => open.delete(raw));
    raw.on('error', () => {});
    if (!useTls) return onSession(raw);
    const sock = new tls.TLSSocket(raw, { isServer: true, key: KEY, cert: CERTS[cert] });
    sock.on('error', () => {});
    onSession(lineSession(sock, raw));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    stats,
    close: () => {
      for (const raw of open) raw.destroy();
      return new Promise((r) => server.close(r));
    },
  };
}

function lineSession(sock, raw) {
  let buf = '';
  let ended = false;
  const readers = [];
  const drain = () => {
    while (readers.length) {
      const i = buf.indexOf('\r\n');
      if (i >= 0) {
        readers.shift()(buf.slice(0, i));
        buf = buf.slice(i + 2);
      } else if (ended) readers.shift()(null);
      else return;
    }
  };
  sock.setEncoding('utf8');
  sock.on('data', (d) => { buf += d; drain(); });
  sock.on('close', () => { ended = true; drain(); });
  const secure = new Promise((r) => sock.once('secure', r));
  return {
    secure,
    hasInput: () => buf.length > 0,
    line: () => new Promise((r) => { readers.push(r); drain(); }),
    send: (text) => sock.write(text + '\r\n'),
    end: () => sock.end(),
    reset: () => raw.resetAndDestroy(),
  };
}

/**
 * SMTP. `greeting` is sent one line at a time with a short gap, so a multi-line
 * reply really does arrive in pieces. `afterData` / `onQuit` choose between a
 * normal reply and a TCP reset.
 */
export async function fakeSmtp({ greeting = ['220 fake.test ESMTP ready'], afterData = 'reply', onQuit = 'reply' } = {}) {
  const seen = { commands: [], data: null };
  const server = await listen(async (s) => {
    await s.secure;
    for (const line of greeting) { s.send(line); await pause(20); }
    for (let line; (line = await s.line()) !== null;) {
      const verb = line.split(' ')[0].toUpperCase();
      seen.commands.push(verb);
      if (verb === 'EHLO') s.send('250-fake.test\r\n250 AUTH PLAIN');
      else if (verb === 'AUTH') s.send('235 2.7.0 accepted');
      else if (verb === 'MAIL' || verb === 'RCPT') s.send('250 2.1.0 ok');
      else if (verb === 'DATA') {
        s.send('354 end data with <CRLF>.<CRLF>');
        seen.data = [];
        for (let d; (d = await s.line()) !== '.';) {
          if (d === null) return;
          seen.data.push(d);
        }
        if (afterData === 'reset') return s.reset();
        s.send('250 2.0.0 queued as FAKE1');
      } else if (verb === 'QUIT') {
        if (onQuit === 'reset') return s.reset();
        s.send('221 2.0.0 bye');
        return s.end();
      } else s.send('500 5.5.1 unrecognized');
    }
  });
  return { ...server, seen };
}

/**
 * IMAP. `greetDelayMs` holds the greeting back after the handshake; `seen.early`
 * records a command that arrived before it. `closeOn` ends the connection
 * cleanly when that command arrives, `resetOn` sends a TCP reset instead, and in
 * both cases the command gets no reply. `silentOn` never answers that command
 * and leaves the connection open.
 */
export async function fakeImap({
  greeting = '* OK [CAPABILITY IMAP4rev1] fake ready', greetDelayMs = 0, closeOn = null, resetOn = null,
  silentOn = null,
} = {}) {
  const seen = { commands: [], early: false };
  const server = await listen(async (s) => {
    await s.secure;
    await pause(greetDelayMs);
    seen.early = s.hasInput();
    s.send(greeting);
    if (greeting.startsWith('* BYE')) return s.end();
    for (let line; (line = await s.line()) !== null;) {
      const [tag, verb = '', ...rest] = line.split(' ');
      const cmd = verb.toUpperCase();
      seen.commands.push(cmd);
      if (cmd === closeOn) return s.end();
      if (cmd === resetOn) return s.reset();
      if (cmd === silentOn) continue;
      if (cmd === 'LOGIN') s.send(`${tag} OK LOGIN completed`);
      else if (cmd === 'EXAMINE') {
        s.send(`* 3 EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 1] ok\r\n${tag} OK [READ-ONLY] EXAMINE completed`);
      } else if (cmd === 'SEARCH') {
        s.send(`${rest[0] === 'UNSEEN' ? '* SEARCH 2' : '* SEARCH 1 3'}\r\n${tag} OK SEARCH completed`);
      } else if (cmd === 'LIST') {
        s.send(`* LIST () "/" "INBOX"\r\n* LIST () "/" "Sent"\r\n${tag} OK LIST completed`);
      } else if (cmd === 'LOGOUT') {
        s.send(`* BYE logging out\r\n${tag} OK LOGOUT completed`);
        return s.end();
      } else s.send(`${tag} BAD unknown command`);
    }
  });
  return { ...server, seen };
}
