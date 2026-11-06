import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BIT_BROWSER_AUTHORIZATION_MAX_BYTES,
  buildBitBrowserBackupPayload,
  parseBitBrowserAuthorization
} from '../modules/recharge/bitbrowser/authorization.mjs';
import {
  BITBROWSER_BACKUP_START,
  createBitBrowserBackup
} from '../modules/recharge/bitbrowser/backup.mjs';

const session = {
  user: { id: 'fixture-user', email: 'Authorized@Example.test' },
  account: { id: 'fixture-account' },
  sessionToken: 'fixture-session-secret'
};

function accessToken(claims) {
  return 'fixture.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.fixture';
}

test('accepts the original field aliases and keeps the credential out of the parsed summary', () => {
  const original = parseBitBrowserAuthorization(JSON.stringify(session));
  assert.equal(original.token, session.sessionToken);
  assert.deepEqual(JSON.parse(JSON.stringify(original)), {
    email: 'authorized@example.test',
    userId: 'fixture-user',
    accountId: 'fixture-account'
  });

  const fromClaims = parseBitBrowserAuthorization(
    JSON.stringify({
      user: session.user,
      session_token: session.sessionToken,
      access_token: accessToken({
        'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' },
        'https://api.openai.com/profile': { email: 'authorized@example.test' }
      })
    })
  );
  assert.deepEqual(fromClaims, original);
  assert.equal(fromClaims.token, session.sessionToken);
});

test('rejects conflicting identities, invalid tokens and oversized UTF-8 input without leaking secrets', () => {
  const invalidSessions = [
    { ...session, user: { ...session.user, id: undefined } },
    { ...session, sessionToken: 'fixture-secret; invalid-cookie' },
    { ...session, session_token: 'fixture-secret-conflict' },
    {
      ...session,
      accessToken: accessToken({
        'https://api.openai.com/auth': { chatgpt_account_id: 'conflicting-account' }
      })
    },
    {
      ...session,
      access_token: accessToken({
        'https://api.openai.com/profile': { email: 'other@example.test' }
      })
    },
    { ...session, accessToken: 'malformed-token' }
  ];

  for (const invalidSession of invalidSessions) {
    assert.throws(
      () => parseBitBrowserAuthorization(JSON.stringify(invalidSession)),
      (error) => /授权 JSON/.test(error.message) && !error.message.includes('fixture-secret')
    );
  }

  const multibyte = JSON.stringify({
    ...session,
    notes: '文'.repeat(Math.floor(BIT_BROWSER_AUTHORIZATION_MAX_BYTES / 3))
  });
  assert.ok(multibyte.length < BIT_BROWSER_AUTHORIZATION_MAX_BYTES);
  assert.throws(() => parseBitBrowserAuthorization(multibyte), /超过 65 KB/);
});

test('binds the direct start payload to the parsed email without sending credentials or bypass flags', async () => {
  const authorization = parseBitBrowserAuthorization(JSON.stringify(session));
  const body = buildBitBrowserBackupPayload(authorization, {
    id: '40000000-0000-0000-0000-000000000001',
    plan: 'plus',
    addressId: '40000000-0000-0000-0000-000000000002',
    windowName: '本地测试',
    lockedCurrency: 'PHP',
    expectedEmail: 'other@example.test',
    manualPaymentConfirmation: false,
    authorizeSinglePayment: false,
    directMode: false,
    sessionJson: JSON.stringify(session),
    token: authorization.token,
    cvc: 'fixture-cvc',
    useSavedCredentials: true,
    loginMethod: 'password'
  });
  assert.equal(body.expectedEmail, 'authorized@example.test');
  assert.equal(body.directMode, true);
  assert.equal(body.authorizeSinglePayment, true);
  assert.equal(body.manualPaymentConfirmation, true);
  assert.doesNotMatch(
    JSON.stringify(body),
    /fixture-session-secret|fixture-cvc|other@example.test|sessionJson|loginMethod|useSavedCredentials/
  );
  assert.throws(
    () => buildBitBrowserBackupPayload({ ...authorization }, {}),
    /请先核对当前浏览器中的授权 JSON/
  );

  assert.throws(
    () => buildBitBrowserBackupPayload(authorization, { ...body, billingName: authorization }),
    /任务资料无效/
  );

  const handle = createBitBrowserBackup({
    requireOperator: () => ({ id: 'fixture-operator' }),
    startDirectRecharge: (metadata) => {
      assert.deepEqual(metadata, body);
      return { id: metadata.id };
    }
  });
  assert.equal(
    (await handle({ method: 'POST', pathname: BITBROWSER_BACKUP_START, body })).status,
    201
  );
});
