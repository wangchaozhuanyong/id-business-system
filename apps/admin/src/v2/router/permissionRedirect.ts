import type { CurrentUser } from '@/types/system';
import { hasUserPermission } from '@/utils/permissions';
import { v2ModuleDefinitions } from '@/v2/config/modules';

export function getFirstAllowedV2Route(user: CurrentUser | null | undefined): string {
  return (
    v2ModuleDefinitions.find((module) => hasUserPermission(user, module.permission))?.route ??
    '/403'
  );
}
