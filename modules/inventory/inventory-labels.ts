import { formatV2DateTime } from '../time/dateTime.ts';
import { operatorUsername } from '../time/operator.ts';
import type {
  V2ExtractableInventoryKind,
  V2ExtractionState,
  V2GoogleMailbox,
  V2InventoryActor,
  V2InventoryHealth,
  V2InventoryState
} from './contracts.ts';

export const inventoryKindLabels: Record<V2ExtractableInventoryKind, string> = {
  google_mailbox: '谷歌邮箱',
  gpt_account: 'GPT 账号',
  apple_id: 'Apple ID',
  claude_account: 'Claude 账号'
};
export function isInventoryExtractionKind(value: unknown): value is V2ExtractableInventoryKind {
  return typeof value === 'string' && Object.hasOwn(inventoryKindLabels, value);
}

export const inventoryHealthLabels: Record<V2InventoryHealth, string> = {
  normal: '正常',
  frozen: '冻结',
  restricted: '封控',
  dead: '死号',
  unsealing: '解封中'
};
export const inventoryStateLabels: Record<V2InventoryState, string> = {
  available: '库存',
  extracted: '已提取',
  used: '已使用'
};
export const extractionStateLabels: Record<V2ExtractionState, string> = {
  pending: '待使用',
  returned: '已归还',
  used: '已使用'
};
const actionLabels: Record<string, string> = {
  'google.created': '邮箱录入',
  'google.updated': '资料修改',
  'google.health_changed': '账号状态调整',
  'google.imported': '邮箱导入',
  'google.reverted': '撤回资料修改',
  'gpt.created': '录入 GPT 账号',
  'gpt.updated': '修改 GPT 账号资料',
  'gpt.health_changed': '调整 GPT 账号状态',
  'gpt.order-delivered': '成品交付登记',
  'claude.order-delivered': 'Claude 成品交付登记',
  'gpt.imported': '批量导入 GPT 账号',
  'apple.created': '录入 Apple ID 资料',
  'apple.updated': '修改 Apple ID 资料',
  'apple.health_changed': '调整 Apple ID 账号状态',
  'apple.imported': '批量导入 Apple ID 资料',
  'apple.wallet-used': '转入 Apple ID 钱包使用',
  'claude.created': '录入 Claude 账号',
  'claude.updated': '修改 Claude 账号资料',
  'claude.health_changed': '调整 Claude 账号状态',
  'claude.imported': '批量导入 Claude 账号',
  'extraction.claimed': '提取',
  'extraction.returned': '归还',
  'extraction.used': '使用确认',
  create: '登记邮箱',
  import: '批量导入',
  update: '修改资料',
  extract: '提取',
  return: '归还',
  use: '确认使用',
  health: '账号状态变更',
  health_update: '账号状态变更',
  google_create: '登记邮箱',
  google_import: '批量导入',
  google_update: '修改资料'
};
export function inventoryEventLabel(action: string) {
  return actionLabels[action] ?? '库存操作';
}
export function inventoryActorLabel(actor?: V2InventoryActor | null) {
  return actor ? operatorUsername(actor) : '历史未记录';
}
export function inventoryDate(value?: string | null) {
  return value ? formatV2DateTime(value) : '未记录';
}
export function googleMailboxCell(row: V2GoogleMailbox, field: string) {
  const values: Record<string, string | undefined> = {
    email: row.email,
    password: row.password,
    totpSecret: row.totpSecret,
    recoveryEmail: row.recoveryEmail,
    phone: row.phone,
    phoneUnboundConfirmed: row.phoneUnboundConfirmed ? '已确认未绑定' : '—',
    country: row.country?.name,
    appPassword: row.appPassword,
    health: inventoryHealthLabels[row.health],
    source: row.source.name,
    registeredAt: inventoryDate(row.registeredAt),
    loginDevice: row.loginDevice,
    remark1: row.remark1,
    remark2: row.remark2,
    state: inventoryStateLabels[row.stock.state],
    createdBy: inventoryActorLabel(row.createdBy),
    createdAt: inventoryDate(row.createdAt),
    updatedBy: inventoryActorLabel(row.updatedBy),
    updatedAt: inventoryDate(row.updatedAt)
  };
  return values[field] || '—';
}
