import assert from 'node:assert/strict';
import test from 'node:test';

import { sortByFundingDeadline, sortByRecordTime } from './list-order.mjs';

test('按真实时点排序，回退历史字段，同时间稳定且不改写来源', () => {
  const rows = [
    { id: 'row-1', at: '' },
    { id: 'row-2', at: '2026-11-10 09:00' },
    { id: 'row-10', at: '2026-11-10T01:00:00Z' },
    { id: 'row-3', at: '历史未记录', fallback: '2026-11-11' }
  ];
  const time = row => [row.at, row.fallback];
  assert.deepEqual(sortByRecordTime(rows, time).map(row => row.id), ['row-3', 'row-10', 'row-2', 'row-1']);
  assert.deepEqual(sortByRecordTime(rows, time, 'asc').map(row => row.id), ['row-10', 'row-2', 'row-3', 'row-1']);
  assert.deepEqual(rows.map(row => row.id), ['row-1', 'row-2', 'row-10', 'row-3']);
});

test('备款列表先按未到期的期限升序，再按其余到期时间倒序', () => {
  const rows = [
    { id: 'old', expiry: 100 },
    { id: 'later', expiry: 400, active: true },
    { id: 'unknown' },
    { id: 'soon', expiry: 300, active: true },
    { id: 'recent', expiry: 200 }
  ];
  assert.deepEqual(sortByFundingDeadline(rows, row => row.expiry, row => row.active).map(row => row.id),
    ['soon', 'later', 'recent', 'old', 'unknown']);
});
