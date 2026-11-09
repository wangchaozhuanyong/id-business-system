import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createGoogleBackupRequest } from './cloud-drive.mjs';
import { reportColumns } from './sheets-source.mjs';

const drive = 'https://www.googleapis.com/drive/v3/files/';
const sheets = 'https://sheets.googleapis.com/v4/spreadsheets/';
const idPattern = /^[A-Za-z0-9_-]{10,200}$/;
const batchLimit = 1_600_000;
const titles = Object.keys(reportColumns);

function columnName(count) {
  let name = '';
  while (count > 0) {
    count--;
    name = String.fromCharCode(65 + count % 26) + name;
    count = Math.floor(count / 26);
  }
  return name;
}

function cell(value) {
  if (value.length > 50_000) throw new Error('SHEETS_CELL_TOO_LARGE');
  return value ? { userEnteredValue: { stringValue: value } } : {};
}

function updateRanges(sheetId, expected, current, width) {
  const requests = [];
  let start;
  let rows = [];
  let rowBytes = 0;
  function flush(end) {
    if (!rows.length) return;
    requests.push({ updateCells: {
      range: { sheetId, startRowIndex: start, endRowIndex: end, startColumnIndex: 0, endColumnIndex: width },
      rows, fields: 'userEnteredValue'
    } });
    rows = [];
    rowBytes = 0;
  }
  for (let row = 0; row < Math.max(expected.length, current.length); row++) {
    const wanted = expected[row] ?? [];
    const found = current[row] ?? [];
    if (Array.from({ length: width }).every((_, column) => (wanted[column] ?? '') === (found[column] ?? ''))) {
      flush(row);
      continue;
    }
    const update = { values: Array.from({ length: width }, (_, column) => cell(wanted[column] ?? '')) };
    const size = Buffer.byteLength(JSON.stringify(update)) + 1;
    if (rows.length >= 100 || rowBytes + size > batchLimit - 256) flush(row);
    if (!rows.length) start = row;
    rows.push(update);
    rowBytes += size;
  }
  flush(Math.max(expected.length, current.length));
  return requests;
}

function planTab({ properties, basicFilter }, expected, current) {
  const width = expected[0].length;
  const { sheetId, gridProperties: grid } = properties;
  const header = current[0] ?? [];
  if (!header.length || header.some((value, index) => value !== expected[0][index]))
    throw new Error('SHEETS_HEADER_MISMATCH');
  const requests = [];
  const resize = {};
  if (expected.length > grid.rowCount) resize.rowCount = expected.length;
  if (width > grid.columnCount) resize.columnCount = width;
  if (grid.frozenRowCount !== 1) resize.frozenRowCount = 1;
  if (Object.keys(resize).length) requests.push({ updateSheetProperties: {
    properties: { sheetId, gridProperties: resize },
    fields: Object.keys(resize).map(key => 'gridProperties.' + key).join(',')
  } });
  const range = basicFilter?.range;
  const rowCount = resize.rowCount ?? grid.rowCount;
  const columnCount = resize.columnCount ?? grid.columnCount;
  // Sheets can return the grid's explicit end for an unbounded filter.
  if (!range || (range.startRowIndex ?? 0) !== 0 || (range.startColumnIndex ?? 0) !== 0 ||
      (range.endRowIndex ?? rowCount) !== rowCount || (range.endColumnIndex ?? columnCount) !== width)
    requests.push({ setBasicFilter: { filter: { ...basicFilter,
      range: { sheetId, startRowIndex: 0, endRowIndex: rowCount, startColumnIndex: 0, endColumnIndex: width } } } });
  return [...requests, ...updateRanges(sheetId, expected, current, width)];
}

function packRequests(requests) {
  const batches = [];
  let batch = [];
  let size = 16;
  for (const request of requests) {
    const length = Buffer.byteLength(JSON.stringify(request)) + 1;
    if (length + 16 > batchLimit) throw new Error('SHEETS_BATCH_TOO_LARGE');
    if (size + length > batchLimit) {
      batches.push(batch);
      batch = [];
      size = 16;
    }
    batch.push(request);
    size += length;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export function createBusinessSheets({ workbook, folder, oauth, fetchImpl = fetch, pause = delay }) {
  if (![workbook, folder].every(id => typeof id === 'string' && idPattern.test(id)) || workbook === folder)
    throw new Error('SHEETS_TARGET_INVALID');
  const request = createGoogleBackupRequest({ oauth, fetchImpl });
  const base = sheets + workbook;

  async function verifyTarget() {
    const file = await (await request(drive + workbook +
      '?fields=id,mimeType,parents,shared,ownedByMe,trashed,capabilities(canEdit)')).json();
    if (file.id !== workbook || file.mimeType !== 'application/vnd.google-apps.spreadsheet' ||
        file.trashed || file.ownedByMe !== true || file.shared !== false ||
        file.capabilities?.canEdit !== true || file.parents?.length !== 1 || file.parents[0] !== folder)
      throw new Error('SHEETS_TARGET_NOT_PRIVATE');
  }

  async function apply(reports) {
    await verifyTarget();
    const result = await (await request(base +
      '?fields=spreadsheetId,properties(timeZone),sheets(properties(sheetId,title,sheetType,gridProperties),basicFilter)')).json();
    if (result.spreadsheetId !== workbook) throw new Error('SHEETS_TARGET_INVALID');
    const tabs = new Map((result.sheets ?? []).map(tab => [tab.properties.title, tab]));
    const params = new URLSearchParams({ valueRenderOption: 'FORMULA' });
    for (const title of titles) {
      const tab = tabs.get(title);
      if (tab?.properties?.sheetType !== 'GRID' || !tab.properties.gridProperties)
        throw new Error('SHEETS_TAB_MISSING');
      const width = Math.min(tab.properties.gridProperties.columnCount, reportColumns[title].length);
      params.append('ranges', `'${title}'!A1:${columnName(width)}`);
    }
    const values = await (await request(base + '/values:batchGet?' + params)).json();
    if (values.spreadsheetId !== workbook || values.valueRanges?.length !== titles.length)
      throw new Error('SHEETS_RESPONSE_INVALID');
    const requests = titles.flatMap((title, index) =>
      planTab(tabs.get(title), reports[title], values.valueRanges[index].values ?? []));
    if (result.properties?.timeZone !== 'Asia/Kuala_Lumpur') requests.unshift({
      updateSpreadsheetProperties: { properties: { timeZone: 'Asia/Kuala_Lumpur' }, fields: 'timeZone' }
    });
    const batches = packRequests(requests);
    for (const [index, batch] of batches.entries()) {
      if (index > 0) {
        await pause(1_100);
        await verifyTarget();
      }
      const response = await request(base + ':batchUpdate', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requests: batch })
      });
      await response.body?.cancel();
    }
    return { writes: batches.length, rows: Object.fromEntries(titles.map(title => [title, reports[title].length - 1])) };
  }
  return { apply };
}

export function createReportSync({ source, destination, now = Date.now, minInterval = 0 }) {
  let checkedRevision;
  let confirmedDigest;
  let confirmedAt;
  let nextApplyAt = -Infinity;
  return {
    async tick() {
      const revision = await source.revision();
      const reconcile = confirmedAt === undefined || now() - confirmedAt >= 300_000;
      if (revision === checkedRevision && !reconcile) return;
      const reports = source.read();
      const digest = createHash('sha256').update(JSON.stringify(reports)).digest('hex');
      if (digest === confirmedDigest && !reconcile) {
        checkedRevision = revision;
        return;
      }
      if (now() < nextApplyAt) return;
      nextApplyAt = now() + minInterval;
      const result = await destination.apply(reports);
      checkedRevision = revision;
      confirmedDigest = digest;
      confirmedAt = now();
      return result;
    }
  };
}
