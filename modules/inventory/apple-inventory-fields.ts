import type {
  V2AppleAccount,
  V2AppleAccountInput,
  V2InventoryOption
} from '../contracts/inventory.ts';
import { parseV2DateTimeInput, toV2DateTimeInput, v2DateTimeInputToIso } from '../time/dateTime.ts';
import {
  inventoryActorLabel,
  inventoryDate,
  inventoryHealthLabels,
  inventoryStateLabels
} from './inventory-labels.ts';

const display: Record<string, (row: V2AppleAccount) => string | null | undefined> = {
  appleId: (row) => row.appleId,
  password: (row) => row.password,
  phone: (row) => row.phone,
  phoneUnboundConfirmed: (row) => (row.phoneUnboundConfirmed ? '已确认未绑定' : '—'),
  country: (row) => row.country.name,
  source: (row) => row.source.name,
  health: (row) => inventoryHealthLabels[row.health],
  security1: (row) => row.security1,
  security2: (row) => row.security2,
  security3: (row) => row.security3,
  birthday: (row) => row.birthday,
  appPassword: (row) => row.appPassword,
  registeredAt: (row) => inventoryDate(row.registeredAt),
  loginDevice: (row) => row.loginDevice,
  remark1: (row) => row.remark1,
  remark2: (row) => row.remark2,
  state: (row) => inventoryStateLabels[row.stock.state],
  createdBy: (row) => inventoryActorLabel(row.createdBy),
  createdAt: (row) => inventoryDate(row.createdAt),
  updatedBy: (row) => inventoryActorLabel(row.updatedBy),
  updatedAt: (row) => inventoryDate(row.updatedAt)
};
export function appleInventoryCell(row: V2AppleAccount, field: string) {
  return display[field]?.(row) || '—';
}

export function appleInventoryForm(row?: V2AppleAccount | null) {
  return {
    appleId: row?.appleId ?? '',
    password: row?.password ?? '',
    phone: row?.phone ?? '',
    phoneUnboundConfirmed: row?.phoneUnboundConfirmed ?? false,
    countryOptionId: row?.countryOptionId ?? '',
    sourceOptionId: row?.sourceOptionId ?? '',
    health: row?.health ?? 'normal',
    security1: row?.security1 ?? '',
    security2: row?.security2 ?? '',
    security3: row?.security3 ?? '',
    birthday: row?.birthday ?? '',
    appPassword: row?.appPassword ?? '',
    registeredAt: row?.registeredAt ?? null,
    registeredInput: row?.registeredAt ? toV2DateTimeInput(row.registeredAt) : '',
    loginDevice: row?.loginDevice ?? '',
    remark1: row?.remark1 ?? '',
    remark2: row?.remark2 ?? '',
    expectedVersion: row?.version ?? null
  };
}

export function appleInventoryInput(
  form: ReturnType<typeof appleInventoryForm>
): V2AppleAccountInput {
  const appleId = form.appleId.trim().toLowerCase();
  const phone = form.phone.replace(/[\s()-]/g, '');
  const birthday = form.birthday.trim();
  if (!appleId || appleId.length > 255) throw new Error('请填写有效的 Apple ID');
  if (!form.password.trim()) throw new Error('请填写登录密码');
  if (!form.countryOptionId) throw new Error('请选择国家地区');
  if (!form.sourceOptionId) throw new Error('请选择来源渠道');
  if (Boolean(phone) === form.phoneUnboundConfirmed) {
    throw new Error('请填写绑定电话，或明确确认未绑定电话，二者选一');
  }
  if (phone.length > 40) throw new Error('绑定电话不能超过 40 个字符');
  if (
    birthday &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(birthday) || !parseV2DateTimeInput(`${birthday}T00:00`))
  ) {
    throw new Error('请填写有效的生日日期');
  }
  let registeredAt = form.registeredAt;
  if (!form.registeredInput) registeredAt = null;
  else if (!registeredAt || toV2DateTimeInput(registeredAt) !== form.registeredInput) {
    registeredAt = v2DateTimeInputToIso(form.registeredInput);
  }
  return {
    appleId,
    password: form.password,
    phone,
    phoneUnboundConfirmed: form.phoneUnboundConfirmed,
    countryOptionId: form.countryOptionId,
    sourceOptionId: form.sourceOptionId,
    health: form.health,
    security1: form.security1.trim(),
    security2: form.security2.trim(),
    security3: form.security3.trim(),
    birthday: birthday || null,
    appPassword: form.appPassword.trim(),
    registeredAt,
    loginDevice: form.loginDevice.trim(),
    remark1: form.remark1.trim(),
    remark2: form.remark2.trim()
  };
}

export function appleInventoryOptions(
  options: readonly V2InventoryOption[],
  kind: 'country' | 'source',
  retainedId?: string
) {
  return options.filter(
    (row) => row.scope === 'apple_id' && row.kind === kind && (row.active || row.id === retainedId)
  );
}
export function copyAppleInventoryRow(row: V2AppleAccount) {
  const values = [
    ['Apple ID', row.appleId],
    ['登录密码', row.password],
    ['绑定电话', row.phone],
    ['密保1', row.security1],
    ['密保2', row.security2],
    ['密保3', row.security3],
    ['生日', row.birthday],
    ['应用专用密码', row.appPassword]
  ];
  return navigator.clipboard.writeText(
    values
      .filter(([, value]) => value)
      .map(([label, value]) => `${label}：${value}`)
      .join('\n')
  );
}
