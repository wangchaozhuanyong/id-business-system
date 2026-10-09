import { ForbiddenException, Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { ONLINE_RECHARGE_PERMISSION } from './contracts';
import { OnlineRechargeAdminRepository } from './persistence/admin.repository';
import { object } from './validation';

@Injectable()
export class OnlineRechargeAdminService {
  constructor(private readonly admin: OnlineRechargeAdminRepository) {}
  overview() {
    return this.admin.overview();
  }
  list(section: string, query: Record<string, unknown>, operator: AuthenticatedUser) {
    if (section === 'login-logs' && !operator.roles.includes('admin'))
      throw new ForbiddenException('安全日志仅管理员可查看');
    return this.admin.list(section, query, operator);
  }
  action(section: string, action: string, raw: unknown, operator: AuthenticatedUser) {
    const readActions = [
      'detail',
      'subscribe',
      'artifacts',
      'summary',
      'export',
      'reveal',
      'checkout-link'
    ];
    if (
      !readActions.includes(action) &&
      !operator.roles.includes('admin') &&
      !operator.permissions.includes(ONLINE_RECHARGE_PERMISSION.manage)
    )
      throw new ForbiddenException('没有管理线上代充的权限');
    return this.admin.action(section, action, object(raw), operator);
  }
}
