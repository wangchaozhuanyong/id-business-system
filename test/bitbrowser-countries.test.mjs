import assert from 'node:assert/strict';
import test from 'node:test';
import { bitBrowserCountryOptions, resolveBitBrowserCountry, bitBrowserCountryName } from '../modules/recharge/bitbrowser/countries.mjs';
test('Chinese country names and existing codes resolve to the same executor country', () => {
  for (const [value, code] of [['菲律宾', 'PH'], ['美国', 'US'], ['马来西亚', 'MY'], ['中国', 'CN'], ['英国', 'GB'], ['ph', 'PH'], [' US ', 'US'], ['ＰＨ', 'PH'], ['PH 菲律宾', 'PH'], ['菲律宾 PH', 'PH']]) assert.equal(resolveBitBrowserCountry(value), code);
  assert.equal(bitBrowserCountryName('PH'), '菲律宾');
});
test('every suggested Chinese name and code round trips without ambiguous country mappings', () => {
  assert.equal(bitBrowserCountryOptions.length, 249);
  assert.equal(new Set(bitBrowserCountryOptions.map(item => item.code)).size, 249);
  for (const { code, name } of bitBrowserCountryOptions) {
    assert.match(code, /^[A-Z]{2}$/); assert.equal(resolveBitBrowserCountry(name), code); assert.equal(resolveBitBrowserCountry(code), code);
  }
});
test('regional aliases are recognized, while partial, unknown and injected values remain invalid', () => {
  for (const [name, code] of [['中国香港', 'HK'], ['中国澳门', 'MO'], ['中国台湾', 'TW']]) assert.equal(resolveBitBrowserCountry(name), code);
  for (const value of ['', '菲', '不存在的国家', 'ZZ', 'PH<script>', null, {}]) assert.equal(resolveBitBrowserCountry(value), '');
});
