import {
  V2_ACCOUNT_OFFER_LABELS,
  V2_REGISTRATION_STEP_LABELS,
  type V2AccountOffer,
  type V2RegistrationStep
} from '@apple-business/shared';
import type { V2AuditLogRecord } from './contracts';
import { auditChangeFieldLabels, auditChangeValueLabels } from './audit-change-labels';

const TECHNICAL_FIELDS = new Set([
  'id',
  'updatedAt',
  'createdAt',
  'uniqueKey',
  'version',
  'contactDisplayModes',
  'restoredFromAuditId'
]);
const PROTECTED_FIELD =
  /password|secret|token|encrypted|securityAnswers|recoveryCodes|cardNumber|giftCardNumber/i;
const ENUM_FIELDS = new Set([
  'status',
  'recordStatus',
  'state',
  'type',
  'source',
  'decision',
  'kind'
]);

export interface V2AuditChange {
  key: string;
  label: string;
  before: string;
  after: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function collectFields(value: unknown, prefix = '', result = new Map<string, unknown>()) {
  const record = asRecord(value);
  if (!record) {
    if (value !== undefined && value !== null) result.set(prefix || 'result', value);
    return result;
  }
  for (const [key, item] of Object.entries(record)) {
    if (TECHNICAL_FIELDS.has(key)) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    const child = asRecord(item);
    if (child && !PROTECTED_FIELD.test(key) && Object.keys(child).length)
      collectFields(child, path, result);
    else result.set(path, item);
  }
  return result;
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
  const record = asRecord(value);
  if (record)
    return JSON.stringify(
      Object.keys(record)
        .sort()
        .map((key) => [key, stableValue(record[key])])
    );
  return JSON.stringify(value) ?? '';
}

export function auditChangeValue(value: unknown, field: string): string {
  if (value === undefined) return '未记录';
  if (value === null || value === '') return '未填写';
  if (PROTECTED_FIELD.test(field) || value === '[REDACTED]') return '内容已保护，不显示原值';
  if (typeof value === 'boolean') {
    if (field === 'registered') return value ? '已注册' : '未注册';
    return value ? '是' : '否';
  }
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value))
    return value.length ? value.map((item) => auditChangeValue(item, field)).join('、') : '无';
  const record = asRecord(value);
  if (record) {
    const name = record.displayName ?? record.name ?? record.label;
    if (typeof name === 'string') return name;
    return Object.keys(record).length ? '已记录关联资料' : '历史记录未保存具体内容';
  }
  const text = String(value);
  if (field === 'offerStatus') return V2_ACCOUNT_OFFER_LABELS[text as V2AccountOffer] ?? '待核实';
  if (field === 'step')
    return V2_REGISTRATION_STEP_LABELS[text as V2RegistrationStep] ?? '阶段待核对';
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) {
    const date = new Date(text);
    if (!Number.isNaN(date.getTime()))
      return new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      }).format(date);
  }
  if (/^[a-f\d]{8}-[a-f\d-]{27,}$/i.test(text)) return `关联记录（尾号 ${text.slice(-8)}）`;
  if (auditChangeValueLabels[text]) return auditChangeValueLabels[text];
  if (ENUM_FIELDS.has(field) && /^[a-z_]+$/i.test(text)) return '其他状态或类型';
  return text;
}

export function operationAuditChanges(item: V2AuditLogRecord): V2AuditChange[] {
  const before = collectFields(item.beforeData);
  const after = collectFields(item.afterData);
  const keys = [...new Set([...before.keys(), ...after.keys()])];
  const hasBefore = item.beforeData !== undefined && item.beforeData !== null;
  const hasAfter = item.afterData !== undefined && item.afterData !== null;
  const rows: V2AuditChange[] = [];
  let unknownIndex = 0;
  for (const key of keys) {
    if (hasBefore && hasAfter && stableValue(before.get(key)) === stableValue(after.get(key)))
      continue;
    const parts = key.split('.');
    const leaf = parts.at(-1)!;
    const labels = parts.map((part) => auditChangeFieldLabels[part]);
    const label = labels.every(Boolean) ? labels.join(' · ') : `其他资料 ${++unknownIndex}`;
    rows.push({
      key,
      label,
      before: auditChangeValue(before.get(key), leaf),
      after: auditChangeValue(after.get(key), leaf)
    });
  }
  return rows;
}

export function operationChangeNotice(item: V2AuditLogRecord) {
  if (item.beforeData == null && item.afterData == null)
    return '这条记录只保存了操作说明，没有保存字段明细。';
  if (item.beforeData == null) return '这条记录只保存了操作后的内容；未记录的旧值无法从日志找回。';
  if (item.afterData == null)
    return item.action.endsWith('.delete')
      ? '下面保留的是删除前的资料。是否还能恢复，需要核对当前回收站。'
      : '这条记录只保存了操作前的内容，没有保存操作后的字段明细。';
  return '只列出已记录且发生变化的字段。未记录的字段不能据此判断；密码、密钥等内容不会显示。';
}

export function operationRestoreExplanation(item: V2AuditLogRecord, supported: boolean) {
  if (supported)
    return '可以申请恢复删除资料。系统会核对回收站和关联资料，由另一名管理员审批后执行；不会把历史快照直接覆盖到当前数据。';
  if (item.action === 'employee.delete')
    return '员工账号删除后的业务已交给超级管理员，不能在这里还原员工登录账号。';
  if (item.action.endsWith('.delete'))
    return '这类资料暂未接入回收站恢复，不能从这条日志直接找回。';
  if (
    [
      'id_business_v2.customer.update',
      'id_business_v2.account.update',
      'id_business_v2.option.update'
    ].includes(item.action)
  )
    return '可以核对并选择恢复名称、备注等普通资料。若资料后来被修改，系统会停止恢复并提示重新核对；金额、状态和敏感内容请在对应业务页面更正。';
  if (/finance|refund|reverse|consume_balance/.test(item.action))
    return '金额和账务不能从日志直接还原。请在对应业务页面执行更正、退款或冲回，系统会保留原记录。';
  if (/update|change_password|reset_password/.test(item.action))
    return '修改记录用于核对前后内容。要更正资料，请到原业务页面修改；不会直接覆盖后续变更。';
  return '这是一条操作或查看记录，无需从日志恢复。';
}

export function supportsAuditFieldRestore(item: V2AuditLogRecord) {
  const types: Record<string, string> = {
    'id_business_v2.customer.update': 'id_business_v2_customer',
    'id_business_v2.account.update': 'id_business_v2_account',
    'id_business_v2.option.update': 'id_business_v2_option'
  };
  return Boolean(item.objectId && types[item.action] && types[item.action] === item.objectType);
}
