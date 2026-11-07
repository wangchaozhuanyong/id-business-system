import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalBusinessStore } from '../server/local-business.mjs';
test('IP library is per operator, versioned, encrypted by the existing store and audited without credentials', () => {
  const store = createLocalBusinessStore(':memory:');
  const alice = { id: 'alice', name: '甲' }, bob = { id: 'bob', name: '乙' };
  try {
    const saved = store.saveBitBrowserProxy({ version: 0, name: '合成 IP', countryCode: 'MY', kind: 'static_residential', mode: 'static', protocol: 'http', link: 'http://user:synthetic-password@192.0.2.5:8080' }, alice);
    assert.equal(saved.version, 1); assert.equal(saved.items[0].countryCode, 'MY');
    assert.deepEqual(store.loadBitBrowserProxies(bob), { version: 0, items: [] });
    assert.throws(() => store.useBitBrowserProxy({ id: saved.savedId, version: 0 }, bob), { status: 404 });
    assert.throws(() => store.useBitBrowserProxy({ id: saved.savedId, version: 0 }, alice), { status: 409 });
    assert.match(store.useBitBrowserProxy({ id: saved.savedId, version: 1 }, alice).link, /synthetic-password/);
    assert(!JSON.stringify(store.loadBitBrowserProxies(alice)).includes('synthetic-password'));
    assert(!JSON.stringify(store.audit()).includes('synthetic-password'));
    assert.throws(() => store.load('bitbrowser-proxies:alice'), { status: 404 });
    const changes = { id: saved.savedId, version: 1, name: '改名后的 IP', countryCode: 'PH', kind: 'mobile', mode: 'static', protocol: 'http', link: '' };
    const edited = store.saveBitBrowserProxy(changes, alice);
    assert.equal(edited.version, 2); assert.equal(edited.items.length, 1); assert.equal(edited.savedId, saved.savedId);
    assert.equal(edited.items[0].name, changes.name);
    assert.match(store.useBitBrowserProxy({ id: saved.savedId, version: 2 }, alice).link, /synthetic-password/);
    assert.throws(() => store.saveBitBrowserProxy(changes, alice), { status: 409 });
    assert.throws(() => store.saveBitBrowserProxy({ ...changes, version: 0 }, bob), { status: 404 });
    assert(store.audit().some(entry => entry.action === 'bitbrowser_proxy_update'));
    assert(!JSON.stringify(store.audit()).includes('synthetic-password'));
  } finally { store.close(); }
});
