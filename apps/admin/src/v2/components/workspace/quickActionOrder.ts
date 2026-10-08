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

// Only read/remove the previous browser-only order during migration. New orders live in the API.
export function clearLegacyQuickActionOrder(userId: string) {
  if (!userId) return;
  try {
    localStorage.removeItem(quickActionOrderKey(userId));
  } catch {
    // A confirmed database order takes precedence even when legacy storage cannot be cleared.
  }
}
