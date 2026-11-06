import type {
  V2ClaudeAccount,
  V2ClaudeAccountInput,
  V2ClaudeKycStatus,
  V2ClaudeProxyKind,
  V2ClaudeProxyProtocol,
  V2InventoryOption
} from '../contracts/inventory.ts';
import { toV2DateTimeInput, v2DateTimeInputToIso } from '../time/dateTime.ts';
import {
  inventoryActorLabel,
  inventoryDate,
  inventoryHealthLabels,
  inventoryStateLabels
} from './inventory-labels.ts';

export const claudeProxyKindLabels: Record<V2ClaudeProxyKind, string> = {
  dynamic_residential: '动态住宅',
  static_residential: '静态住宅',
  mobile: '移动代理'
};
export const claudeProxyProtocolLabels: Record<V2ClaudeProxyProtocol, string> = {
  http: 'HTTP',
  https: 'HTTPS',
  socks5: 'SOCKS5'
};
export const claudeKycLabels: Record<V2ClaudeKycStatus, string> = {
  unknown: '未知',
  verified: '已核实',
  unverified: '未通过核实'
};

const display: Record<string, (row: V2ClaudeAccount) => string | number | null | undefined> = {
  email: (row) => row.email,
  mailCategory: (row) => row.mailCategory.name,
  password: (row) => row.password,
  country: (row) => row.country.name,
  city: (row) => row.city.name,
  registrationIpLink: (row) => row.registrationIpLink,
  proxyKind: (row) => (row.proxyKind ? claudeProxyKindLabels[row.proxyKind] : null),
  proxyProtocol: (row) => (row.proxyProtocol ? claudeProxyProtocolLabels[row.proxyProtocol] : null),
  proxyHost: (row) => row.proxyHost,
  proxyPort: (row) => row.proxyPort,
  proxyUsername: (row) => row.proxyUsername,
  proxyPassword: (row) => row.proxyPassword,
  registeredAt: (row) => inventoryDate(row.registeredAt),
  ageHours: (row) => row.ageHours,
  agingHours: (row) => row.agingHours,
  eligible: (row) => (row.eligible ? '可用' : row.ageHours === null ? '注册时间未知' : '不可用'),
  kycStatus: (row) => claudeKycLabels[row.kycStatus],
  kycSource: (row) => row.kycSource,
  health: (row) => inventoryHealthLabels[row.health],
  remark1: (row) => row.remark1,
  remark2: (row) => row.remark2,
  state: (row) => inventoryStateLabels[row.stock.state],
  createdBy: (row) => inventoryActorLabel(row.createdBy),
  createdAt: (row) => inventoryDate(row.createdAt),
  updatedBy: (row) => inventoryActorLabel(row.updatedBy),
  updatedAt: (row) => inventoryDate(row.updatedAt)
};
export function claudeInventoryCell(row: V2ClaudeAccount, field: string) {
  const value = display[field]?.(row);
  return value === null || value === undefined || value === '' ? '—' : value;
}

export function claudeInventoryForm(row?: V2ClaudeAccount | null) {
  return {
    email: row?.email ?? '',
    password: row?.password ?? '',
    mailCategoryOptionId: row?.mailCategoryOptionId ?? '',
    countryOptionId: row?.countryOptionId ?? '',
    cityOptionId: row?.cityOptionId ?? '',
    registrationIpLink: row?.registrationIpLink ?? '',
    proxyKind: row?.proxyKind ?? ('' as const),
    proxyProtocol: row?.proxyProtocol ?? ('' as const),
    proxyHost: row?.proxyHost ?? '',
    proxyPort: row?.proxyPort == null ? '' : String(row.proxyPort),
    proxyUsername: row?.proxyUsername ?? '',
    proxyPassword: row?.proxyPassword ?? '',
    registeredAt: row?.registeredAt ?? null,
    registeredInput: row?.registeredAt ? toV2DateTimeInput(row.registeredAt) : '',
    kycStatus: row?.kycStatus ?? 'unknown',
    kycSource: row?.kycSource ?? '',
    health: row?.health ?? 'normal',
    remark1: row?.remark1 ?? '',
    remark2: row?.remark2 ?? '',
    expectedVersion: row?.version ?? null
  };
}

export function claudeInventoryInput(
  form: ReturnType<typeof claudeInventoryForm>
): V2ClaudeAccountInput {
  const email = form.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('请填写有效的账号邮箱');
  if (!form.mailCategoryOptionId) throw new Error('请选择邮箱类型');
  if (!form.countryOptionId) throw new Error('请选择注册国家');
  if (!form.cityOptionId) throw new Error('请选择注册城市');
  const portText = form.proxyPort.trim();
  const proxyPort = portText ? Number(portText) : null;
  if (proxyPort !== null && (!/^\d+$/.test(portText) || proxyPort < 1 || proxyPort > 65535)) {
    throw new Error('代理端口须为 1 至 65535 的整数');
  }
  const registrationIpLink = form.registrationIpLink.trim();
  if (registrationIpLink) {
    const parsed = URL.canParse(registrationIpLink) ? new URL(registrationIpLink) : null;
    if (
      !parsed ||
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password
    ) {
      throw new Error('注册 IP 链接须为有效的 HTTP 或 HTTPS 地址');
    }
  }
  const kycSource = form.kycSource.trim();
  if (form.kycStatus !== 'unknown' && !kycSource) throw new Error('请填写 KYC 核实来源');
  if (kycSource.length > 160) throw new Error('KYC 核实来源不能超过 160 个字符');
  let registeredAt = form.registeredAt;
  if (!form.registeredInput) registeredAt = null;
  else if (!registeredAt || toV2DateTimeInput(registeredAt) !== form.registeredInput) {
    registeredAt = v2DateTimeInputToIso(form.registeredInput);
  }
  return {
    email,
    password: form.password,
    mailCategoryOptionId: form.mailCategoryOptionId,
    countryOptionId: form.countryOptionId,
    cityOptionId: form.cityOptionId,
    registrationIpLink,
    proxyKind: form.proxyKind || null,
    proxyProtocol: form.proxyProtocol || null,
    proxyHost: form.proxyHost.trim(),
    proxyPort,
    proxyUsername: form.proxyUsername.trim(),
    proxyPassword: form.proxyPassword,
    registeredAt,
    kycStatus: form.kycStatus,
    kycSource,
    health: form.health,
    remark1: form.remark1.trim(),
    remark2: form.remark2.trim()
  };
}

export function claudeInventoryOptions(
  options: readonly V2InventoryOption[],
  kind: 'country' | 'city' | 'category',
  retainedId?: string,
  parentId?: string
) {
  const scope = kind === 'category' ? 'mail_category' : 'claude_account';
  return options.filter(
    (row) =>
      row.scope === scope &&
      row.kind === kind &&
      (row.active || row.id === retainedId) &&
      (kind !== 'city' || row.parentId === parentId)
  );
}

export function claudeInventoryCopyText(row: V2ClaudeAccount) {
  const values = [
    ['账号邮箱', row.email],
    ['账号密码', row.password],
    ['注册 IP 链接', row.registrationIpLink],
    ['代理类型', row.proxyKind ? claudeProxyKindLabels[row.proxyKind] : undefined],
    ['代理协议', row.proxyProtocol ? claudeProxyProtocolLabels[row.proxyProtocol] : undefined],
    ['代理主机', row.proxyHost],
    ['代理端口', row.proxyPort],
    ['代理账号', row.proxyUsername],
    ['代理密码', row.proxyPassword]
  ];
  return values
    .filter(([, value]) => value)
    .map(([label, value]) => `${label}：${value}`)
    .join('\n');
}

export function copyClaudeInventoryRow(row: V2ClaudeAccount) {
  return navigator.clipboard.writeText(claudeInventoryCopyText(row));
}
