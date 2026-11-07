import assert from 'node:assert/strict';
import test from 'node:test';
import { readWindowRecord, writeWindowRecord } from '../server/bitbrowser-login-windows.mjs';

const lookup = { connectionKey: 'a'.repeat(64), accountKey: 'b'.repeat(64) };
const command = { ...lookup, version: 0, profileId: 'c'.repeat(32), proxyConfiguration: 'd'.repeat(64) };

test('window records are isolated by connection and account and reject stale writes', () => {
  const first = writeWindowRecord(null, command);
  assert.equal(readWindowRecord(first.rows, lookup).profileId, command.profileId);
  assert.equal(readWindowRecord(first.rows, { ...lookup, connectionKey: 'e'.repeat(64) }), null);
  assert.equal(readWindowRecord(first.rows, { ...lookup, accountKey: 'f'.repeat(64) }), null);
  assert.throws(() => writeWindowRecord(first.rows, command), { status: 409 });
  const second = writeWindowRecord(first.rows, { ...command, version: 1, proxyConfiguration: 'e'.repeat(64) });
  assert.equal(second.record.version, 2);
  assert.equal(second.record.sourceJobId, first.record.sourceJobId);
});

test('only an explicitly confirmed missing original window can be replaced', () => {
  const first = writeWindowRecord(null, command);
  const replacement = { ...command, version: 1, profileId: 'e'.repeat(32) };
  assert.throws(() => writeWindowRecord(first.rows, replacement), { status: 409 });
  assert.throws(() => writeWindowRecord(first.rows, { ...replacement, replacedProfileId: 'f'.repeat(32), missingConfirmed: true }), { status: 409 });
  const replaced = writeWindowRecord(first.rows, { ...replacement, replacedProfileId: command.profileId, missingConfirmed: true });
  assert.equal(replaced.rows.length, 1);
  assert.equal(replaced.record.profileId, replacement.profileId);
  assert.notEqual(replaced.record.sourceJobId, first.record.sourceJobId);
});

test('one native window cannot be assigned to two account identities on one connection', () => {
  const first = writeWindowRecord(null, command);
  assert.throws(() => writeWindowRecord(first.rows, { ...command, accountKey: 'f'.repeat(64) }), { status: 409 });
});

test('window persistence accepts no authorization, credentials, raw identity, or arbitrary fields', () => {
  for (const extra of [{ sessionJson: '{}' }, { token: 'fixture' }, { email: 'fixture@example.test' }, { password: 'fixture' }, { ownerId: 'fixture' }])
    assert.throws(() => writeWindowRecord(null, { ...command, ...extra }), { status: 400 });
  for (const extra of [{ version: -1 }, { version: 0.5 }, { accountKey: 'plain-account' }, { profileId: '../other' }, { proxyConfiguration: 'proxy-password' }])
    assert.throws(() => writeWindowRecord(null, { ...command, ...extra }), { status: 400 });
  assert.throws(() => readWindowRecord(null, { ...lookup, sessionJson: '{}' }), { status: 400 });
});
