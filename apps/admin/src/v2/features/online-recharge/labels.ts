import { getApiErrorMessage } from '@/api/client';
import type { OnlineRow, OnlineSection } from './contracts';
import { formatV2DateTime } from '@/v2/utils/dateTime';
import { sharedCardPlanLabel } from './shared-card-plans';
export const planOptions = [
  { value: 'plus', label: 'Plus 套餐' },
  { value: 'pro_5x', label: 'Pro 100 套餐' },
  { value: 'pro_20x', label: 'Pro 200 套餐' },
  { value: 'pro_500', label: 'Pro 500 套餐' }
] as const;
export const planHelp =
  'Pro 100／200／500 为美元月费档位名称，本次应付以官网实际币种、税费和折抵报价为准。';
export const regionOptions = [
  { value: 'CL', label: '智利' },
  { value: 'PH', label: '菲律宾' },
  { value: 'US', label: '美国' },
  { value: 'SG', label: '新加坡' },
  { value: 'MY', label: '马来西亚' }
];
export const addressPoolOptions = [{ value: 'US', label: '美国地址池' }];
export function onlineStatusOptions(section: OnlineSection) {
  const values = ['cards', 'proxies'].includes(section)
    ? [
        ['active', '可用'],
        ['disabled', '停用'],
        ['reserved', '已预约']
      ]
    : section === 'cdks'
      ? [
          ['available', '未使用'],
          ['reserved', '已预约'],
          ['used', '已使用']
        ]
      : section === 'addresses'
        ? [
            ['bound', '已绑定'],
            ['unbound', '未绑定']
          ]
        : section === 'billing'
          ? [
              ['success', '成功'],
              ['failed', '失败'],
              ['result_unknown', '待核对']
            ]
          : ['browser-pool', 'runtime-logs', 'login-logs'].includes(section)
            ? []
            : [
                ['queued', '等待执行'],
                ['running', '执行中'],
                ['awaiting_credentials', '待补资料'],
                ['awaiting_review', '待核对'],
                ['succeeded', '成功'],
                ['failed', '失败']
              ];
  return values.map(([value, label]) => ({ value, label }));
}
const states: Record<string, string> = {
  queued: '等待执行',
  running: '执行中',
  success: '成功',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
  canceled: '已取消',
  pending: '待处理',
  pending_review: '待核对',
  review_required: '待核对',
  awaiting_credentials: '待补资料',
  awaiting_review: '待核对',
  waiting_cvc: '待补安全码',
  active: '可用',
  inactive: '停用',
  disabled: '停用',
  available: '可用',
  reserved: '已预约',
  unused: '未使用',
  used: '已使用',
  exhausted: '达到上限',
  declined: '明确拒付',
  unknown: '待核对',
  shipped: '已出库',
  dispatched: '已出库',
  enabled: '启用',
  expired: '已过期',
  plus: 'Plus 套餐',
  pro_5x: 'Pro 100 套餐',
  pro_20x: 'Pro 200 套餐',
  pro_500: 'Pro 500 套餐',
  free: '免费版',
  initial: '首次开通',
  upgrade: '套餐升级',
  local: '本地浏览器',
  third_party: '第三方代充',
  recharge: '充值',
  recharge_started: '充值开始执行',
  recheck: '原单核对',
  subscription: '查询订阅',
  renewal: '处理续费',
  config_test: '配置连通性测试',
  proxy_test: '检测代理',
  browser_manage: '浏览器管理',
  notification: '发送通知',
  prepare: '准备执行',
  session: '恢复会话',
  checkout: '获取支付链接',
  payment: '提交付款',
  payment_submitted: '付款已提交',
  verification: '验证结果',
  human_verification: '官网验证',
  subscription_check: '查询订阅',
  reconciliation: '原单核对',
  accounting: '登记账单与订单',
  paid_pending_activation: '付款已确认，等待套餐生效',
  completed: '执行完成',
  pending_verification: '待验证',
  gpt_api: '第三方代充',
  provider: '第三方代充',
  pool: '池化模式',
  pooled: '池化模式',
  standalone: '独立模式',
  idle: '空闲',
  busy: '占用',
  disconnected: '未连接',
  healthy: '正常',
  online: '已连接',
  offline: '未连接',
  info: '提示',
  warning: '警告',
  error: '错误',
  debug: '调试'
};
export function onlineLabel(value: unknown) {
  if (typeof value === 'boolean') return value ? '是' : '否';
  const str = String(value ?? '');
  return states[str.toLowerCase()] ?? (/^[a-z_]+$/i.test(str) ? '待核对' : str || '—');
}
export function onlineCell(row: OnlineRow, key: string, kind = 'text') {
  if (key === 'allowedPlans') return sharedCardPlanLabel(row[key]);
  const change = onlineChangeDetails(row);
  const changeFields: Record<string, string> = {
    changeKind: 'kind',
    sourcePlan: 'sourcePlan',
    payableAmount: 'amount',
    payableCurrency: 'currency'
  };
  const value = changeFields[key] ? change[changeFields[key]] : row[key];
  if (value === null || value === undefined || value === '') return '—';
  if (kind === 'date') return formatV2DateTime(String(value));
  if (key === 'country' || key === 'region')
    return regionOptions.find((item) => item.value === value)?.label ?? String(value);
  if (key === 'protocol')
    return value === 'extraction' ? '动态提取链接' : String(value).toUpperCase();
  if (
    kind === 'status' ||
    ['plan', 'provider', 'mode', 'level', 'stage', 'event', 'sourcePlan', 'changeKind'].includes(
      key
    )
  )
    return onlineLabel(value);
  if (typeof value === 'boolean') return value ? '是' : '否';
  return typeof value === 'object' ? '查看详情' : String(value);
}
export function onlineError(cause: unknown) {
  return getApiErrorMessage(cause);
}
export function onlineSubscriptionDetails(result?: Record<string, unknown>) {
  const data = result?.data;
  return {
    ...result,
    ...(data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {})
  };
}
export function onlineFailureLabel(value: unknown): string {
  const code = String(value ?? '').toUpperCase();
  const labels: Record<string, string> = {
    SESSION_INVALID: '登录资料失效',
    NETWORK_TIMEOUT: '官网查询超时',
    NETWORK_UNAVAILABLE: '官网网络连接失败',
    PROXY_UNAVAILABLE: '任务代理连接失败',
    UPSTREAM_BLOCKED: '官网要求进一步验证',
    UPSTREAM_FORBIDDEN: '官网拒绝此次查询',
    UPSTREAM_INVALID_RESPONSE: '官网响应无法确认订阅',
    HUMAN_VERIFICATION_REQUIRED: '官网验证尚未完成',
    VERIFICATION_TIMEOUT: '官网验证超时',
    VERIFICATION_CANCELLED: '官网验证已停止',
    VERIFICATION_FRAME_AMBIGUOUS: '无法唯一确认验证题目',
    VERIFICATION_CHALLENGE_UNCHANGED: '验证题目未更新',
    VERIFICATION_ROUNDS_EXHAUSTED: '官网验证达到尝试上限',
    VERIFICATION_UNSUPPORTED: '暂不支持此验证题型',
    VERIFICATION_PAGE_BINDING_REQUIRED: '未能绑定任务验证页面',
    VERIFICATION_PAGE_BINDING_MISMATCH: '任务验证页面不匹配',
    VLM_AUTH_FAILED: '视觉模型鉴权失败',
    VLM_RATE_LIMITED: '视觉模型请求受限',
    VLM_TIMEOUT: '视觉模型请求超时',
    VLM_REQUEST_UNSUPPORTED: '视觉模型请求参数不兼容',
    VLM_IMAGE_UNSUPPORTED: '模型不支持图像输入',
    VLM_INVALID_RESPONSE: '视觉模型未返回有效结果',
    VLM_INVALID_DECISION: '视觉模型结果无法用于当前题目',
    VLM_NOT_CONFIGURED: '尚未配置视觉模型',
    VLM_VISION_CHECK_FAILED: '视觉模型未通过合成图片检测',
    VLM_VISION_JSON_VERIFIED: '图像输入与结果解析通过',
    SUBSCRIPTION_QUERY_FAILED: '订阅查询未成功',
    ACCOUNT_MISMATCH: '原单账号不一致',
    TARGET_SUBSCRIPTION_UNVERIFIED: '目标准确套餐尚未核实',
    LEGACY_ORIGINAL_IDENTITY_MISSING: '旧任务缺少可验证的原结账单标识',
    CHECKOUT_RECOVERY_INVALID: '原结账单与付款资料不一致',
    CHECKOUT_RECOVERY_UNSUPPORTED: '当前原结账单格式尚未核实支持，未提交付款',
    ORIGINAL_PAYMENT_READ_TIMEOUT: '原单付款状态读取超时',
    ORIGINAL_PAYMENT_READ_FAILED: '原单付款状态读取未成功',
    ORIGINAL_PAYMENT_EVIDENCE_MISSING: '缺少绑定原单的实际付款证据',
    LEASE_LOST: '任务执行权限已失效'
  };
  if (labels[code]) return labels[code];
  if (code.startsWith('VERIFICATION_')) return '官网验证未通过';
  if (code.startsWith('VLM_')) return '视觉模型调用失败';
  return code ? '本次结果未能核实' : '';
}
export function onlineResultIssue(result?: Record<string, unknown>): string {
  const details = onlineSubscriptionDetails(result);
  const confirmation = details.confirmation;
  const query =
    confirmation && typeof confirmation === 'object' && !Array.isArray(confirmation)
      ? (confirmation as Record<string, unknown>)
      : details;
  if (query.querySucceeded === false)
    return `订阅查询未成功${query.queryErrorCode ? `：${onlineFailureLabel(query.queryErrorCode)}` : ''}`;
  const code = details.errorCode ?? details.queryErrorCode;
  return code ? onlineFailureLabel(code) : '';
}
export function onlineReconciliationReason(value: unknown): string {
  const reasons: Record<string, string> = {
    legacy_original_identity_missing: '旧任务未保存可验证的原结账单标识，保留待核对',
    original_session_missing: '原任务登录资料缺失，无法读取原单',
    original_submission_missing: '原任务缺少付款提交记录',
    original_route_missing: '原任务地区资料缺失，停止自动核对',
    attempts_exhausted: '三次自动核对后仍未确认，继续保留付款保护'
  };
  return reasons[String(value ?? '')] ?? '原单结果仍待核实';
}
export function onlineChangeDetails(value?: Record<string, unknown>): Record<string, unknown> {
  const change = value?.subscriptionChange;
  return change && typeof change === 'object' && !Array.isArray(change)
    ? (change as Record<string, unknown>)
    : {};
}
export function onlineChangeEntries(value?: Record<string, unknown>) {
  const change = onlineChangeDetails(value);
  if (!Object.keys(change).length) return [];
  return [
    { label: '开通方式', value: onlineLabel(change.kind) },
    { label: '变更前套餐', value: onlineLabel(change.sourcePlan) },
    { label: '目标套餐', value: onlineLabel(change.targetPlan) },
    {
      label: '官网本次应付',
      value:
        change.amount === null || change.amount === undefined || change.amount === ''
          ? '待获取官网报价'
          : String(change.amount)
    },
    { label: '付款币种', value: String(change.currency || '待核对') },
    ...(change.cardLast4 ? [{ label: '实际付款卡尾号', value: String(change.cardLast4) }] : [])
  ];
}
