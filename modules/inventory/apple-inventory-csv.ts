import type {
  V2AppleAccountInput,
  V2InventoryHealth,
  V2InventoryOption
} from '../contracts/inventory.ts';
import { parseInventoryRecords, type InventoryCsvIssue } from './inventory-csv.ts';
import {
  appleInventoryForm,
  appleInventoryInput,
  appleInventoryOptions
} from './apple-inventory-fields.ts';
import { inventoryHealthLabels } from './inventory-labels.ts';

const headers = {
  'Apple ID': 'appleId',
  登录密码: 'password',
  绑定电话: 'phone',
  未绑定确认: 'phoneUnboundConfirmed',
  国家地区: 'countryOptionId',
  来源渠道: 'sourceOptionId',
  账号状态: 'health',
  密保1: 'security1',
  密保2: 'security2',
  密保3: 'security3',
  生日: 'birthday',
  应用专用密码: 'appPassword',
  注册时间: 'registeredInput',
  登录设备: 'loginDevice',
  备注1: 'remark1',
  备注2: 'remark2'
} as const;
export const appleInventoryCsvHeaders = Object.keys(headers);
export interface AppleInventoryCsvRow {
  row: number;
  input: V2AppleAccountInput;
}
export interface AppleInventoryCsvDefaults {
  countryOptionId: string;
  sourceOptionId: string;
  phoneUnboundConfirmed: boolean;
  health: V2InventoryHealth;
}
export function appleInventoryImportFieldLabel(key: string) {
  return (
    Object.entries(headers).find(([, value]) => value === key)?.[0] ??
    (key === 'registeredAt' ? '注册时间' : '资料')
  );
}
const nameKey = (name: string) => name.trim().normalize('NFKC').toLowerCase();

export function parseAppleInventoryCsv(
  text: string,
  options: readonly V2InventoryOption[],
  defaults: AppleInventoryCsvDefaults
) {
  const rows: AppleInventoryCsvRow[] = [];
  const errors: InventoryCsvIssue[] = [];
  const stop = (message: string) => ({ rows, errors: [{ row: 1, field: '导入内容', message }] });
  if (new TextEncoder().encode(text).length > 1024 * 1024) return stop('导入内容不能超过 1 MB');
  let records: ReturnType<typeof parseInventoryRecords>;
  try {
    records = parseInventoryRecords(text);
  } catch (cause) {
    return stop(cause instanceof Error ? cause.message : '导入格式无效');
  }
  const header = records.shift();
  if (!header || !records.length || records.length > 200)
    return stop('请填写表头和 1 至 200 条账号资料');
  const keys = header.values.map((name, index) => {
    const label = name.trim().normalize('NFKC');
    const key = Object.hasOwn(headers, label) ? headers[label as keyof typeof headers] : undefined;
    if (!key)
      errors.push({ row: header.row, field: '表头', message: `第 ${index + 1} 列不是允许的表头` });
    return key;
  });
  if (new Set(keys).size !== keys.length)
    errors.push({ row: header.row, field: '表头', message: '不允许重复表头' });
  if (!keys.includes('appleId') || !keys.includes('password')) {
    errors.push({ row: header.row, field: '表头', message: '必须包含 Apple ID 和登录密码' });
  }
  if (errors.length) return { rows, errors };

  const countries = appleInventoryOptions(options, 'country');
  const sources = appleInventoryOptions(options, 'source');
  const seen = new Set<string>();
  for (const record of records) {
    const before = errors.length;
    const issue = (field: string, message: string) =>
      errors.push({ row: record.row, field, message });
    if (keys.length !== record.values.length) {
      issue('列数', '该行列数与表头不一致');
      continue;
    }
    const form = { ...appleInventoryForm(), ...defaults };
    form.phoneUnboundConfirmed = false;
    for (const [index, key] of keys.entries()) {
      const original = record.values[index] ?? '';
      const value = original.trim();
      if (!key || !value) continue;
      if (key === 'sourceOptionId' || key === 'countryOptionId') {
        const choices = key === 'sourceOptionId' ? sources : countries;
        const option = choices.find((item) => nameKey(item.name) === nameKey(value));
        if (option) form[key] = option.id;
        else issue(appleInventoryImportFieldLabel(key), '未找到对应的已启用选项');
      } else if (key === 'health') {
        const health = Object.keys(inventoryHealthLabels).find(
          (item) => inventoryHealthLabels[item as V2InventoryHealth] === value
        ) as V2InventoryHealth | undefined;
        if (health) form.health = health;
        else issue('账号状态', '请使用系统中的中文账号状态');
      } else if (key === 'phoneUnboundConfirmed') {
        if (!['是', '否', '已确认未绑定', '1', '0'].includes(value))
          issue('未绑定确认', '请填写“是”或“否”');
        else form.phoneUnboundConfirmed = ['是', '已确认未绑定', '1'].includes(value);
      } else if (key === 'registeredInput') {
        form.registeredInput = value.replaceAll('/', '-').replace(' ', 'T');
      } else if (key === 'birthday') {
        form.birthday = value.replaceAll('/', '-');
      } else {
        form[key] = key === 'password' ? original : value;
      }
    }
    const flagIndex = keys.indexOf('phoneUnboundConfirmed');
    if (flagIndex < 0 || !record.values[flagIndex]?.trim()) {
      form.phoneUnboundConfirmed = !form.phone && defaults.phoneUnboundConfirmed;
    }
    if (form.countryOptionId && !countries.some((option) => option.id === form.countryOptionId)) {
      issue('国家地区', '所选默认国家已停用，请重新选择');
    }
    if (form.sourceOptionId && !sources.some((option) => option.id === form.sourceOptionId)) {
      issue('来源渠道', '所选默认来源已停用，请重新选择');
    }
    if (errors.length !== before) continue;
    try {
      const input = appleInventoryInput(form);
      if (seen.has(input.appleId)) issue('Apple ID', '同一批导入包含重复账号');
      else {
        seen.add(input.appleId);
        rows.push({ row: record.row, input });
      }
    } catch (cause) {
      issue('资料', cause instanceof Error ? cause.message : '账号资料无效');
    }
  }
  return { rows, errors };
}
