import assert from 'node:assert/strict';
import test from 'node:test';
import { checkAccountLocations } from '../server/inventory-account-location.mjs';

const gpt = { id: 'gpt-1', type: 'gpt', email: 'gpt@example.test', country: '美国', city: '纽约' };
const claude = { ...gpt, id: 'claude-1', type: 'claude', email: 'claude@example.test' };
const document = (accounts, tableSettings = []) => ({ accounts, tableSettings });

test('GPT requires an enabled country; Claude also requires a city belonging to it', () => {
  for (const row of [gpt, claude]) {
    assert.equal(checkAccountLocations(null, document([row])), undefined);
    assert.match(checkAccountLocations(null, document([{ ...row, country: '' }])), /注册国家/);
  }
  assert.equal(checkAccountLocations(null, document([{ ...gpt, city: undefined }])), undefined);
  assert.match(checkAccountLocations(null, document([{ ...gpt, country: '未启用国家' }])), /注册国家/);
  assert.match(checkAccountLocations(null, document([{ ...claude, city: '' }])), /地区／城市/);
  assert.match(checkAccountLocations(null, document([{ ...claude, city: '东京' }])), /地区／城市/);
  assert.equal(checkAccountLocations(null, document([{ type: 'apple' }])), undefined);
});

test('account location settings are independent and removal preserves existing records', () => {
  const settings = [
    ['gpt', { countries: ['日本'], cities: [['美国', ['纽约']]] }],
    ['claude', { countries: ['日本'], cities: [['日本', ['东京']]] }]
  ];
  assert.equal(checkAccountLocations(null, document([
    { ...gpt, country: '日本' },
    { ...claude, country: '日本', city: '东京' }
  ], settings)), undefined);
  assert.match(checkAccountLocations(null, document([
    { ...claude, country: '日本', city: '札幌' }
  ], settings)), /Claude/);
  assert.equal(checkAccountLocations(document([gpt, claude]), document([gpt, claude], settings)), undefined);
});

test('legacy GPT records can change country without filling in or overwriting a city', () => {
  const old = { ...gpt, city: undefined };
  assert.equal(checkAccountLocations(document([old]), document([{ ...old, notes: '补记' }])), undefined);
  assert.equal(checkAccountLocations(document([old]), document([{ ...old, country: '日本' }])), undefined);
  assert.equal(checkAccountLocations(document([gpt]), document([{ ...gpt, country: '日本' }])), undefined);
});
