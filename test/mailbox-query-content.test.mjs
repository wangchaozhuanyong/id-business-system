import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  createManagedMailboxQuery, managedMailboxQueryRoute, storefrontMailboxQueryRoute
} from '../server/tools/mailbox-pool.mjs';

// Exercise the real request handler without a server, database, network, or mailbox credentials.
async function query(body, route = managedMailboxQueryRoute) {
  const origin = 'https://mailbox.example.test';
  const code = 'MBX-' + 'F'.repeat(32);
  const item = { id: 'fixture', revision: 1, provider: 'google', email: 'fixture@example.test',
    expiresAt: '2027-01-01T00:00:00.000Z' };
  const mail = { subject: 'Verification code', receivedAt: '2026-11-12T09:06:09Z',
    from: 'sender@example.test', to: item.email, body };
  let recorded = 0;
  const handler = createManagedMailboxQuery({
    publicOrigin: origin, storefrontOrigin: origin,
    store: {
      findManagedMailbox: value => value === code ? item : null,
      recordManagedMailboxQuery: () => { recorded++; }
    },
    readMailbox: async () => [mail]
  });
  const request = Readable.from([Buffer.from(JSON.stringify({ queryCode: code, limit: 5 }))]);
  Object.assign(request, { method: 'POST', url: route,
    headers: { host: 'mailbox.example.test', origin, 'content-type': 'application/json' } });
  const response = {
    destroyed: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(value) { this.data = JSON.parse(value); }
  };
  await handler(request, response);
  assert.equal(response.status, 200);
  assert.equal(response.headers['Cache-Control'], 'private, no-store');
  assert.equal(recorded, 1);
  return response.data;
}

test('后台从完整的受限邮件内容提取验证码，展示预览仍保持原上限', async () => {
  const body = '<style>' + '.spacer{margin:0}'.repeat(160) +
    '</style><p>Verification code</p><strong>582913</strong>';
  const result = await query(body);
  assert.equal(result.items[0].body.length, 2000);
  assert.equal(result.items[0].body.includes('582913'), false);
  assert.equal(result.items[0].extractedCode, '582913');
});

test('后台提取忽略脚本及样式中的伪验证码，并遵守收信内容长度上限', async () => {
  const body = '<script>verification code 999999</script><style>.x{content:"验证码 888888"}</style>' +
    '<p>' + '说明文字'.repeat(600) + '</p><p>验证码 <b>713592</b></p>';
  assert.equal((await query(body)).items[0].extractedCode, '713592');
  assert.equal((await query('x'.repeat(16000) + '<p>验证码 713592</p>')).items[0].extractedCode, null);
});

test('商城契约继续返回完整邮件正文与时间，不增加后台验证码字段', async () => {
  const body = '<p>' + '说明文字'.repeat(600) + '</p><p>Verification code 582913</p>' +
    '<a href="https://example.test/verify?fixture=1&amp;purpose=mail">Verify</a>';
  const result = await query(body, storefrontMailboxQueryRoute);
  assert.equal(result.success, true);
  assert.equal(result.data.items[0].body, body);
  assert.equal(result.data.items[0].savedAt, '2026-11-12T09:06:09.000Z');
  assert.equal(Object.hasOwn(result.data.items[0], 'extractedCode'), false);
});
