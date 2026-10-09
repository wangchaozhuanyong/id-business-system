import { getApiErrorMessage } from '@/api/client';
import type { OnlineRow, OnlineSection } from './contracts';
import { formatV2DateTime } from '@/v2/utils/dateTime';
export const planOptions = [
  { value: 'plus', label: 'Plus 套餐' },
  { value: 'pro_5x', label: 'Pro 5 倍' },
  { value: 'pro_20x', label: 'Pro 20 倍' }
] as const;
export const regionOptions = [
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
  pro_5x: 'Pro 5 倍',
  pro_20x: 'Pro 20 倍',
  local: '本地浏览器',
  third_party: '第三方代充',
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
  verification: '验证结果',
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
  const value = row[key];
  if (value === null || value === undefined || value === '') return '—';
  if (kind === 'date') return formatV2DateTime(String(value));
  if (key === 'country' || key === 'region')
    return regionOptions.find((item) => item.value === value)?.label ?? String(value);
  if (key === 'protocol') return String(value).toUpperCase();
  if (kind === 'status' || ['plan', 'provider', 'mode', 'level', 'stage', 'event'].includes(key))
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
