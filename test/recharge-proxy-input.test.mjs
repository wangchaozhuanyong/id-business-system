import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeRechargeProxyInput } from '../modules/recharge/codexdaichong/proxy-input.mjs';

const host = 'gate.example.test:8082';
const user = 'example-res-country-ph-session-12345678';
const raw = `${host}:${user}:example-pass`;
const canonical = `socks5://${user}:example-pass@${host}`;

test('带协议四段、裸四段、账号在前和标准地址统一规范化，保留地区与固定会话', () => {
  for (const value of [`Socks5://${raw}`, raw, `${user}:example-pass@${host}`, canonical]) {
    assert.deepEqual(normalizeRechargeProxyInput(value).proxies, [canonical]);
  }
  assert.equal(normalizeRechargeProxyInput(`HTTP://${raw}`).proxies[0], `http://${user}:example-pass@${host}`);
  assert.equal(normalizeRechargeProxyInput('https://user:pass@gate.example.test:443/').proxies[0], 'https://user:pass@gate.example.test:443');
});

test('特殊字符密码、IPv6 和会话占位符保留准确，不重复编码', () => {
  const value = normalizeRechargeProxyInput('socks5://[2001:db8::1]:1080:example-session-{session}:p@ss:word#% /').proxies[0];
  assert.equal(value, 'socks5://example-session-{session}:p%40ss%3Aword%23%25%20%2F@[2001:db8::1]:1080');
  const url = new URL(value);
  assert.equal(decodeURIComponent(url.password), 'p@ss:word#% /');
  assert.equal(normalizeRechargeProxyInput(value).proxies[0], value);
  assert.equal(normalizeRechargeProxyInput('socks5://gate.example.test:1080').proxies[0], 'socks5://gate.example.test:1080');
});

test('批量忽略空行且规范后去重；错误整批拒绝并只显示行号', () => {
  const batch = normalizeRechargeProxyInput(`\n${raw}\n\n${canonical}\nhttp://host.example.test:80`);
  assert.equal(batch.proxies.length, 2);
  assert.equal(batch.duplicates, 1);
  assert.equal(batch.converted, 1);
  const secret = 'synthetic-not-for-errors';
  assert.throws(() => normalizeRechargeProxyInput([raw, `https://api.example.test/extract?id=${secret}`]), error =>
    /第 2 行/.test(error.message) && /整批未保存/.test(error.message) && !error.message.includes(secret));
});

test('无效端口、缺失凭据、路径、控制字符、协议与超量导入均拒绝', () => {
  for (const value of ['', {}, ['not-a-proxy'], 'host.example.test:0:user:pass',
    'host.example.test:65536:user:pass', 'socks5://user:@host.example.test:1080',
    'socks5://user:pass@host.example.test:1080/path', 'socks4://host.example.test:1080',
    'socks5://user:pa%0Ass@host.example.test:1080', 'host.example.test:1080:user:pass\u0000',
    Array(501).fill(raw), 'x'.repeat(512 * 1024 + 1)]) {
    assert.throws(() => normalizeRechargeProxyInput(value));
  }
});
