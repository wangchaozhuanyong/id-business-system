import type {
  V2ClaudeAccountInput,
  V2InventoryHealth,
  V2InventoryOption
} from '../contracts/inventory.ts';
import { parseInventoryRecords, type InventoryCsvIssue } from './inventory-csv.ts';
import {
  claudeInventoryForm,
  claudeInventoryInput,
  claudeInventoryOptions,
  claudeKycLabels,
  claudeProxyKindLabels,
  claudeProxyProtocolLabels
} from './claude-inventory-fields.ts';
import { inventoryHealthLabels } from './inventory-labels.ts';

const headers = {
  账号邮箱: 'email',
  账号密码: 'password',
  邮箱类型: 'mailCategoryOptionId',
  注册国家: 'countryOptionId',
  注册城市: 'cityOptionId',
  '注册 IP 链接': 'registrationIpLink',
  代理类型: 'proxyKind',
  代理协议: 'proxyProtocol',
  代理主机: 'proxyHost',
  代理端口: 'proxyPort',
  代理账号: 'proxyUsername',
  代理密码: 'proxyPassword',
  注册时间: 'registeredInput',
  'KYC 状态': 'kycStatus',
  'KYC 核实来源': 'kycSource',
  账号状态: 'health',
  备注1: 'remark1',
  备注2: 'remark2'
} as const;
export const claudeInventoryCsvHeaders = Object.keys(headers);
export interface ClaudeInventoryCsvRow {
  row: number;
  input: V2ClaudeAccountInput;
}
export interface ClaudeInventoryCsvDefaults {
  countryOptionId: string;
  cityOptionId: string;
  mailCategoryOptionId: string;
  health: V2InventoryHealth;
}
export function claudeInventoryImportFieldLabel(key: string) {
  return (
    Object.entries(headers).find(([, value]) => value === key)?.[0] ??
    (key === 'registeredAt' ? '注册时间' : '资料')
  );
}
const nameKey = (name: string) => name.trim().normalize('NFKC').toLowerCase();
function labelValue<T extends string>(labels: Record<T, string>, value: string): T | undefined {
  return (Object.keys(labels) as T[]).find((key) => nameKey(labels[key]) === nameKey(value));
}

export function parseClaudeInventoryCsv(
  text: string,
  options: readonly V2InventoryOption[],
  defaults: ClaudeInventoryCsvDefaults
) {
  const rows: ClaudeInventoryCsvRow[] = [];
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
  if (!keys.includes('email'))
    errors.push({ row: header.row, field: '表头', message: '必须包含账号邮箱' });
  if (errors.length) return { rows, errors };

  const countries = claudeInventoryOptions(options, 'country');
  const categories = claudeInventoryOptions(options, 'category');
  const seen = new Set<string>();
  for (const record of records) {
    const before = errors.length;
    const issue = (field: string, message: string) =>
      errors.push({ row: record.row, field, message });
    if (keys.length !== record.values.length) {
      issue('列数', '该行列数与表头不一致');
      continue;
    }
    const form = { ...claudeInventoryForm(), ...defaults };
    const countryName = record.values[keys.indexOf('countryOptionId')]?.trim();
    const cityName = record.values[keys.indexOf('cityOptionId')]?.trim();
    if (countryName) {
      form.countryOptionId =
        countries.find((row) => nameKey(row.name) === nameKey(countryName))?.id ?? '';
      if (!form.countryOptionId) issue('注册国家', '未找到对应的启用国家');
    } else if (form.countryOptionId && !countries.some((row) => row.id === form.countryOptionId)) {
      issue('注册国家', '所选默认国家已停用，请重新选择');
    }
    const cities = claudeInventoryOptions(options, 'city', undefined, form.countryOptionId);
    if (cityName) {
      form.cityOptionId = cities.find((row) => nameKey(row.name) === nameKey(cityName))?.id ?? '';
      if (!form.cityOptionId) issue('注册城市', '未在本行所选国家下找到该启用城市');
    } else if (form.cityOptionId && !cities.some((row) => row.id === form.cityOptionId)) {
      issue('注册城市', '默认城市不属于本行所选国家，请填写对应城市');
    }
    for (const [index, key] of keys.entries()) {
      const original = record.values[index] ?? '';
      const value = original.trim();
      if (!key || !value || key === 'countryOptionId' || key === 'cityOptionId') continue;
      if (key === 'mailCategoryOptionId') {
        const item = categories.find((row) => nameKey(row.name) === nameKey(value));
        if (item) form.mailCategoryOptionId = item.id;
        else issue('邮箱类型', '未找到对应的已启用选项');
      } else if (key === 'health') {
        const health = labelValue(inventoryHealthLabels, value);
        if (health) form.health = health;
        else issue('账号状态', '请使用系统中的中文账号状态');
      } else if (key === 'kycStatus') {
        const status = labelValue(claudeKycLabels, value);
        if (status) form.kycStatus = status;
        else issue('KYC 状态', '请填写未知、已核实或未通过核实');
      } else if (key === 'proxyKind') {
        const kind = labelValue(claudeProxyKindLabels, value);
        if (kind) form.proxyKind = kind;
        else issue('代理类型', '请填写动态住宅、静态住宅或移动代理');
      } else if (key === 'proxyProtocol') {
        const protocol = labelValue(claudeProxyProtocolLabels, value);
        if (protocol) form.proxyProtocol = protocol;
        else issue('代理协议', '请填写 HTTP、HTTPS 或 SOCKS5');
      } else if (key === 'registeredInput') {
        form.registeredInput = value.replaceAll('/', '-').replace(' ', 'T');
      } else {
        form[key] = key === 'password' || key === 'proxyPassword' ? original : value;
      }
    }
    if (
      form.mailCategoryOptionId &&
      !categories.some((row) => row.id === form.mailCategoryOptionId)
    ) {
      issue('邮箱类型', '所选默认邮箱类型已停用，请重新选择');
    }
    if (errors.length !== before) continue;
    try {
      const input = claudeInventoryInput(form);
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
