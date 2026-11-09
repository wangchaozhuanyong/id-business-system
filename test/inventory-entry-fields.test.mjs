import assert from 'node:assert/strict';
import test from 'node:test';
import { checkInventoryEntryFields as check } from '../server/inventory-entry-fields.mjs';
const inventory = row => ({ mailboxes: [row], accounts: [] });
test('谷歌与 Claude 新增、编辑和导入均强制同一必填规则', () => {
  for (const action of ['inventory_create', 'inventory_edit', 'inventory_import']) {
    assert.match(check(null, inventory({ type: 'google' }), action), /国家地区和登录设备/);
    assert.equal(check(null, inventory({ type: 'google', country: '马来西亚', device: '设备 1' }), action), undefined);
    assert.match(check(null, inventory({ type: 'claude', device: '设备' }), action), /注册代理链接/);
    assert.equal(check(null, inventory({ type: 'claude', device: '设备', proxyUrl: 'socks5://127.0.0.1:1080' }), action), undefined);
  }
});
test('历史未变资料允许保留；伪造相同版本不能绕过新增字段校验，提取归还不强补历史', () => {
  const old = inventory({ id: 'old', type: 'google', version: 1 });
  assert.equal(check(old, structuredClone(old), 'inventory_edit'), undefined);
  const changed = structuredClone(old); changed.mailboxes[0].device = '新增设备';
  assert.match(check(old, changed, 'inventory_edit'), /必填/);
  for (const action of ['inventory_extract', 'inventory_return']) assert.equal(check(old, changed, action), undefined);
});
test('绑定电话可填普通号码或 HTTPS 验证码链接，脚本和含基础认证的链接拒绝', () => {
  for (const phone of ['0123456789', 'https://sms.example.test/code?token=synthetic'])
    assert.equal(check(null, inventory({ type: 'apple', phone }), 'inventory_create'), undefined);
  for (const phone of ['javascript:alert(1)', 'https://name:secret@example.test', 'https:%%%'])
    assert.match(check(null, inventory({ type: 'apple', phone }), 'inventory_create'), /链接/);
});

test('历史资料只补齐运行元数据时不强补业务字段；新建及真实编辑仍校验', () => {
  const old = inventory({ id: 'legacy', type: 'google' });
  const normalized = inventory({ ...old.mailboxes[0], version: 1, health: 'normal', status: '正常', usageLinks: [], inventoryHistory: [] });
  assert.equal(check(old, normalized, 'inventory_create'), undefined);
  normalized.mailboxes[0].notes = '修改业务内容';
  assert.match(check(old, normalized, 'inventory_edit'), /必填/);
  assert.match(check(null, inventory({ type: 'google', country: {}, device: [] }), 'inventory_create'), /必填/);
  assert.match(check(null, inventory({ type: 'claude', device: '设备', proxyUrl: 'not-a-proxy' }), 'inventory_import'), /格式/);
});

const microsoft = (changes = {}) => ({
  id: 'ms-fixture', type: 'microsoft', email: 'ms@example.test', password: 'fixture-only',
  source: '自己注册', status: '正常', ...changes,
  microsoftSecurity: { loginMode: 'password', recoveryAccess: 'unknown', twoStep: 'unknown',
    verificationMethods: [], verificationDevice: '', ...changes.microsoftSecurity }
});
test('微软邮箱密码与无密码模式均可保存，手机号可留空', () => {
  for (const action of ['inventory_create', 'inventory_edit', 'inventory_import']) {
    assert.equal(check(null, inventory(microsoft()), action), undefined);
    assert.match(check(null, inventory(microsoft({ password: '' })), action), /必须填写登录密码/);
    const security = { loginMode: 'passwordless', verificationMethods: ['authenticator', 'passkey'] };
    assert.equal(check(null, inventory(microsoft({ password: '', microsoftSecurity: security })), action), undefined);
    assert.match(check(null, inventory(microsoft({ microsoftSecurity: security })), action), /清空登录密码/);
    assert.match(check(null, inventory(microsoft({ password: '', microsoftSecurity: { loginMode: 'passwordless' } })), action), /选择实际使用/);
    assert.match(check(null, inventory(microsoft({ totp: 'FIXTURE' })), action), /动态验证码/);
    assert.match(check(null, inventory(microsoft({ phone: 'javascript:alert(1)' })), action), /链接/);
  }
});
test('微软邮箱关联按同一地址与稳定编号校验，重复或自关联拒绝', () => {
  const recovery = { id: 'recovery', type: 'google', email: 'recover@example.test', device: '设备', country: '马来西亚' };
  const linked = microsoft({ auxiliary: 'recover@example.test',
    microsoftSecurity: { recoveryAccess: 'inventory', recoveryMailboxId: 'recovery', verificationMethods: ['email'] } });
  const document = { mailboxes: [linked, recovery], accounts: [] };
  assert.equal(check(inventory(recovery), document, 'inventory_create'), undefined);
  assert.match(check(null, inventory(linked), 'inventory_create'), /唯一对应/);
  assert.match(check(null, inventory({ ...linked, auxiliary: linked.email }), 'inventory_create'), /不同于当前账号/);
  const sameAddress = microsoft({ id: 'duplicate', email: 'MS@example.test' });
  assert.match(check(document, { ...document, mailboxes: [...document.mailboxes, sameAddress] }, 'inventory_import'), /重复/);
  assert.match(check(document, { ...document, mailboxes: [{ ...linked, email: 'changed@example.test' }, recovery] }, 'inventory_edit'), /不可修改/);
});
test('微软邮箱库存录入不创建领用状态，也不进入账号库存', () => {
  const before = inventory(microsoft());
  assert.match(check(before, inventory(microsoft({ inventoryState: 'claimed', claimId: 'claim' })), 'inventory_extract'), /暂未接入/);
  assert.match(check(null, { mailboxes: [], accounts: [microsoft()] }, 'inventory_create'), /微软邮箱库存/);
  const historic = inventory({ id: 'ms-old', type: 'microsoft', email: 'OLD@example.test' });
  assert.equal(check(historic, structuredClone(historic), 'inventory_edit'), undefined);
  assert.equal(check(historic, inventory({ ...historic.mailboxes[0], health: 'dead' }), 'inventory_health_change'), undefined);
});
