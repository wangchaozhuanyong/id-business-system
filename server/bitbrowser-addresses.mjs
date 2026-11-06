import { randomInt, randomUUID } from 'node:crypto';

export const bitBrowserAddressDomain = 'bitbrowser-addresses';
const location = Object.freeze({
  country: 'US',
  city: 'Portland',
  state: 'OR',
  postalCode: '97204'
});
const streetPattern = /^[A-Za-z0-9][A-Za-z0-9 .,'#/-]{1,179}$/;
const uuidPattern = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const statuses = ['unused', 'used', 'disabled'];
const generatedLocations = [
  ['Portland', 'Oregon', ['97201', '97205', '97209', '97214']],
  ['Salem', 'Oregon', ['97301', '97302', '97306']],
  ['Eugene', 'Oregon', ['97401', '97402', '97404']],
  ['Wilmington', 'Delaware', ['19801', '19802', '19805']],
  ['Dover', 'Delaware', ['19901', '19904']],
  ['Billings', 'Montana', ['59101', '59102', '59105']],
  ['Missoula', 'Montana', ['59801', '59802']],
  ['Manchester', 'New Hampshire', ['03101', '03102', '03104']],
  ['Nashua', 'New Hampshire', ['03060', '03062']],
  ['Anchorage', 'Alaska', ['99501', '99503', '99508']],
  ['Fairbanks', 'Alaska', ['99701', '99709']]
];
const generatedStreets = [
  'Main St',
  'Oak Ave',
  'Maple Dr',
  'Cedar Ln',
  'Park Blvd',
  'Washington St',
  'Lake View Rd',
  'Highland Ave',
  'Pine St',
  'Elm St'
];
export const isBitBrowserAddressId = (id) => typeof id === 'string' && uuidPattern.test(id);

export class BitBrowserAddressError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const streetKey = (value) => value.toLocaleLowerCase('en-US');

export function generateBitBrowserAddresses(rows, count, now) {
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    throw new BitBrowserAddressError(400, '每次可生成 1 至 100 条地址');
  }
  const known = new Set(rows.map(({ line1 }) => streetKey(line1)));
  const items = [];
  for (let round = 0; round < 3 && items.length < count; round++) {
    const missing = count - items.length;
    for (let index = 0; index < missing; index++) {
      const [city, state, postalCodes] = generatedLocations[randomInt(generatedLocations.length)];
      const line1 = `${randomInt(100, 9000)} ${generatedStreets[randomInt(generatedStreets.length)]}`;
      const key = streetKey(line1);
      if (known.has(key)) continue;
      known.add(key);
      items.push({
        id: randomUUID(),
        country: 'US',
        line1,
        city,
        state,
        postalCode: postalCodes[randomInt(postalCodes.length)],
        status: 'unused',
        usedAt: null,
        createdAt: now
      });
    }
  }
  if (items.length !== count) {
    throw new BitBrowserAddressError(409, '本次生成的街道重复，请重新生成');
  }
  return { rows: [...rows, ...items], result: { count: items.length, items } };
}

export function listBitBrowserAddresses(rows, search) {
  const page = Number(search.get('page') || 1);
  const pageSize = Number(search.get('pageSize') || 20);
  const keyword = search.get('keyword')?.trim() || '';
  const status = search.get('status') ?? 'all';
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 100_000 ||
    ![20, 50, 100, 2000].includes(pageSize) ||
    keyword.length > 80 ||
    (status !== 'all' && !statuses.includes(status))
  ) {
    throw new BitBrowserAddressError(400, '地址查询条件无效');
  }
  const totals = { unused: 0, used: 0, disabled: 0 };
  const matches = [];
  const query = streetKey(keyword);
  for (const row of rows) {
    totals[row.status]++;
    if ((status === 'all' || row.status === status) && streetKey(row.line1).includes(query)) {
      matches.push(row);
    }
  }
  matches.sort(
    (left, right) =>
      right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
  );
  const offset = (page - 1) * pageSize;
  return {
    items: matches.slice(offset, offset + pageSize),
    total: matches.length,
    totals,
    page,
    pageSize
  };
}

export function importBitBrowserAddresses(rows, streets, now) {
  if (!Array.isArray(streets) || streets.length < 1 || streets.length > 2000) {
    throw new BitBrowserAddressError(400, '每次需要导入 1 至 2000 条街道地址');
  }
  const known = new Set(rows.map((row) => streetKey(row.line1)));
  const added = [];
  const result = { imported: 0, duplicated: 0, rejected: 0 };
  for (const raw of streets) {
    const line1 =
      typeof raw === 'string' && !/[\r\n]/.test(raw) ? raw.trim().replace(/\s+/g, ' ') : '';
    if (!streetPattern.test(line1)) {
      result.rejected++;
      continue;
    }
    const key = streetKey(line1);
    if (known.has(key)) {
      result.duplicated++;
      continue;
    }
    known.add(key);
    added.push({
      id: randomUUID(),
      line1,
      ...location,
      status: 'unused',
      usedAt: null,
      createdAt: now
    });
  }
  if (result.rejected === streets.length) {
    throw new BitBrowserAddressError(400, '文件中没有可导入的街道地址');
  }
  result.imported = added.length;
  return { rows: result.imported ? [...rows, ...added] : rows, result };
}

export function updateBitBrowserAddress(rows, { id, status, expectedStatus }, now) {
  if (!isBitBrowserAddressId(id)) {
    throw new BitBrowserAddressError(400, '地址编号无效');
  }
  if (!statuses.includes(status) || !statuses.includes(expectedStatus)) {
    throw new BitBrowserAddressError(400, '地址状态无效');
  }
  const index = rows.findIndex((row) => row.id === id);
  if (index < 0) throw new BitBrowserAddressError(404, '找不到该地址');
  const prior = rows[index];
  if (prior.status !== expectedStatus) {
    throw new BitBrowserAddressError(409, '地址状态已在其他页面更新，请重新核对');
  }
  if (prior.status === status) return { rows, result: prior };
  if (prior.status === 'used') {
    throw new BitBrowserAddressError(409, '已使用地址不能恢复为可用状态');
  }
  const result = { ...prior, status, usedAt: status === 'used' ? now : null };
  return { rows: rows.with(index, result), result };
}
