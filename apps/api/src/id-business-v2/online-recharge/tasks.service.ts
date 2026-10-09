import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type { OnlineRechargeTask } from '@prisma/client';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { ONLINE_RECHARGE_PERMISSION, type OnlineRechargeOperation } from './contracts';
import { OnlineRechargeTasksRepository } from './persistence/tasks.repository';
import { assertOnlineSensitive } from './assets.service';
import { object, session } from './validation';

@Injectable()
export class OnlineRechargeTasksService {
  constructor(private readonly tasks: OnlineRechargeTasksRepository) {}
  map(row: OnlineRechargeTask, publicView = false) {
    return this.tasks.map(row, publicView);
  }
  get(taskId: string, publicView = false) {
    return this.tasks.get(taskId, publicView);
  }
  publicConfig() {
    return this.tasks.publicConfig();
  }
  verify(raw: unknown) {
    return this.tasks.verify(object(raw));
  }
  query(raw: unknown) {
    return this.tasks.query(object(raw));
  }
  authorizePublic(raw: unknown) {
    return this.tasks.authorizePublic(object(raw));
  }
  publicTask(raw: unknown) {
    return this.tasks.publicTask(object(raw));
  }
  publicTicket(raw: unknown) {
    return this.tasks.publicTicket(object(raw));
  }
  start(
    raw: unknown,
    operator?: AuthenticatedUser,
    operation: OnlineRechargeOperation = 'recharge',
    full = false
  ) {
    const input = object(raw);
    if (['recharge', 'debug', 'subscription', 'renewal'].includes(operation))
      session(input.session, full);
    if (input.recheckTaskId && (!operator || input.action !== 'recheck'))
      throw new BadRequestException('原任务核对只允许授权管理流程');
    return this.tasks.start(input, operator, operation, full);
  }
  action(section: string, action: string, raw: unknown, operator: AuthenticatedUser) {
    if (['reveal', 'export', 'checkout-link'].includes(action)) assertOnlineSensitive(operator);
    else if (
      !['detail', 'subscribe'].includes(action) &&
      !operator.roles.includes('admin') &&
      !operator.permissions.includes(ONLINE_RECHARGE_PERMISSION.manage)
    )
      throw new ForbiddenException('没有执行任务操作的权限');
    return this.tasks.action(section, action, object(raw), operator);
  }
}
