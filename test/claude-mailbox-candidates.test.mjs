import assert from 'node:assert/strict';
import test from 'node:test';
import { withClaudeMailboxCandidates } from '../server/tools/claude-mailbox-candidates.mjs';
import { mailboxPoolMetadata, prepareVerifiedMailboxWrite, extractManagedMailboxCode } from '../server/tools/mailbox-pool.mjs';

test('Claude 邮箱去重登记为待授权，不复制库存密码、查询码或其他产品邮箱', () => {
  const metadata = { version: 7, defaultValidDays: 7, items: [
    { id: 'existing', email: 'existing@example.test', active: true, provider: 'google' }
  ] };
  const before = structuredClone(metadata);
  const inventory = { accounts: [
    { id: 'a', type: 'claude', email: 'EXISTING@example.test', password: 'SYNTHETIC' },
    { id: 'b', type: 'claude', email: 'new@example.test', emailType: 'google', password: 'SYNTHETIC' },
    { id: 'c', type: 'claude', email: 'NEW@example.test' },
    { id: 'd', type: 'claude', email: 'relay@example.test', emailType: 'relay' },
    { id: 'e', type: 'gpt', email: 'gpt@example.test' },
    { id: 'f', type: 'claude', email: 'invalid' }
  ] };
  const result = withClaudeMailboxCandidates(metadata, inventory);
  assert.equal(result.version, 7);
  assert.equal(result.items.length, 3);
  assert.equal(result.items[0].id, 'existing');
  assert.equal(result.items[0].source, 'claude');
  assert.equal(result.items[1].authorizationPending, true);
  assert.equal(result.items[1].active, false);
  assert.equal(result.items[1].provider, 'google');
  assert.equal(result.items[2].provider, 'relay');
  assert(!JSON.stringify(result).includes('SYNTHETIC'));
  assert.equal(Object.hasOwn(result.items[1], 'queryCode'), false);
  assert.deepEqual(metadata, before);
});

test('待授权邮箱验证通过后合并到已授权记录；授权失败不生成可查询连接', async () => {
  const inventory = { accounts: [{ id: 'a', type: 'claude', email: 'new@example.test' }] };
  const snapshot = { version: 0, data: null };
  const command = { version: 0, action: 'create', provider: 'google', email: 'new@example.test', appPassword: 'synthetic-fixture' };
  await assert.rejects(() => prepareVerifiedMailboxWrite(snapshot, command, async () => { throw Error(); }), /授权验证失败/);
  assert.equal(snapshot.data, null);
  const plan = await prepareVerifiedMailboxWrite(snapshot, command, async () => {});
  const result = withClaudeMailboxCandidates(mailboxPoolMetadata({ version: 1, data: plan }), inventory);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].active, true);
  assert.equal(result.items[0].authorizationPending, undefined);
  assert.equal(result.items[0].source, 'claude');
});

test('HTML 验证码跨标签仍可提取，脚本样式不作为验证码来源', () => {
  assert.equal(extractManagedMailboxCode('<p>Verification code</p><span class="verification-digits">123456</span>'), '123456');
  assert.equal(extractManagedMailboxCode('<script>verification code 999999</script><p>无验证码</p>'), null);
  assert.equal(extractManagedMailboxCode('验证码 654321'), '654321');
});
