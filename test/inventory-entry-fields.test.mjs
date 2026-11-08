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
