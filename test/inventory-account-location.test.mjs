import assert from 'node:assert/strict';
import test from 'node:test';
import { checkAccountLocations } from '../server/inventory-account-location.mjs';

const gpt = { id: 'gpt-1', type: 'gpt', email: 'gpt@example.test', country: '美国', city: '纽约' };
const claude = { ...gpt, id: 'claude-1', type: 'claude', email: 'claude@example.test' };
const document = (accounts, tableSettings = []) => ({ accounts, tableSettings });

test('new accounts require both an enabled country and a region belonging to it', () => {
  for (const row of [gpt, claude]) {
    assert.equal(checkAccountLocations(null, document([row])), undefined);
    assert.match(checkAccountLocations(null, document([{ ...row, country: '' }])), /注册国家/);
    assert.match(checkAccountLocations(null, document([{ ...row, city: '' }])), /地区／城市/);
    assert.match(checkAccountLocations(null, document([{ ...row, city: '东京' }])), /地区／城市/);
  }
  assert.equal(checkAccountLocations(null, document([{ type: 'apple' }])), undefined);
});

test('account location settings are independent and removal preserves existing records', () => {
  const settings = [
    ['gpt', { countries: ['日本'], cities: [['日本', ['札幌']]] }],
    ['claude', { countries: ['日本'], cities: [['日本', ['东京']]] }]
  ];
  assert.equal(checkAccountLocations(null, document([
    { ...gpt, country: '日本', city: '札幌' },
    { ...claude, country: '日本', city: '东京' }
  ], settings)), undefined);
  assert.match(checkAccountLocations(null, document([
    { ...claude, country: '日本', city: '札幌' }
  ], settings)), /Claude/);
  assert.equal(checkAccountLocations(document([gpt, claude]), document([gpt, claude], settings)), undefined);
});

test('legacy records remain editable without inventing a location, but changed locations must be complete', () => {
  const old = { ...gpt, city: undefined };
  assert.equal(checkAccountLocations(document([old]), document([{ ...old, notes: '补记' }])), undefined);
  assert.match(checkAccountLocations(document([old]), document([{ ...old, country: '日本' }])), /地区／城市/);
  assert.equal(checkAccountLocations(document([old]), document([gpt])), undefined);
});
