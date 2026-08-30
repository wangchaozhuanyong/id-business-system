import { exportRowsToCsv } from '@/utils/exportCsv';
import type { V2GovernanceRecycleEntity } from '../data-governance/public-api';
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

const AUDIT_MODULE_LABELS: Record<string, string> = {
  auth: '认证与登录',
  security: '安全中心',
  audit_logs: '审计日志',
  employees: '员工账户',
  roles: '角色权限',
  orders: '订单管理',
  business: '业务管理',
  finance: '财务管理',
  id_business_v2: 'ID 业务管理',
  id_business_v2_account: 'ID 账号管理',
  id_business_v2_finance: '财务管理',
  id_business_v2_customers: '客户管理',
  apple: '历史业务记录'
};

const AUDIT_ACTION_LABELS: Record<string, string> = {
  login: '用户登录',
  logout: '用户退出',
  change_password: '修改密码',
  change_password_failed: '修改密码失败',
  'employee.create': '创建员工账户',
  'employee.update': '更新员工账户',
  'role.create': '创建角色',
  'role.update': '更新角色',
  'audit_logs.export': '导出审计日志'
};

const AUDIT_OBJECT_LABELS: Record<string, string> = {
  user: '员工账户',
  role: '角色',
  order: '订单',
  account: 'ID 账号',
  customer: '客户',
  option: '业务选项',
  id_business_v2_order: '订单',
  id_business_v2_account: 'ID 账号',
  id_business_v2_customer: '客户',
  id_business_v2_option: '业务选项',
  id_business_v2_activation: '开通记录',
  id_business_v2_account_lock: '账号占用锁',
  id_business_v2_gift_card: '礼品卡',
  id_business_v2_finance_settings: '财务设置',
  id_business_v2_finance_expense: '财务支出',
  id_business_v2_managed_mailbox: '托管邮箱',
  id_business_v2_managed_mailbox_setting: '托管邮箱设置',
  id_business_v2_totp_account: '动态口令账号',
  id_business_v2_workspace_shortcut: '工作区快捷网址',
  id_business_v2_branding_settings: '品牌设置',
  id_business_v2_topup_supplier_account: '充值供应商账户',
  id_business_v2_topup_supplier_payment: '充值供应商付款'
};

const AUDIT_FIELD_LABELS: Record<string, string> = {
  password: '密码',
  security_answer: '密保答案',
  security_answers: '密保答案',
  phone: '手机号',
  phone_number: '手机号',
  gift_card_number: '礼品卡号',
  card_number: '礼品卡号',
  totp_secret: '动态口令密钥',
  recovery_code: '恢复码',
  query_code: '邮箱查询码',
  credentials: '登录凭据'
};

const AUDIT_REMARK_LABELS: Record<string, string> = {
  'User logged in': '用户登录成功',
  'User logged out': '用户已退出登录',
  'User changed password and revoked active sessions': '用户已修改密码并撤销其他在线会话',
  'Password change failed without logging password material': '密码修改失败，未记录任何密码内容',
  'Sensitive action executed': '已执行敏感操作'
};

const ACTION_SEGMENT_LABELS: Record<string, string> = {
  account: 'ID 账号',
  account_lock: '账号占用锁',
  activation: '开通记录',
  audit_logs: '审计日志',
  branding: '品牌',
  customer: '客户',
  employee: '员工账户',
  finance: '财务',
  finance_expense: '财务支出',
  gift_card: '礼品卡',
  managed_mailbox: '托管邮箱',
  option: '业务选项',
  order: '订单',
  order_lock: '订单锁',
  renewal: '续费',
  role: '角色',
  session: '在线会话',
  settings: '设置',
  topup_supplier_fund: '充值供应商资金',
  topup_supplier_payment: '充值供应商付款',
  workspace_shortcut: '工作区快捷网址',
  workspace_totp_account: '工作区动态口令账号',
  create: '创建',
  create_pending: '创建待处理记录',
  update: '更新',
  update_expiry: '更新到期时间',
  status_update: '更新状态',
  credential_update: '更新登录凭据',
  delete: '删除',
  complete: '完成',
  cancel: '取消',
  adjust: '调整',
  correct: '更正',
  reverse: '冲销',
  reorder: '调整顺序',
  initialize: '初始化',
  export: '导出',
  expired: '已到期',
  released: '已释放',
  consume_balance: '扣减余额',
  supplier_reassign: '变更供应商',
  microsoft_reauthorize: '重新授权微软邮箱',
  microsoft_create: '创建微软邮箱授权',
  query_code_rotate: '轮换邮箱查询码',
  query_code_settings_update: '更新邮箱查询码设置',
  history_confirm: '确认历史数据',
  history_reopen: '重新核对历史数据'
};

function hasChineseText(value: string) {
  return /[\u3400-\u9fff]/u.test(value);
}

function controlledActionLabel(value: string) {
  const segments = value
    .toLowerCase()
    .replace(/^id_business_v2[._]?/, '')
    .split('.')
    .map((segment) => ACTION_SEGMENT_LABELS[segment])
    .filter((label): label is string => Boolean(label));
  return [...new Set(segments)].join(' · ');
}

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

export function auditModuleLabel(module: string) {
  return AUDIT_MODULE_LABELS[module.toLowerCase()] || '其他业务模块';
}

export function auditActionLabel(action: string) {
  return AUDIT_ACTION_LABELS[action] || controlledActionLabel(action) || '其他业务操作';
}

export function auditObjectTypeLabel(objectType?: string | null) {
  if (!objectType) return '';
  return AUDIT_OBJECT_LABELS[objectType.toLowerCase()] || '业务对象';
}

export function auditFieldLabel(fieldName: string) {
  return AUDIT_FIELD_LABELS[fieldName.toLowerCase()] || '受保护字段';
}

export function auditRemarkLabel(remark?: string | null, action?: string) {
  if (!remark?.trim()) return '—';
  const normalized = remark.trim();
  if (hasChineseText(normalized)) return normalized;
  return (
    AUDIT_REMARK_LABELS[normalized] ||
    (action ? `已记录“${auditActionLabel(action)}”` : '已记录系统操作')
  );
}

export function auditAccessReasonLabel(reason?: string | null) {
  if (!reason?.trim()) return '—';
  const normalized = reason.trim();
  return hasChineseText(normalized) ? normalized : '已登记访问原因';
}

export function operationObjectLabel(item: V2AuditLogRecord) {
  return [auditObjectTypeLabel(item.objectType), item.objectId].filter(Boolean).join(' / ') || '—';
}

export function sensitiveObjectLabel(item: V2SensitiveAccessLogRecord) {
  return [auditObjectTypeLabel(item.objectType), item.objectId].filter(Boolean).join(' / ') || '—';
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
      { header: '时间（中国标准时间）', value: (row) => formatAuditDate(row.createdAt) },
      { header: '操作人', value: (row) => auditUserLabel(row.user) },
      { header: '模块', value: (row) => auditModuleLabel(row.module) },
      { header: '动作', value: (row) => auditActionLabel(row.action) },
      { header: '对象', value: operationObjectLabel },
      { header: '说明', value: (row) => auditRemarkLabel(row.remark, row.action) },
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
      { header: '时间（中国标准时间）', value: (row) => formatAuditDate(row.createdAt) },
      { header: '访问人', value: (row) => auditUserLabel(row.user) },
      { header: '模块', value: (row) => auditModuleLabel(row.module) },
      { header: '敏感字段', value: (row) => auditFieldLabel(row.fieldName) },
      { header: '对象', value: sensitiveObjectLabel },
      { header: '访问原因', value: (row) => auditAccessReasonLabel(row.accessReason) },
      { header: '已批准', value: (row) => (row.approved ? '是' : '否') },
      { header: 'IP', value: (row) => row.ip ?? '' },
      { header: '客户端', value: (row) => row.userAgent ?? '' }
    ],
    rows
  );
}
