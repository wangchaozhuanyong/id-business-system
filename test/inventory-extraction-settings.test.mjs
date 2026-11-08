import assert from 'node:assert/strict';
import test from 'node:test';
import { validMailExtractionSettings } from '../server/inventory-extraction-settings.mjs';

const config = purposes => [['mail-extraction', { purposes }]];
test('邮箱提取用途兼容原库存配置，独立于国家、来源和账号设置', () => {
  assert(validMailExtractionSettings([]));
  const existing = [['google', { countries: ['美国'], sources: ['自己注册'] }]];
  assert(validMailExtractionSettings(existing));
  assert(validMailExtractionSettings([...existing, ...config(['注册 Claude', '客户指定用途', '其他'])]));
  assert.deepEqual(existing, [['google', { countries: ['美国'], sources: ['自己注册'] }]]);
});

test('服务端拒绝空、重复、越界及格式异常用途，防止绕过选项编辑器', () => {
  for (const purposes of [[], null, {}, [''], [' 用途'], ['用途 '], ['用途\n说明'], ['用途\u0000说明'], [123], ['API', 'api'], ['长'.repeat(101)], Array.from({ length: 101 }, (_, i) => String(i))])
    assert.equal(validMailExtractionSettings(config(purposes)), false);
  assert.equal(validMailExtractionSettings([...config(['用途']), ...config(['其他'])]), false);
  assert.equal(validMailExtractionSettings([['mail-extraction', { purposes: ['用途'], extra: true }]]), false);
  assert.equal(validMailExtractionSettings(null), false);
  assert(validMailExtractionSettings(config(['长'.repeat(100)])));
});
