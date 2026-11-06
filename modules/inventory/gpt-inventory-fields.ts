import type { V2GptAccount, V2GptAccountInput, V2InventoryOption } from '../contracts/inventory.ts';
import { toV2DateTimeInput, v2DateTimeInputToIso } from '../time/dateTime.ts';
import {
  inventoryActorLabel,
  inventoryDate,
  inventoryHealthLabels,
  inventoryStateLabels
} from './inventory-labels.ts';

const gptFieldDisplay: Record<string, (row: V2GptAccount) => string | null | undefined> = {
  email: (row) => row.email,
  mailCategory: (row) => row.mailCategory?.name,
  password: (row) => row.password,
  totpSecret: (row) => row.totpSecret,
  registeredAt: (row) => inventoryDate(row.registeredAt),
  country: (row) => row.country?.name,
  registrationCountryCode: (row) => row.registrationCountryCode,
  registrationIp: (row) => row.registrationIp,
  loginDevice: (row) => row.loginDevice,
  health: (row) => inventoryHealthLabels[row.health],
  source: (row) => row.source?.name,
  remark1: (row) => row.remark1,
  remark2: (row) => row.remark2,
  state: (row) => inventoryStateLabels[row.stock.state],
  createdBy: (row) => inventoryActorLabel(row.createdBy),
  createdAt: (row) => inventoryDate(row.createdAt),
  updatedBy: (row) => inventoryActorLabel(row.updatedBy),
  updatedAt: (row) => inventoryDate(row.updatedAt)
};

export function gptInventoryCell(row: V2GptAccount, field: string) {
  return gptFieldDisplay[field]?.(row) || '—';
}

export interface GptInventoryForm {
  email: string;
  password: string;
  totpSecret: string;
  registeredInput: string;
  registeredAt: string | null;
  countryOptionId: string;
  registrationCountryCode: string;
  registrationIp: string;
  loginDevice: string;
  health: V2GptAccountInput['health'];
  sourceOptionId: string;
  mailCategoryOptionId: string;
  remark1: string;
  remark2: string;
  expectedVersion: number | null;
}

export function gptInventoryForm(row?: V2GptAccount | null): GptInventoryForm {
  return {
    email: row?.email ?? '',
    password: row?.password ?? '',
    totpSecret: row?.totpSecret ?? '',
    registeredInput: row?.registeredAt ? toV2DateTimeInput(row.registeredAt) : '',
    registeredAt: row?.registeredAt ?? null,
    countryOptionId: row?.countryOptionId ?? '',
    registrationCountryCode: row?.registrationCountryCode ?? '',
    registrationIp: row?.registrationIp ?? '',
    loginDevice: row?.loginDevice ?? '',
    health: row?.health ?? 'normal',
    sourceOptionId: row?.sourceOptionId ?? '',
    mailCategoryOptionId: row?.mailCategoryOptionId ?? '',
    remark1: row?.remark1 ?? '',
    remark2: row?.remark2 ?? '',
    expectedVersion: row?.version ?? null
  };
}

export function gptInventoryInput(form: GptInventoryForm): V2GptAccountInput {
  const email = form.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('请输入有效的账号邮箱');
  if (!form.mailCategoryOptionId) throw new Error('请选择邮箱类型');
  if (!form.sourceOptionId) throw new Error('请选择来源渠道');
  const registrationCountryCode = form.registrationCountryCode.trim().toUpperCase();
  if (registrationCountryCode && !/^[A-Z]{2}$/.test(registrationCountryCode)) {
    throw new Error('注册国家代码请填写两位英文字母');
  }
  let registeredAt = form.registeredAt;
  if (!form.registeredInput) registeredAt = null;
  else if (!registeredAt || toV2DateTimeInput(registeredAt) !== form.registeredInput) {
    registeredAt = v2DateTimeInputToIso(form.registeredInput);
  }
  return {
    email,
    password: form.password,
    totpSecret: form.totpSecret.trim(),
    registeredAt,
    countryOptionId: form.countryOptionId || null,
    registrationCountryCode,
    registrationIp: form.registrationIp.trim(),
    loginDevice: form.loginDevice.trim(),
    health: form.health,
    sourceOptionId: form.sourceOptionId,
    mailCategoryOptionId: form.mailCategoryOptionId,
    remark1: form.remark1.trim(),
    remark2: form.remark2.trim()
  };
}

export function copyGptInventoryRow(row: V2GptAccount) {
  const values = [
    `账号邮箱：${row.email}`,
    ...(row.password ? [`账号密码：${row.password}`] : []),
    ...(row.totpSecret ? [`2FA 密钥：${row.totpSecret}`] : [])
  ];
  return navigator.clipboard.writeText(values.join('\n'));
}

export function gptInventoryOptions(
  options: readonly V2InventoryOption[],
  kind: 'category' | 'source' | 'country',
  retainedId?: string
) {
  const scope = kind === 'category' ? 'mail_category' : 'gpt_account';
  return options.filter(
    (option) =>
      option.scope === scope && option.kind === kind && (option.active || option.id === retainedId)
  );
}
