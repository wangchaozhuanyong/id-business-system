import { ForbiddenException, Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { ONLINE_RECHARGE_PERMISSION } from './contracts';
import { OnlineRechargeSettingsRepository } from './persistence/settings.repository';
import { object } from './validation';

@Injectable()
export class OnlineRechargeSettingsService {
  constructor(private readonly settings: OnlineRechargeSettingsRepository) {}
  get() {
    return this.settings.get();
  }
  internal() {
    return this.settings.internal();
  }
  runtime() {
    return this.settings.runtime();
  }
  cardPolicy() {
    return this.settings.cardPolicy();
  }
  update(raw: unknown, operator: AuthenticatedUser) {
    if (
      !operator.roles.includes('admin') &&
      !operator.permissions.includes(ONLINE_RECHARGE_PERMISSION.manage)
    )
      throw new ForbiddenException('没有修改配置的权限');
    return this.settings.update(object(raw), operator);
  }
}
