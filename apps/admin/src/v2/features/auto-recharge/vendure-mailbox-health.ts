import type { V2VendureMailboxHealth } from '@apple-business/shared';

const reasons = {
  connected: '监听中',
  connecting: '正在连接',
  reconnecting: '正在重连',
  authorization_failed: '授权失效',
  unsupported: '不支持实时收信，请手动同步',
  disabled: '已禁用',
  realtime_disabled: '实时收信未启用',
  owned_elsewhere: '由其他实例持有，连接状态待核验',
  capacity: '等待连接名额',
  not_started: '监听未确认启动'
};

export function mailboxListenerSummary(health?: V2VendureMailboxHealth) {
  if (!health || health.status !== 'available') return '未知';
  if (!health.listeners.length) return '暂无主邮箱';
  const problem =
    health.listeners.find((item) => item.state === 'unavailable') ??
    health.listeners.find((item) => item.state !== 'listening' && item.state !== 'disabled');
  if (problem) return reasons[problem.reason] ?? '未知';
  const listening = health.listeners.filter((item) => item.state === 'listening').length;
  return listening ? `${listening} 个邮箱监听中` : '已禁用';
}

export function mailboxDeliverySummary(health?: V2VendureMailboxHealth) {
  if (!health || health.status !== 'available' || !health.delivery) return '未知';
  const delivery = health.delivery;
  if (!delivery.configured) return '通知未配置';
  if (delivery.pendingCount > 0) {
    const oldest = Date.parse(delivery.oldestPendingAt ?? '');
    const delayed = Number.isFinite(oldest) && Date.parse(health.checkedAt) - oldest >= 60_000;
    return `${delayed ? '通知积压' : '等待投递'} ${delivery.pendingCount} 条`;
  }
  return delivery.lastDeliveredAt ? '最近投递成功' : '等待首条回执';
}
