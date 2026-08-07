import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { V2CommandTransactionManager, type V2CommandTransaction } from '../runtime/public-api';
import {
  assertReservableOrder,
  assertReservationReplayMatches,
  buildConsumptionIdempotencyKey,
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
import { IdBusinessV2OrdersRepository } from './persistence/id-business-v2-orders.repository';
import type {
  IdBusinessV2AccountLockScope,
  IdBusinessV2OrderStatus
} from './id-business-v2-order.types';
const CONSUMABLE_ORDER_STATUSES = new Set<IdBusinessV2OrderStatus>(['pending', 'processing']);

@Injectable()
export class IdBusinessV2OrderLockService {
  constructor(
    private readonly repository: IdBusinessV2OrdersRepository,
    private readonly transactionManager: V2CommandTransactionManager
  ) {}

  async reserveAccountForOrder(input: ReserveAccountForOrderInput, operator?: AuthenticatedUser) {
    const normalized = normalizeReservationInput(input);

    return this.transactionManager.execute(
      (tx) => this.reserveAccountForOrderInTransaction(tx, normalized, operator),
      {
        requestId: randomUUID(),
        operator,
        retryMode: 'none',
        uniqueConflictMessage: 'ID 或订单刚被其他请求锁定，请重新匹配后再试'
      }
    );
  }

  async reserveAccountForOrderInTransaction(
    tx: V2CommandTransaction,
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

    const existingForOrder = await this.repository.findValidLockForOrder(tx, order.id, now);
    if (existingForOrder) {
      assertReservationReplayMatches(existingForOrder, normalized, order.serviceOptionId);
      return toReservationResponse(order, account, existingForOrder, true);
    }

    const conflictingLock = await this.repository.findReservationConflict(tx, {
      accountId: account.id,
      orderId: order.id,
      serviceOptionId: order.serviceOptionId,
      lockScope: normalized.lockScope,
      now
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

    const lock = await this.repository.createAccountLock(tx, {
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
    });

    if (!order.accountId) {
      await this.repository.updateOrder(tx, order.id, {
        accountId: account.id,
        updatedByUserId: operator?.id
      });
    }

    await this.writeLockAuditLog(tx, order, account, lock, operator);
    return toReservationResponse(order, account, lock, false);
  }

  async releaseOrderLock(orderIdValue: string, reasonValue: string, operator?: AuthenticatedUser) {
    const orderId = normalizeUuid(orderIdValue, '订单');
    const reason = normalizeRequiredReason(reasonValue, '释放原因');

    return this.transactionManager.execute(
      (tx) => this.releaseOrderLockInTransaction(tx, orderId, reason, operator),
      {
        requestId: randomUUID(),
        operator,
        retryMode: 'none'
      }
    );
  }

  async releaseOrderLockInTransaction(
    tx: V2CommandTransaction,
    orderIdValue: string,
    reasonValue: string,
    operator?: AuthenticatedUser
  ) {
    const orderId = normalizeUuid(orderIdValue, '订单');
    const reason = normalizeRequiredReason(reasonValue, '释放原因');
    const order = await this.lockOrder(tx, orderId);
    const activeLock = await this.repository.findActiveLockForOrder(tx, orderId);
    if (!activeLock) {
      const latestLock = await this.repository.findLatestLockForOrder(tx, orderId);
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
    const lock = await this.repository.updateAccountLock(tx, activeLock.id, {
      status,
      endedAt,
      endReason: reason,
      endedByUserId: operator?.id
    });

    await this.repository.appendAudit(tx, {
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
    });

    return {
      orderId,
      released: status === 'released',
      alreadyEnded: false,
      lock: toLockSummary(lock)
    };
  }

  async prepareOrderConsumptionInTransaction(
    tx: V2CommandTransaction,
    input: PrepareOrderConsumptionInput,
    operator?: AuthenticatedUser
  ) {
    const orderId = normalizeUuid(input.orderId, '订单');
    const idempotencyKey = buildConsumptionIdempotencyKey(
      orderId,
      normalizeIdempotencyKey(input.idempotencyKey)
    );
    const order = await this.lockOrder(tx, orderId);
    const existingEntry = await this.repository.findLedgerByOrderAndType(
      tx,
      orderId,
      'order_consumption'
    );
    if (existingEntry) {
      const existingReversal = await this.repository.findLedgerByOrderAndType(
        tx,
        orderId,
        'order_consumption_reversal'
      );
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
    const activeLock = await this.repository.findValidLockForOrderAccount(tx, {
      orderId: order.id,
      accountId: account.id,
      now
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

  private async lockOrder(tx: V2CommandTransaction, orderId: string) {
    const order = await this.repository.lockOrder(tx, orderId);
    if (!order) {
      throw new NotFoundException('订单不存在或已删除');
    }
    return order;
  }

  private async lockAccount(tx: V2CommandTransaction, accountId: string) {
    const account = await this.repository.lockAccount(tx, accountId);
    if (!account) {
      throw new NotFoundException('ID 不存在、已停用或关联选项不可用');
    }
    return account;
  }

  private async assertAccountEligibleForOrder(
    tx: V2CommandTransaction,
    order: LockedOrderRow,
    account: LockedAccountRow
  ) {
    if (account.lossReportedAt) {
      throw new ConflictException('已报损冻结 ID 不能锁定或扣减余额');
    }
    if (account.statusCode !== 'normal') {
      throw new ConflictException('只有状态正常的 ID 才能锁定或扣减余额');
    }
    if (account.soldByOrderId && account.soldByOrderId !== order.id) {
      throw new ConflictException('该 ID 已卖出，不能再次匹配、加卡或续费');
    }
    if (account.currentBalance.lt(order.balanceAmount)) {
      throw new ConflictException(
        `ID 余额不足，需要 ${order.balanceAmount.toString()}，当前 ${account.currentBalance.toString()}`
      );
    }

    const service = await this.repository.findEligibleLockService(tx, order.serviceOptionId);
    if (!service?.countryOptionId || !service.parent?.id) {
      throw new ConflictException('订单业务不存在、已停用或没有完整的国家和分类');
    }
    if (service.countryOptionId !== account.countryOptionId) {
      throw new ConflictException('ID 国家与订单业务所属国家不一致');
    }
    const categoryActivation = await this.repository.findActiveCategoryActivationForAccount(tx, {
      accountId: account.id,
      categoryOptionId: service.parent.id,
      evaluatedAt: new Date(),
      editingOrderId: order.id
    });
    if (categoryActivation) {
      throw new ConflictException('该 ID 已有同类业务未到期，不能再次匹配');
    }
  }

  private async expireStaleLocks(
    tx: V2CommandTransaction,
    orderId: string,
    accountId: string,
    now: Date,
    operator?: AuthenticatedUser
  ) {
    const staleLocks = await this.repository.findStaleLocksForOrderOrAccount(tx, {
      orderId,
      accountId,
      now
    });
    if (staleLocks.length === 0) return;

    await this.repository.expireSelectedLocks(tx, {
      lockIds: staleLocks.map((lock) => lock.id),
      endedAt: now,
      endedByUserId: operator?.id
    });

    for (const lock of staleLocks) {
      await this.repository.appendAudit(tx, {
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
      });
    }
  }

  private async writeLockAuditLog(
    tx: V2CommandTransaction,
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
    await this.repository.appendAudit(tx, {
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
    });
  }
}
