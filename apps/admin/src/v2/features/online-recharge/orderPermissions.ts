import type { CurrentUser } from '@/types/system';

export function canReadOnlineOrders(user: CurrentUser | null | undefined) {
  return Boolean(
    user?.roles.includes('admin') &&
    user.permissions?.includes('id_business_v2.online_recharge.read')
  );
}

export function canManageOnlineOrders(user: CurrentUser | null | undefined) {
  return Boolean(
    canReadOnlineOrders(user) &&
    user?.permissions?.includes('id_business_v2.online_recharge.manage')
  );
}
