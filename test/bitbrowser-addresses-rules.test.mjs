import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deleteUsedBitBrowserAddresses,
  listBitBrowserAddresses,
  updateBitBrowserAddress
} from '../server/bitbrowser-addresses.mjs';

const createdAt = '2026-11-01T00:00:00.000Z';
const usedAt = '2026-11-09T08:00:00.000Z';

function address(number, status) {
  return Object.freeze({
    id: `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`,
    line1: `${number} Fixture Street`,
    status,
    usedAt: status === 'used' ? usedAt : null,
    createdAt
  });
}

test('historical disabled addresses are listed and counted as unused without rewriting the source', () => {
  const legacy = address(1, 'disabled');
  const unused = address(2, 'unused');
  const used = address(3, 'used');
  const rows = Object.freeze([legacy, unused, used]);
  const visible = { ...legacy, status: 'unused' };
  const list = (query) => listBitBrowserAddresses(rows, new URLSearchParams(query));

  assert.deepEqual(list('status=unused'), {
    items: [unused, visible],
    total: 2,
    totals: { unused: 2, used: 1, disabled: 0 },
    page: 1,
    pageSize: 20
  });
  assert.deepEqual(list().items, [used, unused, visible]);
  assert.deepEqual(list('status=used').items, [used]);
  assert.deepEqual(list('status=unused&keyword=1+fixture').items, [visible]);
  assert.deepEqual(list('status=unused&keyword=1+fixture').totals, { unused: 2, used: 1, disabled: 0 });
  assert.throws(() => list('status=disabled'), { status: 400 });
  assert.equal(rows[0].status, 'disabled');
});

test('marking a legacy or unused address succeeds and a retry returns the original receipt', () => {
  for (const status of ['disabled', 'unused']) {
    const original = address(1, status);
    const rows = Object.freeze([original]);
    const input = { id: original.id, status: 'used', expectedStatus: 'unused' };
    const updated = updateBitBrowserAddress(rows, input, usedAt);
    assert.deepEqual(updated.result, { ...original, status: 'used', usedAt });
    assert.deepEqual(updated.rows, [updated.result]);
    assert.equal(rows[0].status, status);

    const retry = updateBitBrowserAddress(updated.rows, input, '2026-11-09T08:01:00.000Z');
    assert.equal(retry.rows, updated.rows);
    assert.equal(retry.result, updated.result);
    assert.throws(() => updateBitBrowserAddress(updated.rows, { ...input, status: 'disabled' }, usedAt), {
      status: 400
    });
    assert.throws(() => updateBitBrowserAddress(updated.rows, { ...input, expectedStatus: 'disabled' }, usedAt), {
      status: 400
    });
    assert.throws(() => updateBitBrowserAddress(rows, { ...input, id: address(2, 'unused').id }, usedAt), {
      status: 404
    });
  }
});

test('used addresses sort by recent use while the combined view keeps creation order', () => {
  const lastUsed = { ...address(1, 'used'), usedAt: '2026-11-09T09:00:00.000Z' };
  const recent = { ...address(2, 'used'), createdAt: '2026-11-05T00:00:00.000Z' };
  const sameUse = { ...address(3, 'used'), createdAt: '2026-11-04T00:00:00.000Z' };
  const sameCreation = { ...sameUse, id: address(4, 'used').id };
  const legacy = { ...address(5, 'used'), usedAt: null, createdAt: '2026-11-08T00:00:00.000Z' };
  const rows = [lastUsed, recent, sameUse, sameCreation, legacy];

  assert.deepEqual(listBitBrowserAddresses(rows, new URLSearchParams('status=used')).items,
    [lastUsed, recent, sameCreation, sameUse, legacy]);
  assert.deepEqual(listBitBrowserAddresses(rows, new URLSearchParams()).items,
    [legacy, recent, sameCreation, sameUse, lastUsed]);
});

test('deletion uses the reviewed version and covers all used pages while retaining other statuses', () => {
  const used = Array.from({ length: 42 }, (_, index) => address(index + 1, 'used'));
  const retained = [address(43, 'unused'), address(44, 'disabled')];
  const rows = Object.freeze([...used, ...retained]);
  const list = (page) => listBitBrowserAddresses(rows, new URLSearchParams(`status=used&page=${page}`));
  assert.equal(list(1).items.length, 20);
  assert.equal(list(2).items.length, 20);
  assert.equal(list(3).items.length, 2);
  assert.equal(list(1).total, 42);

  const input = { deleteUsed: true, version: 7 };
  assert.throws(() => deleteUsedBitBrowserAddresses(rows, input, 8), { status: 409 });
  assert.throws(() => deleteUsedBitBrowserAddresses(rows, { ...input, deleteUsed: false }, 7), { status: 400 });
  assert.throws(() => deleteUsedBitBrowserAddresses(rows, { ...input, version: '7' }, 7), { status: 400 });
  assert.equal(list(1).total, 42);
  assert.deepEqual(deleteUsedBitBrowserAddresses(rows, input, 7), {
    rows: retained,
    result: { deleted: 42 }
  });
  const noUsed = deleteUsedBitBrowserAddresses(retained, input, 7);
  assert.deepEqual(noUsed.result, { deleted: 0 });
  assert.equal(noUsed.rows, retained);
});
