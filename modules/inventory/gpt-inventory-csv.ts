import type { V2GptAccountInput } from '../contracts/inventory.ts';
import { parseInventoryRecords, type InventoryCsvIssue } from './inventory-csv.ts';
import { gptInventoryForm, gptInventoryInput } from './gpt-inventory-fields.ts';
import { inventoryHealthLabels } from './inventory-labels.ts';
import type { V2InventoryHealth, V2InventoryOption } from './contracts.ts';

const headers = {
  账号邮箱: 'email',
  邮箱类型: 'mailCategoryOptionId',
  账号密码: 'password',
  '2FA 密钥': 'totpSecret',
  注册时间: 'registeredInput',
  国家地区: 'countryOptionId',
  注册国家代码: 'registrationCountryCode',
  '注册 IP': 'registrationIp',
  登录设备: 'loginDevice',
  账号状态: 'health',
  来源渠道: 'sourceOptionId',
  备注1: 'remark1',
  备注2: 'remark2'
} as const;
export const gptInventoryCsvHeaders = Object.keys(headers);
export interface GptInventoryCsvRow {
  row: number;
  input: V2GptAccountInput;
}
export interface GptInventoryCsvDefaults {
  countryOptionId: string;
  sourceOptionId: string;
  mailCategoryOptionId: string;
  health: V2InventoryHealth;
}
const lookupTypes = {
  countryOptionId: { scope: 'gpt_account', kind: 'country' },
  sourceOptionId: { scope: 'gpt_account', kind: 'source' },
  mailCategoryOptionId: { scope: 'mail_category', kind: 'category' }
} as const;
type LookupKey = keyof typeof lookupTypes;

export function gptInventoryImportFieldLabel(key: string) {
  return (
    Object.entries(headers).find(([, value]) => value === key)?.[0] ??
    (key === 'registeredAt' ? '注册时间' : '资料')
  );
}
function nameKey(value: string) {
  return value.trim().normalize('NFKC').toLowerCase();
}
function optionMatches(option: V2InventoryOption, key: LookupKey) {
  return (
    option.active &&
    option.scope === lookupTypes[key].scope &&
    option.kind === lookupTypes[key].kind
  );
}
export function parseGptInventoryCsv(
  text: string,
  options: readonly V2InventoryOption[],
  defaults: GptInventoryCsvDefaults
) {
  const rows: GptInventoryCsvRow[] = [];
  const errors: InventoryCsvIssue[] = [];
  const stop = (message: string) => ({
    rows,
    errors: [{ row: 1, field: '导入内容', message }]
  });
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
  if (!keys.includes('email'))
    errors.push({ row: header.row, field: '表头', message: '必须包含账号邮箱' });
  if (errors.length) return { rows, errors };

  const seen = new Set<string>();
  for (const record of records) {
    const before = errors.length;
    const issue = (field: string, message: string) =>
      errors.push({ row: record.row, field, message });
    if (keys.length !== record.values.length) {
      issue('列数', '该行列数与表头不一致');
      continue;
    }
    const form = { ...gptInventoryForm(), ...defaults };
    for (const [index, key] of keys.entries()) {
      const original = record.values[index] ?? '';
      const value = original.trim();
      if (!key || !value) continue;
      if (key === 'sourceOptionId' || key === 'countryOptionId' || key === 'mailCategoryOptionId') {
        const option = options.find(
          (item) => optionMatches(item, key) && nameKey(item.name) === nameKey(value)
        );
        if (option) form[key] = option.id;
        else issue(gptInventoryImportFieldLabel(key), '未找到对应的已启用选项');
      } else if (key === 'health') {
        const health = Object.keys(inventoryHealthLabels).find(
          (item) => inventoryHealthLabels[item as V2InventoryHealth] === value
        ) as V2InventoryHealth | undefined;
        if (health) form.health = health;
        else issue('账号状态', '请使用系统中的中文账号状态');
      } else if (key === 'registeredInput') {
        form.registeredInput = value.replaceAll('/', '-').replace(' ', 'T');
      } else {
        form[key] = key === 'password' ? original : value;
      }
    }
    for (const key of Object.keys(lookupTypes) as LookupKey[]) {
      if (
        form[key] &&
        !options.some((option) => option.id === form[key] && optionMatches(option, key))
      ) {
        issue(gptInventoryImportFieldLabel(key), '所选默认值已停用，请重新选择');
      }
    }
    if (errors.length !== before) continue;
    try {
      const input = gptInventoryInput(form);
      if (seen.has(input.email)) issue('账号邮箱', '同一批导入包含重复账号邮箱');
      else {
        seen.add(input.email);
        rows.push({ row: record.row, input });
      }
    } catch (cause) {
      issue('资料', cause instanceof Error ? cause.message : '账号资料无效');
    }
  }
  return { rows, errors };
}
