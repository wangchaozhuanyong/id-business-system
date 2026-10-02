import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type {
  AuditRestoreConfig,
  AuditRestoreField,
  AuditRestorePreview,
  AuditRestoreSource,
  AuditRestoreState,
  AuditRestoreValue
} from './audit-field-restore.types';

const CONFIGS: Readonly<Record<string, AuditRestoreConfig>> = {
  'id_business_v2.customer.update': {
    entity: 'customer',
    objectType: 'id_business_v2_customer',
    module: 'id_business_v2_customers',
    scope: 'customers',
    label: '客户',
    fields: ['name', 'remark']
  },
  'id_business_v2.account.update': {
    entity: 'account',
    objectType: 'id_business_v2_account',
    module: 'id_business_v2_accounts',
    scope: 'accounts',
    label: 'ID 资料',
    fields: ['remark']
  },
  'id_business_v2.option.update': {
    entity: 'option',
    objectType: 'id_business_v2_option',
    module: 'id_business_v2_options',
    scope: 'options',
    label: '业务选项',
    fields: ['name', 'remark', 'sortOrder']
  }
};

const LABELS: Record<AuditRestoreField, string> = {
  name: '名称',
  remark: '备注',
  sortOrder: '排序'
};

function snapshot(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function getAuditRestoreConfig(source: AuditRestoreSource): AuditRestoreConfig {
  const config = CONFIGS[source.action];
  if (!config || source.objectType !== config.objectType || !source.objectId)
    throw new BadRequestException('这条记录不支持普通资料恢复，请到对应业务页面更正。');
  return config;
}

function validValue(
  field: AuditRestoreField,
  value: unknown,
  entity: string
): value is AuditRestoreValue {
  if (field === 'remark')
    return value === null || (typeof value === 'string' && value !== '[REDACTED]');
  if (field === 'sortOrder')
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 99999;
  return (
    typeof value === 'string' &&
    value !== '[REDACTED]' &&
    Boolean(value.trim()) &&
    value.length <= (entity === 'customer' ? 120 : 160) &&
    (entity !== 'option' || value.trim().replace(/\s+/g, ' ') === value)
  );
}

export function buildAuditRestorePreview(
  source: AuditRestoreSource,
  config: AuditRestoreConfig,
  current: AuditRestoreState | null,
  operatorId: string,
  additionalBlockers: string[] = [],
  fieldBlockers: Partial<Record<AuditRestoreField, string>> = {}
): AuditRestorePreview {
  const before = snapshot(source.beforeData);
  const after = snapshot(source.afterData);
  const blockers: string[] = [...additionalBlockers];
  const fields = config.fields.flatMap((key) => {
    if (!Object.hasOwn(before, key) || !Object.hasOwn(after, key) || before[key] === after[key])
      return [];
    if (!validValue(key, before[key], config.entity) || !validValue(key, after[key], config.entity))
      return [];
    return [
      {
        key,
        label: config.entity === 'customer' && key === 'name' ? '客户名称' : LABELS[key],
        currentValue: current?.[key] ?? null,
        restoreValue: before[key] as AuditRestoreValue,
        ...(fieldBlockers[key] ? { blockedReason: fieldBlockers[key] } : {})
      }
    ];
  });
  if (!fields.length) blockers.push('没有记录可恢复的普通字段旧值，请到原业务页面核对更正。');
  else if (fields.every((field) => field.blockedReason))
    blockers.push(...new Set(fields.map((field) => field.blockedReason!)));
  if (!current || current.deletedAt) blockers.push('这条资料已删除，请先通过回收站恢复资料。');
  if (current?.lossReportedAt) blockers.push('ID 已报损冻结，需先在报损页面处理。');
  if (current?.isSystem) blockers.push('系统内置选项不能通过操作记录修改。');
  const sourceVersion = typeof after.updatedAt === 'string' ? new Date(after.updatedAt) : null;
  if (!sourceVersion || Number.isNaN(sourceVersion.getTime()))
    blockers.push('历史记录缺少有效的资料版本，请到原业务页面核对更正。');
  else if (current && current.updatedAt.getTime() !== sourceVersion.getTime())
    blockers.push('资料后来已被修改或恢复，请到原业务页面重新核对，不能覆盖后续内容。');
  if ([before, after].some((data) => data.id !== undefined && data.id !== source.objectId))
    blockers.push('操作记录与资料编号不一致，不能恢复。');
  if (current && fields.some(({ key }) => current[key] !== after[key]))
    blockers.push('当前内容与这次修改后的内容不一致，请重新核对。');
  const previewFingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        source: source.id,
        operatorId,
        objectId: source.objectId,
        updatedAt: current?.updatedAt.toISOString(),
        fields,
        blockers
      })
    )
    .digest('hex');
  return {
    auditId: source.id,
    objectId: source.objectId!,
    objectLabel:
      current?.name ||
      current?.appleIdMasked ||
      `${config.label}（尾号 ${source.objectId!.slice(-8)}）`,
    canRestore: blockers.length === 0,
    blockers,
    previewFingerprint,
    fields
  };
}

export function auditRestoreSnapshot(state: AuditRestoreState, config: AuditRestoreConfig) {
  return {
    id: state.id,
    ...(state.appleIdMasked ? { appleIdMasked: state.appleIdMasked } : {}),
    ...Object.fromEntries(config.fields.map((key) => [key, state[key] ?? null])),
    updatedAt: state.updatedAt.toISOString()
  };
}
