import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

const source = await readFile(new URL('../frontend/pagination.js', import.meta.url), 'utf8');
const window = {};
runInNewContext(source, { window, document: { addEventListener() {} } });
const { render } = window.IDPagination;
const numbers = (markup) => [...markup.matchAll(/data-pagination-page="(\d+)" data-page=/g)]
  .map(([, value]) => Number(value));

test('long lists render only nearby page numbers and the first and last pages', () => {
  const first = render({ id: 'list', total: 1000 });
  assert.deepEqual(numbers(first), [1, 2, 3, 4, 5, 6, 50]);
  assert.match(first, /共 1,000 条 · 第 1–20 条/);
  assert.match(first, /<option value="20" selected>20条\/页<\/option>/);
  assert.match(first, /上一页" disabled/);
  assert.match(first, /当前第 1 \/ 50 页/);

  const middle = render({ id: 'list', total: 10000, page: 254 });
  assert.deepEqual(numbers(middle), [1, 252, 253, 254, 255, 256, 500]);
  assert.equal([...middle.matchAll(/class="pagination-ellipsis"/g)].length, 2);
  assert.match(middle, /data-page="254" aria-current="page"/);
  assert.match(middle, /共 10,000 条 · 第 5,061–5,080 条/);
});

test('pagination clamps a shortened result and gives empty and single pages no navigation', () => {
  const last = render({ id: 'list', total: 111, page: 20, pageSize: 50 });
  assert.match(last, /data-page="3" data-page-size="50"/);
  assert.match(last, /第 101–111 条/);
  assert.match(last, /下一页" disabled/);

  for (const total of [0, 1, 20]) {
    const html = render({ id: 'list', total });
    assert.match(html, /data-pagination-size/);
    assert.doesNotMatch(html, /data-pagination-page=|data-pagination-target/);
  }
});
