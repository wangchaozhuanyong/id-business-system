import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createLocalBusinessStore } from '../server/local-business.mjs';

const alice = { id: 'alice', name: '甲' };
const bob = { id: 'bob', name: '乙' };
const shortcut = { id: 'shortcut-1', name: '工作入口', url: 'https://example.com/private' };
const phrase = {
  id: 'phrase-1',
  title: '客户咨询',
  text: '只属于个人账号的固定话术',
  deleted: false
};
const empty = { version: 0, data: { shortcuts: [], phrases: [] } };

test('toolbox keeps account data private across reopen and records no content in audits', async () => {
  await mkdir(new URL('../.runtime/', import.meta.url), { recursive: true });
  const directory = await mkdtemp(new URL('../.runtime/toolbox-test-', import.meta.url));
  const databasePath = join(directory, 'private.sqlite');
  let store;
  try {
    store = createLocalBusinessStore(databasePath);
    assert.deepEqual(store.loadToolbox(alice), empty);
    const saved = store.saveToolbox({ version: 0, data: { shortcuts: [shortcut], phrases: [phrase] } }, alice);
    store.saveToolbox({ version: 0, data: { shortcuts: [], phrases: [] } });
    assert.deepEqual(store.loadToolbox(bob), empty);
    assert.deepEqual(store.loadToolbox(), { ...empty, version: 1 });
    assert.throws(() => store.load('toolbox:alice'), { status: 404 });
    assert.throws(
      () => store.saveBatch([{ domain: 'toolbox:alice', version: 1, data: empty.data }]),
      { status: 404 }
    );

    store.close();
    store = undefined;
    store = createLocalBusinessStore(databasePath);
    assert.deepEqual(store.loadToolbox(alice), saved);
    assert(Number.isFinite(Date.parse(saved.data.phrases[0].updatedAt)));
    assert.deepEqual(store.loadToolbox(bob), empty);
    assert.equal(store.audit().find((record) => record.actorId === alice.id)?.domain, 'toolbox');
    for (const content of [shortcut.url, phrase.text]) {
      assert.equal((await readFile(databasePath)).includes(Buffer.from(content)), false);
      assert.equal(JSON.stringify(store.audit()).includes(content), false);
    }
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('toolbox writes use one account revision and keep phrase tombstones and order', () => {
  const store = createLocalBusinessStore(':memory:');
  try {
    const second = { ...phrase, id: 'phrase-2' };
    const original = store.saveToolbox(
      {
        version: 0,
        data: { shortcuts: [shortcut], phrases: [phrase, second] }
      },
      alice
    );
    assert.throws(() => store.saveToolbox({ version: 0, data: empty.data }, alice), {
      status: 409
    });
    assert.throws(
      () => store.saveToolbox({ version: 1, data: { shortcuts: [], phrases: [second] } }, alice),
      { status: 400, message: '已保存的话术只能软删除' }
    );
    const phrases = [second, { ...phrase, deleted: true }];
    const saved = store.saveToolbox({ version: 1, data: { shortcuts: [], phrases } }, alice);
    assert.equal(saved.version, 2);
    assert.deepEqual(saved.data.phrases.map(({ updatedAt, ...row }) => row), phrases);
    assert.equal(saved.data.phrases[0].updatedAt, original.data.phrases[1].updatedAt);
    assert.deepEqual(store.loadToolbox(bob), empty);
    assert.equal(store.loadToolbox(alice).data.phrases[1].deleted, true);
  } finally {
    store.close();
  }
});

test('toolbox rejects invalid records and strips untrusted ownership fields', () => {
  const store = createLocalBusinessStore(':memory:');
  const save = (shortcuts, phrases) =>
    store.saveToolbox({ version: 0, data: { shortcuts, phrases } }, alice);
  try {
    for (const url of ['javascript:alert(1)', 'https://alice:password@example.com', '无效网址']) {
      assert.throws(() => save([{ ...shortcut, url }], []), { status: 400 });
    }
    assert.throws(() => save([shortcut, shortcut], []), { status: 400 });
    assert.throws(() => save([], [{ ...phrase, deleted: 'false' }]), { status: 400 });
    assert.throws(() => save([], [{ ...phrase, text: 'x'.repeat(5001) }]), { status: 400 });
    const tooMany = Array.from({ length: 21 }, (_, index) => ({
      ...shortcut,
      id: `shortcut-${index}`
    }));
    assert.throws(() => save(tooMany, []), { status: 400 });
    assert.deepEqual(store.loadToolbox(alice), empty);
    const pendingShortcut = { ...shortcut, url: '' };
    const saved = save([{ ...pendingShortcut, actorId: bob.id }],
      [{ ...phrase, actorId: bob.id, updatedAt: '1900-01-01T00:00:00.000Z' }]);
    const { updatedAt, ...storedPhrase } = saved.data.phrases[0];
    assert(Date.parse(updatedAt) > Date.parse('1900-01-01T00:00:00.000Z'));
    assert.deepEqual({ ...saved, data: { ...saved.data, phrases: [storedPhrase] } },
      { version: 1, data: { shortcuts: [pendingShortcut], phrases: [phrase] } });
    assert.deepEqual(store.loadToolbox(bob), empty);
  } finally {
    store.close();
  }
});
