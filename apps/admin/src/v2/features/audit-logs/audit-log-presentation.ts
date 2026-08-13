import { exportRowsToCsv } from '@/utils/exportCsv';
import type { V2GovernanceRecycleEntity } from '../data-governance/contracts';
import type { V2AuditLogRecord, V2AuditUser, V2SensitiveAccessLogRecord } from './contracts';

const RESTORABLE_DELETE_ACTIONS: Record<
  string,
  { entity: V2GovernanceRecycleEntity; objectType: string }
> = {
  'id_business_v2.account.delete': {
    entity: 'account',
    objectType: 'id_business_v2_account'
  },
  'id_business_v2.customer.delete': {
    entity: 'customer',
    objectType: 'id_business_v2_customer'
  },
  'id_business_v2.option.delete': {
    entity: 'option',
    objectType: 'id_business_v2_option'
  },
  'id_business_v2.order.delete': {
    entity: 'order',
    objectType: 'id_business_v2_order'
  }
};

export interface V2AuditRestoreCandidate {
  entity: V2GovernanceRecycleEntity;
  id: string;
  label: string;
}

export function auditUserLabel(user?: V2AuditUser | null) {
  if (!user) return '系统或未知员工';
  return user.username;
}

export function formatAuditDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(new Date(value));
}

export function formatAuditJson(value: unknown) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

export function operationObjectLabel(item: V2AuditLogRecord) {
  return [item.objectType, item.objectId].filter(Boolean).join(' / ') || '—';
}

export function sensitiveObjectLabel(item: V2SensitiveAccessLogRecord) {
  return [item.objectType, item.objectId].filter(Boolean).join(' / ') || '—';
}

function clampRouteText(value: string, maxLength: number) {
  const normalized = value.trim();
  return normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized;
}

export function getOperationAuditRestoreCandidate(
  item: V2AuditLogRecord
): V2AuditRestoreCandidate | null {
  const config = RESTORABLE_DELETE_ACTIONS[item.action];
  if (!config || !item.objectId || item.objectType !== config.objectType) return null;
  return {
    entity: config.entity,
    id: item.objectId,
    label: clampRouteText(item.remark || operationObjectLabel(item), 160)
  };
}

export function buildOperationAuditRestoreRouteQuery(item: V2AuditLogRecord) {
  const candidate = getOperationAuditRestoreCandidate(item);
  if (!candidate) return null;
  return {
    tab: 'recycle',
    restoreEntity: candidate.entity,
    restoreId: candidate.id,
    restoreLabel: candidate.label,
    sourceAuditId: item.id,
    sourceAuditAction: item.action,
    sourceAuditAt: item.createdAt,
    sourceAuditOperator: clampRouteText(auditUserLabel(item.user), 120)
  };
}

export function exportOperationAuditRows(rows: V2AuditLogRecord[]) {
  return exportRowsToCsv(
    '操作审计日志',
    [
      { header: '时间（吉隆坡）', value: (row) => formatAuditDate(row.createdAt) },
      { header: '操作人', value: (row) => auditUserLabel(row.user) },
      { header: '模块', value: (row) => row.module },
      { header: '动作', value: (row) => row.action },
      { header: '对象', value: operationObjectLabel },
      { header: '说明', value: (row) => row.remark ?? '' },
      { header: 'IP', value: (row) => row.ip ?? '' },
      { header: '客户端', value: (row) => row.userAgent ?? '' },
      { header: '变更前', value: (row) => formatAuditJson(row.beforeData) },
      { header: '变更后', value: (row) => formatAuditJson(row.afterData) }
    ],
    rows
  );
}

export function exportSensitiveAuditRows(rows: V2SensitiveAccessLogRecord[]) {
  return exportRowsToCsv(
    '敏感访问日志',
    [
      { header: '时间（吉隆坡）', value: (row) => formatAuditDate(row.createdAt) },
      { header: '访问人', value: (row) => auditUserLabel(row.user) },
      { header: '模块', value: (row) => row.module },
      { header: '敏感字段', value: (row) => row.fieldName },
      { header: '对象', value: sensitiveObjectLabel },
      { header: '访问原因', value: (row) => row.accessReason ?? '' },
      { header: '已批准', value: (row) => (row.approved ? '是' : '否') },
      { header: 'IP', value: (row) => row.ip ?? '' },
      { header: '客户端', value: (row) => row.userAgent ?? '' }
    ],
    rows
  );
}
