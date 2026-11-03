import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthenticatedUser } from '../../../auth/auth.types';
import type { OnlineRechargeRepository } from './online-recharge.repository';
import { object } from '../validation';

export function queueBitbrowserRecheck(
  repository: OnlineRechargeRepository,
  taskId: string,
  operator: AuthenticatedUser
) {
  return repository.transaction(`task:${taskId}`, async (tx) => {
    const original = await tx.onlineRechargeTask.findUnique({ where: { id: taskId } });
    if (original?.provider !== 'bitbrowser') return null;
    if (original.status !== 'awaiting_review' || !original.paymentStarted)
      throw new ConflictException('仅允许核对已有付款提交的待核对原任务');
    const updated = await tx.onlineRechargeTask.update({
      where: { id: taskId },
      data: {
        status: 'queued',
        leaseOwner: null,
        leaseId: null,
        leaseExpiresAt: null,
        stage: 'queued',
        message: '等待执行电脑只读核对原付款，不会再次付款',
        payload: {
          ...object(original.payload),
          bitBrowserCheckOnly: true
        } as Prisma.InputJsonObject
      }
    });
    await repository.log(tx, 'bitbrowser.payment.recheck', operator, taskId);
    return updated;
  });
}
