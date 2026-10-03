import { exportRowsToCsv } from '@/utils/exportCsv';
import type { V2GovernanceRecycleEntity } from '../data-governance/public-api';
import type { V2AuditLogRecord, V2AuditUser, V2SensitiveAccessLogRecord } from './contracts';
import { operationAuditChanges } from './audit-log-changes';
export {
  operationAuditChanges,
  operationChangeNotice,
  operationRestoreExplanation
} from './audit-log-changes';

export const auditModuleOptions = [
  { value: 'auth', label: '登录与账号安全' },
  { value: 'employees', label: '员工账号' },
  { value: 'roles', label: '角色与权限' },
  { value: 'customer', label: '客户资料' },
  { value: 'account', label: '账号资料' },
  { value: 'order', label: '订单' },
  { value: 'option', label: '业务选项' },
  { value: 'exchange_rate', label: '汇率' },
  { value: 'finance', label: '财务' },
  { value: 'auto_recharge', label: '自动充值' },
  { value: 'bank_recharge', label: '银行卡充值' },
  { value: 'data_governance', label: '删除资料恢复' },
  { value: 'website_visit', label: '网站访问统计' },
  { value: 'security', label: '安全设置' }
];
export const auditActionOptions = [
  { value: '.create', label: '新增资料' },
  { value: '.update', label: '修改资料' },
  { value: '.delete', label: '删除资料' },
  { value: 'restore', label: '恢复资料' },
  { value: 'login', label: '登录' },
  { value: 'password', label: '密码操作' },
  { value: 'reveal', label: '查看敏感资料' },
  { value: 'refund', label: '退款' },
  { value: 'reverse', label: '冲回账务' },
  { value: 'export', label: '导出' }
];
export const auditSensitiveFieldOptions = [
  { value: 'password', label: '密码' },
  { value: 'phone', label: '手机号' },
  { value: 'security', label: '密保' },
  { value: 'card_number', label: '卡号' },
  { value: 'totp', label: '动态口令' },
  { value: 'credentials', label: '登录凭据' }
];

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
  'auth.password.rehash': '升级密码保护',
  'employee.create': '创建员工账户',
  'employee.update': '更新员工账户',
  'employee.reset_password': '重置员工密码',
  'employee.delete': '删除员工账号并移交业务',
  'id_business_v2.customer.restore_fields': '恢复客户普通资料',
  'id_business_v2.account.restore_fields': '恢复 ID 备注',
  'id_business_v2.option.restore_fields': '恢复业务选项普通资料',
  'id_business_v2.exchange_rate.fx_snapshot.collect': '保存自动采集的汇率',
  'id_business_v2.exchange_rate.collect.started': '开始采集汇率',
  'id_business_v2.exchange_rate.collect.success': '汇率采集完成',
  'id_business_v2.exchange_rate.collect.failed': '汇率采集失败',
  'id_business_v2.exchange_rate.schedule.claim': '启动汇率定时采集',
  'id_business_v2.website_visit.collect': '记录网站访问',
  'id_business_v2.website_visit.retention': '清理过期网站访问记录',
  'role.create': '创建角色',
  'role.update': '更新角色',
  'audit_logs.export': '导出审计日志'
};

const AUDIT_OBJECT_LABELS: Record<string, string> = {
  registration_job: '注册任务',
  registration_mailbox: '注册邮箱',
  registration_name: '名字资料',
  registration_connector: '本机注册连接器',
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
  id_business_v2_topup_supplier_payment: '充值供应商付款',
  id_business_v2_exchange_rate_run: '汇率采集任务',
  id_business_v2_fx_rate_snapshot: '汇率记录',
  id_business_v2_finance_fx_rate_snapshot: '汇率记录',
  id_business_v2_exchange_rate_entry: '手工汇率',
  id_business_v2_purchase_rate_fetch_run: '收购汇率采集任务',
  id_business_v2_purchase_rate_settings: '收购汇率设置',
  id_business_v2_exchange_rate_settings: '汇率设置',
  id_business_v2_website_visit: '网站访问记录',
  id_business_v2_auto_recharge_record: '自动充值记录',
  id_business_v2_auto_recharge_job: '自动充值任务',
  id_business_v2_bank_recharge_card: '银行卡资料',
  id_business_v2_bank_recharge_order: '银行卡充值订单',
  id_business_v2_quick_action: '便捷操作',
  id_business_v2_recharge_proxy: '充值代理',
  id_business_v2_data_governance_job: '资料恢复或清理申请'
};

const AUDIT_FIELD_LABELS: Record<string, string> = {
  password: '密码',
  security_answer: '密保答案',
  security_answers: '密保答案',
  securityanswers: '密保答案',
  phone: '手机号',
  phone_number: '手机号',
  phonenumber: '手机号',
  gift_card_number: '礼品卡号',
  card_number: '礼品卡号',
  totp_secret: '动态口令密钥',
  totpsecret: '动态口令密钥',
  recovery_code: '恢复码',
  query_code: '邮箱查询码',
  credentials: '登录凭据'
};

const AUDIT_REMARK_LABELS: Record<string, string> = {
  'User logged in': '用户登录成功',
  'User logged out': '用户已退出登录',
  'Upgraded password hash work factor after authentication': '登录验证通过，已升级密码保护',
  'User changed password and revoked active sessions': '用户已修改密码并撤销其他在线会话',
  'Password change failed without logging password material': '密码修改失败，未记录任何密码内容',
  'Sensitive action executed': '已执行敏感操作'
};

const ACTION_SEGMENT_LABELS: Record<string, string> = {
  auto_registration: '自动注册 GPT',
  connector_access: '连接本机执行器',
  resume_credentials: '同步补录安全资料',
  launch: '启动执行任务',
  launch_not_received: '标记任务未接收',
  progress: '更新执行进度',
  code_read: '读取当前验证邮件',
  name: '名字资料',
  auto_recharge: '自动充值',
  bank_recharge: '银行卡充值',
  exchange_rate: '汇率',
  purchase_rate: '收购汇率',
  purchase_quote: '收购报价',
  fx_snapshot: '汇率记录',
  finance_account: '财务账户',
  finance_journal: '财务分录',
  finance_exchange: '资金兑换',
  finance_supplier_wallet: '供应商钱包',
  finance_period: '财务期间',
  data_governance: '资料恢复与清理',
  quick_action: '便捷操作',
  website_visit: '网站访问',
  table_preferences: '表格显示设置',
  proxy: '代理资料',
  addresses: '地址资料',
  chatgpt_account: 'ChatGPT 账号',
  card: '银行卡',
  currency: '币种',
  import: '导入',
  restore: '恢复',
  reveal: '查看敏感内容',
  refund: '退款',
  copy: '复制',
  confirm: '确认',
  start: '开始处理',
  details: '查看详情',
  collect: '采集',
  run: '采集任务',
  success: '完成',
  failed: '失败',
  started: '开始',
  retention_cleanup: '清理过期记录',
  ledger: '保存充值流水',
  server: '服务端充值',
  bitbrowser: '浏览器充值',
  open_window: '打开窗口',
  recheck: '重新核对',
  identity_read: '查看身份资料',
  number_read: '查看完整卡号',
  link_read: '查看连接资料',
  totp_use: '使用动态口令',
  create_manual: '手工新增',
  create_from_payment: '付款后建立账号',
  create_from_verified_payment: '保存已核验付款',
  payment_resolution: '核对付款结果',
  payment_cap: '付款限额',
  metadata_update: '修改资料',
  mark_registered: '标记已注册',
  mark_unregistered: '标记未注册',
  preview_created: '提交恢复或清理申请',
  approval_decided: '审批申请',
  batch_completed: '执行完成',
  item_failed: '单条处理失败',
  item_succeeded: '单条处理完成',
  job_cancelled: '取消申请',
  report_loss: '报损',
  recover_available: '恢复可用',
  unfreeze_loss: '撤销报损',
  security: '安全',
  mfa: '双重验证',
  setup: '开始设置',
  enable: '启用',
  disable: '停用',
  admin_reset: '管理员重置',
  recovery_codes: '恢复码',
  regenerate: '重新生成',
  ip_whitelist: '登录地址白名单',
  revoke: '退出会话',
  revoke_others: '退出其他会话',
  logout: '退出登录',
  sensitive_access: '敏感资料访问',
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
  use: '使用',
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

export function auditUserLabel(user?: V2AuditUser | null, userId?: string | null) {
  if (!user) return userId ? '原操作账号（姓名未记录）' : '系统自动执行';
  return user.displayName && user.displayName !== user.username
    ? `${user.displayName}（${user.username}）`
    : user.username;
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

export function auditModuleLabel(module: string, action?: string) {
  const normalized = action?.replace(/^id_business_v2\./, '').split('.')[0];
  const category = auditModuleOptions.find((option) => option.value === normalized);
  if (category) return category.label;
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
  if (hasChineseText(normalized))
    return normalized
      .replace(/\bV2\s*/g, '')
      .replace(/原子领取/g, '启动')
      .replace(/快照/g, '记录');
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
  const type = auditObjectTypeLabel(item.objectType) || '相关资料';
  for (const snapshot of [item.afterData, item.beforeData]) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) continue;
    const record = snapshot as Record<string, unknown>;
    const name = [
      record.orderNo,
      record.jobNo,
      record.displayName,
      record.name,
      record.appleId,
      record.username,
      record.title,
      record.currency
    ].find((value) => typeof value === 'string' && value.trim() && value !== '[REDACTED]');
    if (name) return `${type} · ${name}`;
  }
  if (item.objectId === item.user?.id) return `${type} · ${auditUserLabel(item.user)}`;
  const namedRemark = item.remark?.match(/(?:客户|选项|订单|开通业务)[：:]\s*(.+)$/);
  if (namedRemark) return `${type} · ${namedRemark[1]}`;
  return item.objectId ? `${type}（记录尾号 ${item.objectId.slice(-8)}）` : type;
}

export function sensitiveObjectLabel(item: V2SensitiveAccessLogRecord) {
  const type = auditObjectTypeLabel(item.objectType) || '相关资料';
  return item.objectId ? `${type}（记录尾号 ${item.objectId.slice(-8)}）` : type;
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
    label: clampRouteText(operationObjectLabel(item), 160)
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
    sourceAuditAction: auditActionLabel(item.action),
    sourceAuditAt: item.createdAt,
    sourceAuditOperator: clampRouteText(auditUserLabel(item.user, item.userId), 120)
  };
}

export function exportOperationAuditRows(rows: V2AuditLogRecord[]) {
  return exportRowsToCsv(
    '操作审计日志',
    [
      { header: '时间（中国标准时间）', value: (row) => formatAuditDate(row.createdAt) },
      { header: '操作人', value: (row) => auditUserLabel(row.user, row.userId) },
      { header: '业务分类', value: (row) => auditModuleLabel(row.module, row.action) },
      { header: '操作类型', value: (row) => auditActionLabel(row.action) },
      { header: '涉及资料', value: operationObjectLabel },
      { header: '说明', value: (row) => auditRemarkLabel(row.remark, row.action) },
      { header: 'IP', value: (row) => row.ip ?? '' },
      { header: '客户端', value: (row) => row.userAgent ?? '' },
      {
        header: '修改明细',
        value: (row) =>
          operationAuditChanges(row)
            .map((change) => `${change.label}：${change.before} → ${change.after}`)
            .join('\n')
      }
    ],
    rows
  );
}

export function exportSensitiveAuditRows(rows: V2SensitiveAccessLogRecord[]) {
  return exportRowsToCsv(
    '敏感访问日志',
    [
      { header: '时间（中国标准时间）', value: (row) => formatAuditDate(row.createdAt) },
      { header: '访问人', value: (row) => auditUserLabel(row.user, row.userId) },
      { header: '业务分类', value: (row) => auditModuleLabel(row.module) },
      { header: '查看内容', value: (row) => auditFieldLabel(row.fieldName) },
      { header: '对象', value: sensitiveObjectLabel },
      { header: '访问原因', value: (row) => auditAccessReasonLabel(row.accessReason) },
      { header: '已批准', value: (row) => (row.approved ? '是' : '否') },
      { header: 'IP', value: (row) => row.ip ?? '' },
      { header: '客户端', value: (row) => row.userAgent ?? '' }
    ],
    rows
  );
}
