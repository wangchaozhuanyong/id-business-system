import type { V2DashboardOrderStatus } from './contracts';

export function formatDashboardDate(value?: string | null, dateOnly = false) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(dateOnly ? {} : { hour: '2-digit', minute: '2-digit', hour12: false })
  }).format(date);
}

export function formatDashboardTime(value?: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date);
}

export function formatDashboardMoney(value?: string | null) {
  if (value === null || value === undefined || value === '') return '—';
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'CNY',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(amount);
}

export function dashboardOrderStatusMeta(status: V2DashboardOrderStatus) {
  const labels: Record<V2DashboardOrderStatus, string> = {
    draft: '草稿',
    pending: '待处理',
    waiting_external: '等待外部',
    processing: '处理中',
    completed: '已完成',
    refunded: '已退款',
    cancelled: '已取消',
    failed: '失败'
  };
  if (status === 'completed') return { label: labels[status], type: 'success' as const };
  if (status === 'failed') return { label: labels[status], type: 'danger' as const };
  if (status === 'refunded') return { label: labels[status], type: 'warning' as const };
  if (status === 'cancelled') return { label: labels[status], type: 'info' as const };
  return { label: labels[status], type: 'warning' as const };
}

export function financeHistoryLabel(
  status: 'not_started' | 'in_progress' | 'incomplete' | 'completed' | null
) {
  if (status === 'completed') return '历史数据已确认';
  if (status === 'in_progress') return '历史数据回填中';
  if (status === 'incomplete') return '历史数据待确认';
  if (status === 'not_started') return '历史数据未回填';
  return '无财务查看权限';
}

const AUDIT_ACTION_LABELS: Readonly<Record<string, string>> = {
  order_update: '更新订单',
  'id_business_v2.order.update': '更新订单',
  order_complete: '确认开通',
  'id_business_v2.order.complete': '确认开通',
  order_create_pending: '创建订单',
  'id_business_v2.order.create_pending': '创建订单',
  order_consume_balance: '扣减余额',
  'id_business_v2.order.consume_balance': '扣减余额',
  renewal_confirm: '确认续费',
  'id_business_v2.renewal.manual.complete': '确认续费',
  account_update: '更新 ID',
  'id_business_v2.account.update': '更新 ID',
  customer_create: '创建客户',
  'id_business_v2.customer.create': '创建客户',
  customer_update: '更新客户',
  'id_business_v2.customer.update': '更新客户',
  exchange_rate_update: '更新汇率',
  'id_business_v2.exchange_rate.manual.create': '录入汇率',
  'id_business_v2.exchange_rate.manual.fx_rate.create': '录入汇率',
  'id_business_v2.exchange_rate.settings.update': '更新汇率设置'
};

export function auditActionLabel(action: string) {
  const normalized = action.trim();
  return AUDIT_ACTION_LABELS[normalized] || '其他操作';
}
