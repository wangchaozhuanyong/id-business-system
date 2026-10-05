import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import {
  normalizeV2ExpectedUpdatedAt,
  toV2JsonDocument,
  V2CommandTransactionManager
} from '../runtime/public-api';
import type { ArchiveIdBusinessV2OrderDto } from './dto/archive-id-business-v2-order.dto';
import {
  normalizeIdempotencyKey,
  normalizeRequiredReason,
  normalizeUuid
} from './id-business-v2-order-lock-support';
import { IdBusinessV2OrdersRepository } from './persistence/id-business-v2-orders.repository';

const ARCHIVABLE_STATUSES = new Set(['completed', 'refunded', 'cancelled', 'failed']);
type ArchiveAction = 'archive' | 'unarchive';

@Injectable()
export class IdBusinessV2OrderArchiveService {
  constructor(
    private readonly repository: IdBusinessV2OrdersRepository,
    private readonly transactions: V2CommandTransactionManager
  ) {}

  archive(id: string, dto: ArchiveIdBusinessV2OrderDto, operator?: AuthenticatedUser) {
    return this.execute(id, dto, 'archive', operator);
  }

  unarchive(id: string, dto: ArchiveIdBusinessV2OrderDto, operator?: AuthenticatedUser) {
    return this.execute(id, dto, 'unarchive', operator);
  }

  private async execute(
    idValue: string,
    dto: ArchiveIdBusinessV2OrderDto,
    action: ArchiveAction,
    operator?: AuthenticatedUser
  ) {
    const id = normalizeUuid(idValue, '订单');
    if (
      !dto ||
      typeof dto !== 'object' ||
      Array.isArray(dto) ||
      Object.keys(dto).some(
        (key) => !['expectedUpdatedAt', 'reason', 'idempotencyKey'].includes(key)
      )
    ) {
      throw new BadRequestException('归档确认资料包含无效字段');
    }
    const expected = normalizeV2ExpectedUpdatedAt(dto.expectedUpdatedAt, '订单');
    const reason = normalizeRequiredReason(
      dto.reason,
      action === 'archive' ? '归档原因' : '恢复原因'
    );
    const idempotencyKey = normalizeIdempotencyKey(dto.idempotencyKey);
    const requestDigest = createHash('sha256')
      .update(
        JSON.stringify({
          id,
          action,
          expectedUpdatedAt: expected.toISOString(),
          reason,
          idempotencyKey,
          operatorId: operator?.id ?? null
        })
      )
      .digest('hex');

    return this.transactions.execute(
      async (tx, context) => {
        if (!(await this.repository.lockOrderId(tx, id)))
          throw new NotFoundException('订单不存在或已删除');
        const prior = await this.repository.findArchiveCommand(tx, id, idempotencyKey);
        if (prior) {
          const data = prior.afterData as {
            archiveCommand?: { requestDigest?: string };
            outcome?: { id: string; archivedAt: string | null; updatedAt: string };
          } | null;
          if (
            data?.archiveCommand?.requestDigest !== requestDigest ||
            !data.outcome ||
            data.outcome.id !== id
          ) {
            throw new ConflictException('幂等键已用于其他归档确认内容');
          }
          return { ...data.outcome, idempotentReplay: true };
        }
        const order = await this.repository.findOrderInTransaction(tx, id);
        if (!order || order.deletedAt) throw new NotFoundException('订单不存在或已删除');
        if (order.updatedAt.getTime() !== expected.getTime())
          throw new ConflictException('订单已变化，请刷新后重新确认');
        if (!ARCHIVABLE_STATUSES.has(order.status))
          throw new ConflictException('只有已完成、已退款、已取消或失败订单可以归档或恢复');
        if (action === 'archive' ? Boolean(order.archivedAt) : !order.archivedAt) {
          throw new ConflictException(
            action === 'archive' ? '订单已经归档，请刷新后核对' : '订单尚未归档，请刷新后核对'
          );
        }
        if (
          action === 'archive' &&
          (await this.repository.findValidLockForOrder(tx, id, context.businessTime))
        ) {
          throw new ConflictException('订单仍有有效业务占用，请处理完成后再归档');
        }
        const updatedAt = new Date(
          Math.max(context.businessTime.getTime(), order.updatedAt.getTime() + 1)
        );
        const archivedAt = action === 'archive' ? updatedAt : null;
        await this.repository.updateOrder(tx, id, { archivedAt, updatedAt });
        const outcome = {
          id,
          archivedAt: archivedAt?.toISOString() ?? null,
          updatedAt: updatedAt.toISOString()
        };
        await this.repository.appendAudit(tx, {
          userId: operator?.id,
          module: 'id_business_v2',
          action: `id_business_v2.order.${action}`,
          objectType: 'id_business_v2_order',
          objectId: id,
          beforeData: toV2JsonDocument({
            archivedAt: order.archivedAt?.toISOString() ?? null,
            updatedAt: order.updatedAt.toISOString(),
            status: order.status
          }),
          afterData: toV2JsonDocument({
            archivedAt: outcome.archivedAt,
            updatedAt: outcome.updatedAt,
            status: order.status,
            archiveCommand: { idempotencyKey, requestDigest },
            outcome,
            reason,
            dataPreserved: true
          }),
          remark: reason
        });
        return { ...outcome, idempotentReplay: false };
      },
      { changedScopes: ['orders'], requestId: randomUUID(), operator, retryMode: 'none' }
    );
  }
}
