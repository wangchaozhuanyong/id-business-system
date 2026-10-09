import type { CurrentUser } from '@/types/system';
import { hasUserPermission } from '@/utils/permissions';
import type { OnlineSection } from './contracts';
type OnlineUser = CurrentUser & { sensitiveApprovalPermissionCodes?: readonly string[] };
export function requiresOnlineSensitiveApproval(user: OnlineUser | null | undefined) {
  return (
    !user?.roles.includes('admin') &&
    Boolean(
      user?.sensitiveApprovalPermissionCodes?.includes('id_business_v2.online_recharge.sensitive')
    )
  );
}
export function canUseOnlineAction(
  user: OnlineUser | null | undefined,
  section: OnlineSection,
  action: string
) {
  const read = hasUserPermission(user, 'id_business_v2.online_recharge.read');
  const manage = hasUserPermission(user, 'id_business_v2.online_recharge.manage');
  const sensitive =
    hasUserPermission(user, 'id_business_v2.online_recharge.sensitive') &&
    !requiresOnlineSensitiveApproval(user);
  if (!read) return false;
  if (
    ['reveal', 'checkout-link'].includes(action) ||
    (action === 'export' && ['cdks', 'sessions'].includes(section))
  )
    return sensitive;
  if (action === 'copy') return manage && sensitive;
  if (
    ['detail', 'summary', 'artifacts', 'subscribe'].includes(action) ||
    (action === 'export' && ['billing', 'runtime-logs'].includes(section))
  )
    return true;
  return manage;
}
