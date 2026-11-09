import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
test('the real host bridge retains proxy metadata while rejecting all proxy and authorization secrets', async () => {
  const source = await readFile(new URL('../frontend/operations-prototype.js', import.meta.url), 'utf8');
  const window = {}, state = { drafts: new Map() };
  runInNewContext(source.slice(source.indexOf('  const frameDraftScopes ='), source.indexOf('  const rowsByQuery =')), { window, state });
  window.IDRechargeDrafts.write('bit-local', { 'ip-draft/new/name': '住宅代理', 'ip-draft/new/country': '菲律宾', 'ip-draft/new/version': '2', 'ip-page': '3', 'ip-page-size': '20', 'ip-draft/new/link': 'synthetic-secret', 'bit-local-token': 'synthetic-secret', authorizationJson: 'synthetic-secret', 'bit-execution-proxy': 'fixture-id' });
  const draft = window.IDRechargeDrafts.read('bit-local');
  assert.equal(draft['ip-draft/new/name'], '住宅代理'); assert.equal(draft['ip-draft/new/country'], '菲律宾'); assert.equal(draft['ip-page'], '3');
  assert.equal(draft['ip-page-size'], '20');
  assert(!JSON.stringify(draft).includes('synthetic-secret'));
});
