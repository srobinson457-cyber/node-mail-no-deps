#!/usr/bin/env node
/**
 * Smoke tests that need no credentials and no network.
 *
 * The one that matters is the DRY RUN guard. A tool that sends real mail to real
 * people needs its "do nothing" path to be the default, and that default needs a
 * test, because the failure mode of getting it wrong is not an exception in a log.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, isRetryable, RETRYABLE } from '../src/tls-connect.mjs';

let failed = 0;
const ok = (name) => console.log(`  ok    ${name}`);
const bad = (name, detail) => { failed++; console.log(`  FAIL  ${name}\n        ${detail}`); };
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

const run = (args, env) => {
  try {
    const out = execFileSync(process.execPath, args, {
      env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? -1, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
};

console.log('tls-connect:');

// An AggregateError stringifies to the empty string. That is the whole reason
// describe() exists, so it is the thing to assert.
const agg = new AggregateError(
  [Object.assign(new Error('x'), { code: 'ETIMEDOUT', address: '10.0.0.1' })], '',
);
check('describe() unwraps AggregateError inner codes',
  describe(agg).includes('ETIMEDOUT') && describe(agg).includes('10.0.0.1'),
  `got: ${describe(agg)}`);
check('describe() survives null', describe(null) === '(no error)');
check('network errors are retryable', isRetryable({ code: 'ETIMEDOUT' }));
check('certificate errors are NOT retryable',
  !isRetryable({ code: 'CERT_HAS_EXPIRED' }),
  'a standing condition must surface fast, not after four retries');
check('AggregateError of retryables is retryable',
  isRetryable({ errors: [{ code: 'ETIMEDOUT' }, { code: 'ECONNRESET' }] }));
check('AggregateError with one unretryable is NOT retryable',
  !isRetryable({ errors: [{ code: 'ETIMEDOUT' }, { code: 'CERT_HAS_EXPIRED' }] }));
check('ABORT_ERR is retryable (our own deadline firing)', RETRYABLE.has('ABORT_ERR'));

console.log('\nsmtp-send:');

const dir = mkdtempSync(path.join(tmpdir(), 'mailtest-'));
const bodyFile = path.join(dir, 'body.txt');
writeFileSync(bodyFile, 'line one\nline two\n');

// Resolved from this file, not the current directory, so the suite gives the
// same answer wherever it is run from.
const SMTP = fileURLToPath(new URL('../src/smtp-send.mjs', import.meta.url));
const FAKE = {
  SMTP_HOST: 'smtp.invalid.example',
  SMTP_USER: 'nobody@example.com',
  SMTP_PASS: 'not-a-real-password',
  SMTP_FROM_NAME: 'Test Sender',
};

let r = run([SMTP, '--to', 'a@b.com', '--subject', 'Hi', '--body', bodyFile], { ...FAKE, SMTP_PASS: '' });
check('missing SMTP_PASS exits 2 before doing anything', r.code === 2, `exit=${r.code}`);

r = run([SMTP, '--subject', 'Hi', '--body', bodyFile], FAKE);
check('missing --to exits 2', r.code === 2, `exit=${r.code}`);

r = run([SMTP, '--to', 'a@b.com', '--subject', 'Hi', '--body', path.join(dir, 'nope.txt')], FAKE);
check('missing body file exits 2', r.code === 2, `exit=${r.code}`);

// THE IMPORTANT ONE. The host is deliberately unresolvable: if the dry run ever
// starts opening a socket, this test fails instead of quietly passing.
r = run([SMTP, '--to', 'a@b.com', '--subject', 'Hi', '--body', bodyFile], FAKE);
// A negative assertion ("X never appears") passes vacuously on a run that never
// happened, such as a script that could not be found. Each one below first
// requires proof that the dry run actually ran.
const dryRanOk = r.code === 0 && /DRY RUN/.test(r.out);
const notRun = `the dry run did not complete (exit=${r.code}), so this check proves nothing\n${r.out}`;
check('dry run is the DEFAULT and exits 0', r.code === 0, `exit=${r.code}\n${r.out}`);
check('dry run says it sent nothing', /DRY RUN/.test(r.out) && /nothing sent/i.test(r.out));
check('dry run never touches the network',
  dryRanOk && !/ETIMEDOUT|ENOTFOUND|EAI_AGAIN|connect/i.test(r.out),
  dryRanOk ? 'an unresolvable host would have errored if it had tried' : notRun);
check('dry run shows the envelope', /a@b\.com/.test(r.out) && /Hi/.test(r.out));
check('credential never appears in dry-run output',
  dryRanOk && !/not-a-real-password/.test(r.out),
  dryRanOk ? 'the password was printed' : notRun);

console.log(failed ? `\n${failed} FAILED` : '\nall smoke tests passed.');
process.exit(failed ? 1 : 0);
