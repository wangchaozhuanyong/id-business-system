import type { CurrentUser } from '@/types/system';
import { hasUserFeatureAccess } from '@/utils/permissions';
import { v2ModuleDefinitions } from '@/v2/config/modules';

export function getFirstAllowedV2Route(user: CurrentUser | null | undefined): string {
  return v2ModuleDefinitions.find((module) => hasUserFeatureAccess(user, module))?.route ?? '/403';
}
