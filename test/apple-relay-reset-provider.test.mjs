import assert from 'node:assert/strict';
import test from 'node:test';
import { createVendureMailboxProvider } from '../server/apple-relay/vendure-provider.mjs';

test('mailbox code reset uses the legacy admin mutations and preserves zero or omitted validity', async () => {
  const requests = [];
  const provider = createVendureMailboxProvider(
    {
      adminUrl: 'http://127.0.0.1:12345/admin-api',
      shopUrl: 'http://127.0.0.1:12345/shop-api',
      apiKey: 'isolated-test-key'
    },
    async (url, request) => {
      const payload = JSON.parse(request.body);
      assert.equal(url, 'http://127.0.0.1:12345/admin-api');
      assert.equal(request.method, 'POST');
      assert.equal(request.redirect, 'error');
      assert.equal(request.headers['vendure-api-key'], 'isolated-test-key');
      requests.push(payload);
      return Response.json({
        data: {
          result: {
            id: payload.variables.id,
            codeExpiresAt: null,
            codeResetIntervalDays: payload.variables.codeResetIntervalDays ?? 30
          }
        }
      });
    }
  );

  await provider.resetPrimaryCode('primary-fixture', 180);
  await provider.resetAliasCode('alias-fixture', 0);
  await provider.resetAliasCode('alias-fixture');

  assert.match(
    requests[0].query,
    /resetIcloudMasterCode\(id: \$id, codeResetIntervalDays: \$codeResetIntervalDays\)/
  );
  assert.match(
    requests[0].query,
    /id email status masterQueryCode codeExpiresAt codeResetIntervalDays/
  );
  assert.deepEqual(requests[0].variables, { id: 'primary-fixture', codeResetIntervalDays: 180 });
  assert.match(
    requests[1].query,
    /resetIcloudVirtualEmailCode\(id: \$id, codeResetIntervalDays: \$codeResetIntervalDays\)/
  );
  assert.match(
    requests[1].query,
    /id primaryAccountId aliasEmail status buyerQueryCode codeExpiresAt codeResetIntervalDays/
  );
  assert.deepEqual(requests[1].variables, { id: 'alias-fixture', codeResetIntervalDays: 0 });
  assert.deepEqual(requests[2].variables, { id: 'alias-fixture' });
});
