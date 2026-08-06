import { exportRowsToCsv } from '@/utils/exportCsv';
import type { V2AuditLogRecord, V2AuditUser, V2SensitiveAccessLogRecord } from './contracts';

export function auditUserLabel(user?: V2AuditUser | null) {
  if (!user) return '系统或未知员工';
  return user.username;
}

export function formatAuditDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'Asia/Kuala_Lumpur'
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
