import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BITBROWSER_BACKUP_START,
  createBitBrowserBackup
} from '../modules/recharge/bitbrowser/backup.mjs';

const input = {
  id: '40000000-0000-0000-0000-000000000001',
  plan: 'plus',
  addressId: '40000000-0000-0000-0000-000000000002',
  windowName: '测试窗口',
  lockedCurrency: 'PHP',
  expectedEmail: 'authorized@example.test',
  directMode: true,
  authorizeSinglePayment: true,
  manualPaymentConfirmation: true
};
const request = { method: 'POST', pathname: BITBROWSER_BACKUP_START, body: input };

test('delegates direct JSON payment metadata to the host service for the unified operator', async () => {
  const operator = { id: 'owner' };
  const context = { session: 'same-system' };
  const launch = { id: input.id, mode: 'payment', transport: 'web_direct' };
  const handle = createBitBrowserBackup({
    requireOperator: (receivedContext) => {
      assert.equal(receivedContext, context);
      return operator;
    },
    startDirectRecharge: (body, receivedOperator) => {
      assert.deepEqual(body, input);
      assert.equal(receivedOperator, operator);
      return launch;
    }
  });

  assert.deepEqual(await handle({ ...request, context }), {
    status: 201,
    headers: { 'Cache-Control': 'no-store' },
    body: launch
  });
});

test('never delegates alternative modes, authorization secrets, or unauthorized requests', async () => {
  const handle = createBitBrowserBackup({
    requireOperator: (context) => (context?.authorized ? { id: 'owner' } : null),
    startDirectRecharge: () => assert.fail('disallowed request reached execution')
  });
  const context = { authorized: true };

  assert.equal((await handle(request)).status, 403);
  assert.equal((await handle({ ...request, method: 'GET', context })).status, 405);
  for (const path of ['jobs', 'jobs/bitbrowser-open', 'jobs/voucher', 'jobs/dispatch']) {
    assert.equal(
      await handle({ ...request, pathname: '/api/recharge/bitbrowser/' + path, context }),
      null
    );
  }
  for (const variation of [
    { directMode: false },
    { manualPaymentConfirmation: false },
    { authorizeSinglePayment: false },
    { chatgptAccountId: 'saved' },
    { useSavedCredentials: true },
    { loginMethod: 'password' },
    { password: 'unused' },
    { sessionJson: '{}' },
    { cvc: 'unused' },
    { expectedEmail: 'invalid' },
    { operatorId: 'other-owner' }
  ]) {
    const result = await handle({ ...request, body: { ...input, ...variation }, context });
    assert.equal(result.status, 400);
    assert.equal(result.headers['Cache-Control'], 'no-store');
  }
});
