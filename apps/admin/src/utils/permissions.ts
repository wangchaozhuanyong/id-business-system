import type { CurrentUser } from '@/types/system';

const PERMISSION_ALIASES: Record<string, string[]> = {
  'code.order.view': ['code.order.create', 'code.order.deliver'],
  'code.order.create': ['code.order.deliver'],
  'code.after_sale.view': ['code.after_sale.manage'],
  'code.delivery_template.manage': ['message_template.manage'],
  'source_platform.view': [
    'customer.view',
    'customer.create',
    'apple.order.view',
    'apple.order.create',
    'code.order.view',
    'code.order.create',
    'code.order.deliver'
  ]
};

const MANAGEMENT_SECTION_ROLE_CODES = new Set(['admin', 'operation', 'technician', 'auditor']);

export function canAccessManagementSections(user: CurrentUser | null | undefined) {
  return user?.roles.some((role) => MANAGEMENT_SECTION_ROLE_CODES.has(role)) ?? false;
}

export function hasUserPermission(
  user: CurrentUser | null | undefined,
  permission?: string
): boolean {
  if (!permission) {
    return true;
  }

  if (user?.roles.includes('admin')) {
    return true;
  }

  const permissionSet = new Set(user?.permissions ?? []);

  if (permissionSet.has(permission)) {
    return true;
  }

  return PERMISSION_ALIASES[permission]?.some((alias) => permissionSet.has(alias)) ?? false;
}

export function hasUserRoutePermission(
  user: CurrentUser | null | undefined,
  permission: unknown
): boolean {
  if (Array.isArray(permission)) {
    return permission.every((item) => hasUserRoutePermission(user, item));
  }

  return typeof permission === 'string' ? hasUserPermission(user, permission) : true;
}
