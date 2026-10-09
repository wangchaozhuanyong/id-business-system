import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { ONLINE_RECHARGE_PERMISSION } from './contracts';
import {
  OnlineRechargeAssetsRepository,
  assertOnlineSensitive
} from './persistence/assets.repository';
import { object, text } from './validation';
export { assertOnlineSensitive } from './persistence/assets.repository';

@Injectable()
export class OnlineRechargeAssetsService {
  constructor(private readonly assets: OnlineRechargeAssetsRepository) {}
  action(section: string, action: string, raw: unknown, operator: AuthenticatedUser) {
    const input = object(raw);
    if (!['cards', 'proxies', 'addresses', 'cdks'].includes(section))
      throw new BadRequestException('资源类型无效');
    if (['reveal', 'export'].includes(action)) {
      assertOnlineSensitive(operator);
      text(input.reason ?? '资料出库', '查看原因', 500);
    } else if (
      !operator.roles.includes('admin') &&
      !operator.permissions.includes(ONLINE_RECHARGE_PERMISSION.manage)
    )
      throw new ForbiddenException('没有管理资料的权限');
    return this.assets.action(section, action, input, operator);
  }
  importCards(raw: unknown, operator?: AuthenticatedUser) {
    if (!Array.isArray(raw) || !raw.length || raw.length > 500)
      throw new BadRequestException('每次须导入1至500张卡');
    return this.assets.importCards(raw, operator);
  }
}
