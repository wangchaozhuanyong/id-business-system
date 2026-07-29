import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { IdBusinessV2AccountLockScope, Prisma as PrismaNamespace } from '@prisma/client';
import type { IdBusinessV2OrderStatus, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { toV2DecimalString } from '../decimal-policy';
import {
  assertReservableOrder,
  assertReservationReplayMatches,
  buildConsumptionIdempotencyKey,
  isUniqueConstraintError,
  normalizeIdempotencyKey,
  normalizeRequiredReason,
  normalizeReservationInput,
  normalizeUuid,
  toLockSummary,
  toReservationResponse,
  type LockedAccountRow,
  type LockedOrderRow,
  type PrepareOrderConsumptionInput,
  type ReserveAccountForOrderInput
} from './id-business-v2-order-lock-support';
const CONSUMABLE_ORDER_STATUSES = new Set<IdBusinessV2OrderStatus>(['pending', 'processing']);

@Injectable()
export class IdBusinessV2OrderLockService {
  constructor(private readonly prisma: PrismaService) {}

  async reserveAccountForOrder(input: ReserveAccountForOrderInput, operator?: AuthenticatedUser) {
    const normalized = normalizeReservationInput(input);

    try {
      return await this.prisma.$transaction((tx) =>
        this.reserveAccountForOrderInTransaction(tx, normalized, operator)
      );
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException('ID 或订单刚被其他请求锁定，请重新匹配后再试');
      }
      throw error;
    }
  }

  async reserveAccountForOrderInTransaction(
    tx: Prisma.TransactionClient,
    input: ReserveAccountForOrderInput,
    operator?: AuthenticatedUser
  ) {
    const normalized = normalizeReservationInput(input);
    const now = new Date();
    const order = await this.lockOrder(tx, normalized.orderId);
    assertReservableOrder(order);
    if (order.accountId && order.accountId !== normalized.accountId) {
      throw new ConflictException('订单已经绑定其他 ID，不能重复锁定');
    }

    const account = await this.lockAccount(tx, normalized.accountId);
    await this.assertAccountEligibleForOrder(tx, order, account);
    await this.expireStaleLocks(tx, order.id, account.id, now, operator);

    const existingForOrder = await tx.idBusinessV2AccountLock.findFirst({
      where: {
        orderId: order.id,
        status: 'active',
        expiresAt: {
          gt: now
        }
      },
      orderBy: {
        lockedAt: 'desc'
      }
    });
    if (existingForOrder) {
      assertReservationReplayMatches(existingForOrder, normalized, order.serviceOptionId);
      return toReservationResponse(order, account, existingForOrder, true);
    }

    const conflictingLock = await tx.idBusinessV2AccountLock.findFirst({
      where: {
        accountId: account.id,
        orderId: {
          not: order.id
        },
        status: 'active',
        expiresAt: {
          gt: now
        },
        OR:
          normalized.lockScope === 'global'
            ? undefined
            : [
                {
                  lockScope: 'global'
                },
                {
                  lockScope: 'by_service',
                  serviceOptionId: order.serviceOptionId
                }
              ]
      },
      select: {
        id: true,
        lockScope: true,
        serviceOptionId: true
      }
    });
    if (conflictingLock) {
      throw new ConflictException(
        conflictingLock.lockScope === 'global'
          ? '该 ID 已被其他订单全局锁定'
          : normalized.lockScope === 'global'
            ? '该 ID 已有其他业务占用，不能全局锁定'
            : '该 ID 的当前业务已被其他订单锁定'
      );
    }

    let lock;
    try {
      lock = await tx.idBusinessV2AccountLock.create({
        data: {
          accountId: account.id,
          serviceOptionId: normalized.lockScope === 'by_service' ? order.serviceOptionId : null,
          orderId: order.id,
          lockScope: normalized.lockScope,
          status: 'active',
          lockToken: randomUUID().replaceAll('-', ''),
          reason: normalized.reason,
          lockedAt: now,
          expiresAt: normalized.expiresAt,
          createdByUserId: operator?.id
        }
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException('ID 或订单刚被其他请求锁定，请重新匹配后再试');
      }
      throw error;
    }

    if (!order.accountId) {
      await tx.idBusinessV2Order.update({
        where: {
          id: order.id
        },
        data: {
          accountId: account.id,
          updatedByUserId: operator?.id
        }
      });
    }

    await this.writeLockAuditLog(tx, order, account, lock, operator);
    return toReservationResponse(order, account, lock, false);
  }

  async releaseOrderLock(orderIdValue: string, reasonValue: string, operator?: AuthenticatedUser) {
    const orderId = normalizeUuid(orderIdValue, '订单');
    const reason = normalizeRequiredReason(reasonValue, '释放原因');

    return this.prisma.$transaction((tx) =>
      this.releaseOrderLockInTransaction(tx, orderId, reason, operator)
    );
  }

  async releaseOrderLockInTransaction(
    tx: Prisma.TransactionClient,
    orderIdValue: string,
    reasonValue: string,
    operator?: AuthenticatedUser
  ) {
    const orderId = normalizeUuid(orderIdValue, '订单');
    const reason = normalizeRequiredReason(reasonValue, '释放原因');
    const order = await this.lockOrder(tx, orderId);
    const activeLock = await tx.idBusinessV2AccountLock.findFirst({
      where: {
        orderId,
        status: 'active'
      },
      orderBy: {
        lockedAt: 'desc'
      }
    });
    if (!activeLock) {
      const latestLock = await tx.idBusinessV2AccountLock.findFirst({
        where: {
          orderId
        },
        orderBy: {
          lockedAt: 'desc'
        }
      });
      return {
        orderId,
        released: false,
        alreadyEnded: Boolean(latestLock),
        lock: latestLock ? toLockSummary(latestLock) : null
      };
    }

    await this.lockAccount(tx, activeLock.accountId);
    const endedAt = new Date();
    const status = activeLock.expiresAt.getTime() <= endedAt.getTime() ? 'expired' : 'released';
    const lock = await tx.idBusinessV2AccountLock.update({
      where: {
        id: activeLock.id
      },
      data: {
        status,
        endedAt,
        endReason: reason,
        endedByUserId: operator?.id
      }
    });

    await tx.auditLog.create({
      data: {
        userId: operator?.id,
        module: 'id_business_v2',
        action: `id_business_v2.order_lock.${status}`,
        objectType: 'id_business_v2_account_lock',
        objectId: lock.id,
        beforeData: {
          orderId: order.id,
          accountId: lock.accountId,
          status: 'active'
        },
        afterData: {
          status,
          endedAt,
          endReason: reason
        },
        remark: `V2 订单锁${status === 'released' ? '释放' : '过期'}：${order.orderNo}`
      }
    });

    return {
      orderId,
      released: status === 'released',
      alreadyEnded: false,
      lock: toLockSummary(lock)
    };
  }

  async prepareOrderConsumptionInTransaction(
    tx: Prisma.TransactionClient,
    input: PrepareOrderConsumptionInput,
    operator?: AuthenticatedUser
  ) {
    const orderId = normalizeUuid(input.orderId, '订单');
    const idempotencyKey = buildConsumptionIdempotencyKey(
      orderId,
      normalizeIdempotencyKey(input.idempotencyKey)
    );
    const order = await this.lockOrder(tx, orderId);
    const existingEntry = await tx.idBusinessV2BalanceLedger.findUnique({
      where: {
        orderId_entryType: {
          orderId,
          entryType: 'order_consumption'
        }
      }
    });
    if (existingEntry) {
      const existingReversal = await tx.idBusinessV2BalanceLedger.findUnique({
        where: {
          orderId_entryType: {
            orderId,
            entryType: 'order_consumption_reversal'
          }
        }
      });
      if (existingEntry.idempotencyKey !== idempotencyKey) {
        throw new ConflictException('订单余额已经扣减，不能使用新的请求重复扣款');
      }
      return {
        idempotentReplay: true,
        idempotencyKey,
        order,
        account: null,
        activeLock: null,
        existingEntry,
        existingReversal
      };
    }

    if (!CONSUMABLE_ORDER_STATUSES.has(order.status)) {
      throw new ConflictException('只有待处理或处理中的订单可以扣减余额');
    }
    if (!order.accountId) {
      throw new ConflictException('订单尚未绑定 ID，不能扣减余额');
    }

    const account = await this.lockAccount(tx, order.accountId);
    await this.assertAccountEligibleForOrder(tx, order, account);
    const now = new Date();
    await this.expireStaleLocks(tx, order.id, account.id, now, operator);
    const activeLock = await tx.idBusinessV2AccountLock.findFirst({
      where: {
        orderId: order.id,
        accountId: account.id,
        status: 'active',
        expiresAt: {
          gt: now
        }
      },
      orderBy: {
        lockedAt: 'desc'
      }
    });
    if (!activeLock) {
      throw new ConflictException('订单没有有效的 ID 锁，不能扣减余额');
    }
    if (
      activeLock.lockScope === 'by_service' &&
      activeLock.serviceOptionId !== order.serviceOptionId
    ) {
      throw new ConflictException('订单锁的业务与订单不一致，不能扣减余额');
    }

    return {
      idempotentReplay: false,
      idempotencyKey,
      order,
      account,
      activeLock,
      existingEntry: null,
      existingReversal: null
    };
  }

  private async lockOrder(tx: Prisma.TransactionClient, orderId: string) {
    const rows = await tx.$queryRaw<LockedOrderRow[]>(PrismaNamespace.sql`
      SELECT
        "id",
        "order_no" AS "orderNo",
        "service_option_id" AS "serviceOptionId",
        "account_id" AS "accountId",
        "received_amount" AS "receivedAmount",
        "platform_fee_amount" AS "platformFeeAmount",
        "account_cost_amount" AS "accountCostAmount",
        "account_disposition" AS "accountDisposition",
        "balance_amount" AS "balanceAmount",
        "balance_cost_amount" AS "balanceCostAmount",
        "refund_cost_amount" AS "refundCostAmount",
        "profit_amount" AS "profitAmount",
        "status"
      FROM "id_business_v2_orders"
      WHERE
        "id" = CAST(${orderId} AS UUID)
        AND "deleted_at" IS NULL
      FOR UPDATE
    `);
    const order = rows[0];
    if (!order) {
      throw new NotFoundException('订单不存在或已删除');
    }
    return order;
  }

  private async lockAccount(tx: Prisma.TransactionClient, accountId: string) {
    const rows = await tx.$queryRaw<LockedAccountRow[]>(PrismaNamespace.sql`
      SELECT
        account."id",
        account."apple_id_masked" AS "appleIdMasked",
        account."current_balance" AS "currentBalance",
        account."balance_cost_amount" AS "balanceCostAmount",
        account."purchase_cost" AS "purchaseCost",
        account."sold_by_order_id" AS "soldByOrderId",
        account."loss_reported_at" AS "lossReportedAt",
        account."country_option_id" AS "countryOptionId",
        status."code" AS "statusCode"
      FROM "id_business_v2_accounts" account
      INNER JOIN "id_business_v2_options" country
        ON country."id" = account."country_option_id"
        AND country."type" = 'country'
        AND country."status" = 'active'
        AND country."deleted_at" IS NULL
      INNER JOIN "id_business_v2_options" status
        ON status."id" = account."status_option_id"
        AND status."type" = 'id_status'
        AND status."status" = 'active'
        AND status."deleted_at" IS NULL
      WHERE
        account."id" = CAST(${accountId} AS UUID)
        AND account."deleted_at" IS NULL
        AND account."record_status" = 'active'
        AND account."loss_reported_at" IS NULL
      FOR UPDATE OF account
    `);
    const account = rows[0];
    if (!account) {
      throw new NotFoundException('ID 不存在、已停用或关联选项不可用');
    }
    return account;
  }

  private async assertAccountEligibleForOrder(
    tx: Prisma.TransactionClient,
    order: LockedOrderRow,
    account: LockedAccountRow
  ) {
    if (account.lossReportedAt) {
      throw new ConflictException('已报损 ID 永久冻结，不能锁定或扣减余额');
    }
    if (account.statusCode !== 'normal') {
      throw new ConflictException('只有状态正常的 ID 才能锁定或扣减余额');
    }
    if (account.soldByOrderId && account.soldByOrderId !== order.id) {
      throw new ConflictException('该 ID 已卖出，不能再次匹配、加卡或续费');
    }
    if (account.currentBalance.lessThan(order.balanceAmount)) {
      throw new ConflictException(
        `ID 余额不足，需要 ${toV2DecimalString(order.balanceAmount)}，当前 ${toV2DecimalString(account.currentBalance)}`
      );
    }

    const service = await tx.idBusinessV2Option.findFirst({
      where: {
        id: order.serviceOptionId,
        type: 'service',
        status: 'active',
        deletedAt: null,
        businessAmount: {
          gt: 0
        },
        parent: {
          is: {
            type: 'business_category',
            status: 'active',
            deletedAt: null
          }
        },
        countryOption: {
          is: {
            type: 'country',
            status: 'active',
            deletedAt: null
          }
        }
      },
      select: {
        countryOptionId: true
      }
    });
    if (!service?.countryOptionId) {
      throw new ConflictException('订单业务不存在、已停用或没有完整的国家和分类');
    }
    if (service.countryOptionId !== account.countryOptionId) {
      throw new ConflictException('ID 国家与订单业务所属国家不一致');
    }
  }

  private async expireStaleLocks(
    tx: Prisma.TransactionClient,
    orderId: string,
    accountId: string,
    now: Date,
    operator?: AuthenticatedUser
  ) {
    const staleLocks = await tx.idBusinessV2AccountLock.findMany({
      where: {
        status: 'active',
        expiresAt: {
          lte: now
        },
        OR: [
          {
            orderId
          },
          {
            accountId
          }
        ]
      },
      select: {
        id: true,
        orderId: true,
        accountId: true,
        expiresAt: true
      }
    });
    if (staleLocks.length === 0) return;

    await tx.idBusinessV2AccountLock.updateMany({
      where: {
        id: {
          in: staleLocks.map((lock) => lock.id)
        },
        status: 'active'
      },
      data: {
        status: 'expired',
        endedAt: now,
        endReason: '到期后由订单事务自动结束',
        endedByUserId: operator?.id
      }
    });

    for (const lock of staleLocks) {
      await tx.auditLog.create({
        data: {
          userId: operator?.id,
          module: 'id_business_v2',
          action: 'id_business_v2.order_lock.expired',
          objectType: 'id_business_v2_account_lock',
          objectId: lock.id,
          beforeData: {
            status: 'active',
            orderId: lock.orderId,
            accountId: lock.accountId,
            expiresAt: lock.expiresAt
          },
          afterData: {
            status: 'expired',
            endedAt: now,
            endReason: '到期后由订单事务自动结束'
          },
          remark: 'V2 订单锁到期后由订单事务自动结束'
        }
      });
    }
  }

  private async writeLockAuditLog(
    tx: Prisma.TransactionClient,
    order: LockedOrderRow,
    account: LockedAccountRow,
    lock: {
      id: string;
      serviceOptionId: string | null;
      lockScope: IdBusinessV2AccountLockScope;
      status: string;
      lockedAt: Date;
      expiresAt: Date;
      reason: string | null;
    },
    operator?: AuthenticatedUser
  ) {
    await tx.auditLog.create({
      data: {
        userId: operator?.id,
        module: 'id_business_v2',
        action: 'id_business_v2.order_lock.create',
        objectType: 'id_business_v2_account_lock',
        objectId: lock.id,
        afterData: {
          orderId: order.id,
          accountId: account.id,
          appleIdMasked: account.appleIdMasked,
          serviceOptionId: lock.serviceOptionId,
          lockScope: lock.lockScope,
          status: lock.status,
          lockedAt: lock.lockedAt,
          expiresAt: lock.expiresAt,
          reason: lock.reason
        },
        remark: `V2 订单锁定 ID：${order.orderNo} / ${account.appleIdMasked}`
      }
    });
  }
}
