import { googleMailboxForm, googleMailboxInput } from './inventory-google-input.ts';
import { inventoryHealthLabels } from './inventory-labels.ts';
import type { V2GoogleMailboxInput, V2InventoryHealth, V2InventoryOption } from './contracts.ts';

const headers = {
  谷歌邮箱: 'email',
  邮箱: 'email',
  邮箱密码: 'password',
  '2FA 密钥': 'totpSecret',
  '2FA密钥': 'totpSecret',
  辅助邮箱: 'recoveryEmail',
  绑定电话: 'phone',
  未绑定确认: 'phoneUnboundConfirmed',
  国家地区: 'countryOptionId',
  应用专用密码: 'appPassword',
  账号状态: 'health',
  来源渠道: 'sourceOptionId',
  注册时间: 'registeredInput',
  登录设备: 'loginDevice',
  备注1: 'remark1',
  备注2: 'remark2'
} as const;
export const inventoryCsvHeaders = [
  '谷歌邮箱',
  '邮箱密码',
  '2FA 密钥',
  '辅助邮箱',
  '绑定电话',
  '未绑定确认',
  '国家地区',
  '应用专用密码',
  '账号状态',
  '来源渠道',
  '注册时间',
  '登录设备',
  '备注1',
  '备注2'
] as const;

const INVENTORY_IMPORT_BODY_LIMIT = 96 * 1024;

export function inventoryImportFitsTransport(rows: readonly unknown[]) {
  // Include the final command envelope; the preflight envelope is smaller.
  const envelope = JSON.stringify({ rows, idempotencyKey: '0'.repeat(36) });
  return new TextEncoder().encode(envelope).length <= INVENTORY_IMPORT_BODY_LIMIT;
}

export interface InventoryCsvIssue {
  row: number;
  field: string;
  message: string;
}
export interface InventoryCsvRow {
  row: number;
  input: V2GoogleMailboxInput;
}
export interface InventoryCsvResult {
  rows: InventoryCsvRow[];
  errors: InventoryCsvIssue[];
}
export interface InventoryCsvDefaults {
  sourceOptionId: string;
  countryOptionId: string;
  phoneUnboundConfirmed: boolean;
}
type RawRecord = { row: number; values: string[] };

export function parseInventoryRecords(text: string): RawRecord[] {
  const source = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const delimiter = source.split('\n', 1)[0]?.includes('\t') ? '\t' : ',';
  const output: RawRecord[] = [];
  let row = 1,
    start = 1,
    value = '',
    values: string[] = [],
    quoted = false,
    closed = false;
  function cell() {
    values.push(value);
    value = '';
    closed = false;
  }
  function record() {
    cell();
    if (values.some((item) => item.trim())) output.push({ row: start, values });
    values = [];
  }
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        value += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
        closed = true;
      } else {
        value += char;
        if (char === '\n') row++;
      }
      continue;
    }
    if (char === delimiter) {
      cell();
      continue;
    }
    if (char === '\n') {
      record();
      row++;
      start = row;
      continue;
    }
    if (char === '"' && !value && !closed) {
      quoted = true;
      continue;
    }
    if (char === '"' || closed) throw new Error(`第 ${row} 行引号格式不正确`);
    value += char;
  }
  if (quoted) throw new Error(`第 ${start} 行引号未闭合`);
  record();
  return output;
}

function activeOption(
  options: readonly V2InventoryOption[],
  kind: 'country' | 'source',
  name: string
) {
  return options.find(
    (option) =>
      option.scope === 'google_mailbox' &&
      option.active &&
      option.kind === kind &&
      option.name.trim().normalize('NFKC').toLowerCase() === name.normalize('NFKC').toLowerCase()
  );
}
export function inventoryImportFieldLabel(key: string) {
  return (
    Object.entries(headers).find(([, value]) => value === key)?.[0] ??
    (key === 'registeredAt' ? '注册时间' : '资料')
  );
}

export function parseInventoryCsv(
  text: string,
  options: readonly V2InventoryOption[],
  defaults: InventoryCsvDefaults
): InventoryCsvResult {
  const errors: InventoryCsvIssue[] = [];
  const rows: InventoryCsvRow[] = [];
  if (new TextEncoder().encode(text).length > 1024 * 1024)
    return { rows, errors: [{ row: 1, field: '导入内容', message: '导入内容不能超过 1 MB' }] };
  let recordsList: RawRecord[];
  try {
    recordsList = parseInventoryRecords(text);
  } catch (error) {
    return {
      rows,
      errors: [
        {
          row: 1,
          field: '导入内容',
          message: error instanceof Error ? error.message : '导入格式无效'
        }
      ]
    };
  }
  const header = recordsList.shift();
  if (!header || !recordsList.length || recordsList.length > 200)
    return {
      rows,
      errors: [{ row: 1, field: '导入内容', message: '请填写表头和 1 至 200 条邮箱资料' }]
    };
  const keys = header.values.map((name, index) => {
    const label = name.trim().normalize('NFKC');
    const key = Object.hasOwn(headers, label) ? headers[label as keyof typeof headers] : undefined;
    if (!key)
      errors.push({ row: header.row, field: '表头', message: `第 ${index + 1} 列不是允许的表头` });
    return key;
  });
  if (new Set(keys).size !== keys.length)
    errors.push({ row: header.row, field: '表头', message: '不允许重复表头' });
  if (!keys.includes('email') || !keys.includes('password'))
    errors.push({ row: header.row, field: '表头', message: '必须包含谷歌邮箱和邮箱密码' });
  if (errors.length) return { rows, errors };
  const seen = new Set<string>();
  for (const record of recordsList) {
    const start = errors.length;
    const issue = (field: string, message: string) =>
      errors.push({ row: record.row, field, message });
    if (record.values.length !== keys.length) {
      issue('列数', '该行列数与表头不一致');
      continue;
    }
    const form = googleMailboxForm();
    form.sourceOptionId = defaults.sourceOptionId;
    form.countryOptionId = defaults.countryOptionId;
    for (const [index, key] of keys.entries()) {
      if (!key) continue;
      const original = record.values[index] ?? '';
      const value = original.trim();
      if (!value) continue;
      if (key === 'countryOptionId' || key === 'sourceOptionId') {
        const kind = key === 'countryOptionId' ? 'country' : 'source';
        const option = activeOption(options, kind, value);
        if (!option) issue(inventoryImportFieldLabel(key), '未找到当前表已启用的选项');
        else form[key] = option.id;
      } else if (key === 'health') {
        const health = Object.keys(inventoryHealthLabels).find(
          (item) => inventoryHealthLabels[item as V2InventoryHealth] === value
        );
        if (!health) issue('账号状态', '请选择模板中已有的中文账号状态');
        else form.health = health as V2InventoryHealth;
      } else if (key === 'phoneUnboundConfirmed') {
        if (!['是', '否', '已确认未绑定', '1', '0'].includes(value))
          issue('未绑定确认', '请填写“是”或“否”');
        else form.phoneUnboundConfirmed = ['是', '已确认未绑定', '1'].includes(value);
      } else if (key === 'registeredInput') {
        form.registeredInput = value.replaceAll('/', '-').replace(' ', 'T');
      } else {
        form[key] = key === 'password' ? original : value;
      }
    }
    const explicitPhoneFlag = keys.indexOf('phoneUnboundConfirmed');
    if (explicitPhoneFlag < 0 || !record.values[explicitPhoneFlag]?.trim()) {
      form.phoneUnboundConfirmed = !form.phone?.trim() && defaults.phoneUnboundConfirmed;
    }
    if (errors.length !== start) continue;
    try {
      const input = googleMailboxInput(form);
      if (seen.has(input.email)) issue('谷歌邮箱', '同一批导入包含重复邮箱');
      else {
        seen.add(input.email);
        rows.push({ row: record.row, input });
      }
    } catch (error) {
      issue('资料', error instanceof Error ? error.message : '邮箱资料无效');
    }
  }
  return { rows, errors };
}
