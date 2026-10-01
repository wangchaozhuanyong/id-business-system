import { V2_QUICK_ACTION_LIMITS, type V2QuickActionItem } from '@apple-business/shared';

export function quickActionOrderKey(userId: string) {
  return `id-business-v2:quick-action-order:${encodeURIComponent(userId)}`;
}

export function readQuickActionOrder(userId: string): string[] {
  if (!userId) return [];
  try {
    const value: unknown = JSON.parse(localStorage.getItem(quickActionOrderKey(userId)) ?? '[]');
    if (!Array.isArray(value) || value.length > V2_QUICK_ACTION_LIMITS.count) return [];
    return [
      ...new Set(value.filter((id): id is string => typeof id === 'string' && id.length <= 80))
    ];
  } catch {
    return [];
  }
}

export function sortQuickActions(items: V2QuickActionItem[], ids: string[]) {
  const positions = new Map(ids.map((id, index) => [id, index]));
  return [...items].sort(
    (left, right) =>
      (positions.get(left.id) ?? positions.size) - (positions.get(right.id) ?? positions.size)
  );
}

export function writeQuickActionOrder(userId: string, ids: string[]) {
  if (!userId) throw new Error('无法识别当前用户，请重新登录后重试');
  try {
    localStorage.setItem(quickActionOrderKey(userId), JSON.stringify(ids));
  } catch {
    throw new Error('浏览器无法保存顺序，请允许本站存储后重新拖动');
  }
}
