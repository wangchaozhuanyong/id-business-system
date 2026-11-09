import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createLocalBusinessStore } from '../server/local-business.mjs';
import { openReportSource, projectBusinessReports, reportColumns } from '../server/backup/sheets-source.mjs';
import { createBusinessSheets, createReportSync } from '../server/backup/sheets-sync.mjs';

const workbook = 'fixture_workbook_id';
const folder = 'fixture_report_folder';
const oauth = { clientId: 'fixture', clientSecret: 'fixture', refreshToken: 'fixture' };
const titles = Object.keys(reportColumns);
const reports = () => projectBusinessReports({
  inventory: {
    mailboxes: [{ id: 'mail-1', email: 'mail@example.test', password: 'MAIL_SECRET' }],
    accounts: [{ id: 'account-1', email: 'account@example.test', type: 'claude', proxyPassword: 'PROXY_SECRET' }]
  },
  commerce: {
    customers: [{ id: 'customer-1', name: '=1+1', phone: '00123', notes: 'CUSTOMER_SECRET' }],
    orders: [{ id: 'order-1', customerId: 'customer-1', orderNo: '00123', paidAmount: '12.340',
      paidCurrency: 'PHP', proCardNumber: 'CARD_SECRET', session: 'SESSION_SECRET' }]
  },
  managedMailboxes: [{ id: 'managed-1', email: 'pool@example.test', active: true, queryCode: 'CODE_SECRET' }]
});

test('邮箱报表保留托管微软邮箱并隔离新增微软库存', () => {
  const projected = projectBusinessReports({
    inventory: { mailboxes: [
      { id: 'google-fixture', type: 'google', email: 'google@example.test' },
      { id: 'ms-fixture', type: 'microsoft', email: 'inventory-ms@example.test', password: 'FIXTURE_SECRET' }
    ] },
    managedMailboxes: [{ id: 'pool-fixture', provider: 'microsoft', email: 'pool-ms@example.test', active: true }]
  }).邮箱管理;
  assert.deepEqual(projected.slice(1).map(row => row.slice(0, 4)), [
    ['库存邮箱', 'google-fixture', 'google@example.test', 'Google'],
    ['托管邮箱池', 'pool-fixture', 'pool-ms@example.test', 'Microsoft']
  ]);
});

function fakeGoogle({ shared = false, saved = reports(), rowCount = 1000 } = {}) {
  const calls = [];
  const writes = [];
  const fetchImpl = async (url, init) => {
    const location = new URL(url);
    calls.push({ pathname: location.pathname, method: init.method });
    if (location.hostname === 'oauth2.googleapis.com')
      return Response.json({ access_token: 'fixture', expires_in: 3600 });
    if (location.pathname.startsWith('/drive/')) return Response.json({
      id: workbook, parents: [folder], mimeType: 'application/vnd.google-apps.spreadsheet', ownedByMe: true,
      shared, capabilities: { canEdit: true }
    });
    if (location.pathname.endsWith(':batchUpdate')) {
      writes.push(...JSON.parse(init.body).requests);
      return Response.json({});
    }
    if (location.pathname.endsWith('/values:batchGet')) {
      return Response.json({ spreadsheetId: workbook,
        valueRanges: titles.map(title => ({ values: saved[title] })) });
    }
    return Response.json({ spreadsheetId: workbook, properties: { timeZone: 'Asia/Kuala_Lumpur' },
      sheets: titles.map((title, sheetId) => ({
        properties: { title, sheetId, sheetType: 'GRID',
          gridProperties: { rowCount, columnCount: 26, frozenRowCount: 1 } },
        basicFilter: {
          range: { sheetId, endRowIndex: rowCount, endColumnIndex: reportColumns[title].length },
          filterSpecs: [{ columnIndex: 0, filterCriteria: { hiddenValues: ['fixture-hidden'] } }]
        }
      })) });
  };
  return { target: createBusinessSheets({ workbook, folder, oauth, fetchImpl }), calls, writes };
}

test('private workbook gets only approved columns, literal text, deltas and bounded removals', async () => {
  const data = reports();
  const prior = structuredClone(data);
  prior.客户管理 = [data.客户管理[0], ['previous-customer'], ['deleted-customer']];
  const { target, writes } = fakeGoogle({ saved: prior });
  const result = await target.apply(data);
  assert.equal(result.writes, 1);
  assert.deepEqual(result.rows, { 邮箱管理: 2, 账号管理: 1, 订单管理: 1, 客户管理: 1 });
  assert.doesNotMatch(JSON.stringify(data), /_SECRET/);
  assert.equal(data.订单管理[1][10], '12.340');
  assert.equal(data.订单管理[1][3], '=1+1');
  assert.equal(writes.length, 1);
  const { range, rows } = writes[0].updateCells;
  assert.deepEqual(range, { sheetId: 3, startRowIndex: 1, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: reportColumns.客户管理.length });
  assert.equal(rows[0].values[1].userEnteredValue.stringValue, '=1+1');
  assert.equal(rows[0].values[2].userEnteredValue.stringValue, '00123');
  assert.ok(rows[1].values.every(value => Object.keys(value).length === 0));
});

test('unchanged Sheets data with Google-normalized filters issues no write', async () => {
  const { target, calls, writes } = fakeGoogle();
  assert.equal((await target.apply(reports())).writes, 0);
  assert.equal(writes.length, 0);
  assert.ok(!calls.some(({ pathname }) => pathname.endsWith(':batchUpdate')));
});

test('a sheet that grows extends its filter and preserves existing criteria', async () => {
  const data = reports();
  const { target, writes } = fakeGoogle({ rowCount: 3, saved: structuredClone(data) });
  data.客户管理.push(['customer-2', '新增客户'], ['customer-3', '新增客户']);
  assert.equal((await target.apply(data)).writes, 1);
  const filters = writes.filter(request => request.setBasicFilter);
  assert.equal(filters.length, 1);
  assert.deepEqual(filters[0].setBasicFilter.filter, {
    range: { sheetId: 3, startRowIndex: 0, endRowIndex: 4, startColumnIndex: 0, endColumnIndex: reportColumns.客户管理.length },
    filterSpecs: [{ columnIndex: 0, filterCriteria: { hiddenValues: ['fixture-hidden'] } }]
  });
});

test('shared targets or mismatching headers receive no data', async () => {
  const shared = fakeGoogle({ shared: true });
  await assert.rejects(shared.target.apply(reports()), { message: 'SHEETS_TARGET_NOT_PRIVATE' });
  assert.equal(shared.writes.length, 0);
  assert.equal(shared.calls.length, 2);
  const saved = reports();
  saved.订单管理 = [['手工工作表']];
  const mismatch = fakeGoogle({ saved });
  await assert.rejects(mismatch.target.apply(reports()), { message: 'SHEETS_HEADER_MISMATCH' });
  assert.equal(mismatch.writes.length, 0);
});

test('Google failures do not advance the checkpoint and unrelated commits skip Google', async () => {
  let revision = 1, attempts = 0;
  let data = reports();
  const source = { revision: async () => revision, read: () => data };
  const destination = { apply: async () => {
    if (++attempts === 1) throw new Error('synthetic transport failure');
    return { writes: 1 };
  } };
  const sync = createReportSync({ source, destination });
  await assert.rejects(sync.tick(), /synthetic transport failure/);
  await sync.tick();
  await sync.tick();
  revision++;
  await sync.tick();
  assert.equal(attempts, 2);
  data = structuredClone(data);
  data.客户管理[1][1] = '新名称';
  revision++;
  await sync.tick();
  assert.equal(attempts, 3);
});

test('read-only source observes committed independent SQLite changes',
  { skip: process.env.GITHUB_ACTIONS !== 'true' }, async (t) => {
    const base = fileURLToPath(new URL('../backups', import.meta.url));
    await mkdir(base, { recursive: true, mode: 0o700 });
    const dir = await mkdtemp(join(base, 'sheets-fixture-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const store = createLocalBusinessStore(join(dir, 'local-business.sqlite'));
    const source = await openReportSource(dir);
    try {
      const baseline = await source.revision();
      const commerce = { customers: [{ id: 'fixture-customer', name: '隔离客户' }],
        orders: [], tenants: [], operating: [], rentBatches: [], logs: [] };
      store.saveBatch([{ domain: 'commerce', version: 0, data: commerce }]);
      assert.notEqual(await source.revision(), baseline);
      assert.equal(source.read().客户管理[1][1], '隔离客户');
    } finally { source.close(); store.close(); }
  });
