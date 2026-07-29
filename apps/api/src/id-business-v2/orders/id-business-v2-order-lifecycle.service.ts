import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { IdBusinessV2AccountLockScope, Prisma as PrismaNamespace } from '@prisma/client';
import type { IdBusinessV2BalanceLedger, IdBusinessV2OrderStatus } from '@prisma/client';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { IdBusinessV2BalanceCalculatorService } from '../balances/public-api';
import type { CancelIdBusinessV2OrderDto } from './dto/cancel-id-business-v2-order.dto';
import type { DeleteIdBusinessV2OrderDto } from './dto/delete-id-business-v2-order.dto';
import type { RefundIdBusinessV2OrderDto } from './dto/refund-id-business-v2-order.dto';
import type { UpdateIdBusinessV2OrderDto } from './dto/update-id-business-v2-order.dto';
import { IdBusinessV2OrderLockService } from './id-business-v2-order-lock.service';
import { IdBusinessV2OrdersService } from './id-business-v2-orders.service';
import {
  IdBusinessV2OrderLifecycleSupport,
  type LifecycleTransactionResult
} from './id-business-v2-order-lifecycle-support';

const FULLY_EDITABLE_STATUSES = new Set<IdBusinessV2OrderStatus>(['draft', 'pending']);
const EDITABLE_STATUSES = new Set<IdBusinessV2OrderStatus>([
  'draft',
  'pending',
  'processing',
  'completed',
  'failed'
]);
const CANCELLABLE_STATUSES = new Set<IdBusinessV2OrderStatus>([
  'draft',
  'pending',
  'processing',
  'failed'
]);
const REFUNDABLE_STATUSES = new Set<IdBusinessV2OrderStatus>(['processing', 'completed']);

@Injectable()
export class IdBusinessV2OrderLifecycleService {
  private readonly support: IdBusinessV2OrderLifecycleSupport;

  constructor(
    private readonly prisma: PrismaService,
    private readonly fieldEncryptionService: FieldEncryptionService,
    private readonly balanceCalculator: IdBusinessV2BalanceCalculatorService,
    private readonly orderLockService: IdBusinessV2OrderLockService,
    private readonly ordersService: IdBusinessV2OrdersService
  ) {
    this.support = new IdBusinessV2OrderLifecycleSupport(
      prisma,
      fieldEncryptionService,
      balanceCalculator,
      orderLockService,
      ordersService
    );
  }

  async update(
    orderIdValue: string,
    dto: UpdateIdBusinessV2OrderDto,
    operator?: AuthenticatedUser
  ) {
    const orderId = this.support.normalizeUuid(orderIdValue, '订单');
    const expectedUpdatedAt = this.support.normalizeDate(dto.expectedUpdatedAt, '订单版本');
    this.support.assertUpdateHasChanges(dto);

    try {
      await this.prisma.$transaction(async (tx) => {
        const order = await this.support.lockOrder(tx, orderId);
        if (order.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
          throw new ConflictException('订单已被其他操作修改，请刷新后重新编辑');
        }
        if (!EDITABLE_STATUSES.has(order.status)) {
          throw new ConflictException('当前订单状态不能修改');
        }

        const [consumption, activation, activeLock] = await Promise.all([
          this.support.findConsumption(tx, order.id),
          tx.idBusinessV2Activation.findUnique({
            where: {
              orderId: order.id
            },
            select: {
              id: true
            }
          }),
          tx.idBusinessV2AccountLock.findFirst({
            where: {
              orderId: order.id,
              status: 'active'
            },
            orderBy: {
              lockedAt: 'desc'
            }
          })
        ]);
        const coreFieldsRequested = this.support.hasCoreFieldChanges(dto);
        if (
          coreFieldsRequested &&
          (consumption || activation || !FULLY_EDITABLE_STATUSES.has(order.status))
        ) {
          throw new ConflictException('订单已有扣款或开通证据，不能修改客户、业务、ID 或消耗余额');
        }

        const customerId =
          dto.customerId === undefined
            ? order.customerId
            : this.support.normalizeUuid(dto.customerId, '客户');
        const serviceOptionId =
          dto.serviceOptionId === undefined
            ? order.serviceOptionId
            : this.support.normalizeUuid(dto.serviceOptionId, '业务');
        const accountId =
          dto.accountId === undefined
            ? order.accountId
            : this.support.normalizeUuid(dto.accountId, '使用 ID');
        if (!accountId) {
          throw new ConflictException('订单没有绑定 ID，不能修改');
        }
        const settlementPlatformOptionId =
          dto.settlementPlatformOptionId === undefined
            ? order.settlementPlatformOptionId
            : this.support.normalizeOptionalUuid(dto.settlementPlatformOptionId, '结算平台');
        const platformOrderNo =
          dto.platformOrderNo === undefined
            ? order.platformOrderNo
            : this.support.normalizeOptionalString(dto.platformOrderNo, '平台订单号', 160);
        if (platformOrderNo && !settlementPlatformOptionId) {
          throw new BadRequestException('填写平台订单号时必须选择结算平台');
        }

        const receivedAmount =
          dto.receivedAmount === undefined
            ? order.receivedAmount
            : this.support.normalizeAmount(dto.receivedAmount, '实收金额', true);
        const balanceAmount =
          dto.balanceAmount === undefined
            ? order.balanceAmount
            : this.support.normalizeAmount(dto.balanceAmount, '消耗余额', false);
        const openedAt =
          dto.openedAt === undefined
            ? order.openedAt
            : this.support.normalizeDate(dto.openedAt, '开通时间');
        const dueAt =
          dto.dueAt === undefined ? order.dueAt : this.support.normalizeDate(dto.dueAt, '到期时间');
        if (!openedAt || !dueAt) {
          throw new BadRequestException('开通时间和到期时间不能为空');
        }
        if (dueAt.getTime() <= openedAt.getTime()) {
          throw new BadRequestException('到期时间必须晚于开通时间');
        }

        const lockScope =
          dto.lockScope === undefined
            ? (activeLock?.lockScope ?? IdBusinessV2AccountLockScope.by_service)
            : this.support.normalizeLockScope(dto.lockScope);
        const reservationChanged =
          order.serviceOptionId !== serviceOptionId ||
          order.accountId !== accountId ||
          !order.balanceAmount.equals(balanceAmount) ||
          order.dueAt?.getTime() !== dueAt.getTime() ||
          activeLock?.lockScope !== lockScope;
        const lockSensitiveChanged = !consumption && reservationChanged;
        const consumedLockExpiryChanged =
          Boolean(consumption && activeLock) && order.dueAt?.getTime() !== dueAt.getTime();
        if (lockSensitiveChanged && dueAt.getTime() <= Date.now()) {
          throw new BadRequestException('重新锁定 ID 时到期时间必须晚于当前时间');
        }
        if (
          consumedLockExpiryChanged &&
          activeLock &&
          dueAt.getTime() <= activeLock.lockedAt.getTime()
        ) {
          throw new BadRequestException('锁定到期时间必须晚于原锁定时间');
        }

        await this.support.assertActiveCustomer(tx, customerId);
        await this.support.assertActiveService(tx, serviceOptionId);
        const settlementPlatform = await this.support.resolveSettlementPlatform(
          tx,
          settlementPlatformOptionId,
          settlementPlatformOptionId === order.settlementPlatformOptionId
        );
        const platformFeeAmount = this.support.calculatePlatformFee(
          receivedAmount,
          settlementPlatform
        );
        const profitAmount = consumption
          ? this.support.calculateProfit(
              receivedAmount,
              platformFeeAmount,
              order.balanceCostAmount,
              order.refundCostAmount
            )
          : null;
        const website = this.support.resolveWebsiteAccount(dto, order);
        const remark =
          dto.remark === undefined
            ? order.remark
            : this.support.normalizeOptionalString(dto.remark, '备注', 2000);

        let lockReleased = false;
        if (lockSensitiveChanged) {
          const release = await this.orderLockService.releaseOrderLockInTransaction(
            tx,
            order.id,
            '订单修改后重新匹配并锁定 ID',
            operator
          );
          lockReleased = release.released;
        }

        await tx.idBusinessV2Order.update({
          where: {
            id: order.id
          },
          data: {
            customerId,
            serviceOptionId,
            accountId,
            settlementPlatformOptionId,
            platformOrderNo,
            websiteAccountEncrypted: website.encrypted,
            websiteAccountHash: website.hash,
            websiteAccountMasked: website.masked,
            receivedAmount,
            platformFeeAmount,
            balanceAmount,
            profitAmount,
            openedAt,
            dueAt,
            remark,
            updatedByUserId: operator?.id
          }
        });

        if (activation && (dto.openedAt !== undefined || dto.dueAt !== undefined)) {
          await tx.idBusinessV2Activation.update({
            where: {
              orderId: order.id
            },
            data: {
              openedAt,
              dueAt,
              updatedByUserId: operator?.id
            }
          });
        }

        if (consumedLockExpiryChanged && activeLock) {
          await tx.idBusinessV2AccountLock.update({
            where: {
              id: activeLock.id
            },
            data: {
              expiresAt: dueAt
            }
          });
          await tx.auditLog.create({
            data: {
              userId: operator?.id,
              module: 'id_business_v2',
              action: 'id_business_v2.order_lock.update_expiry',
              objectType: 'id_business_v2_account_lock',
              objectId: activeLock.id,
              beforeData: {
                orderId: order.id,
                expiresAt: activeLock.expiresAt
              },
              afterData: {
                orderId: order.id,
                expiresAt: dueAt
              },
              remark: `修改已扣款订单锁到期时间：${order.orderNo}`
            }
          });
        }

        if (lockSensitiveChanged) {
          await this.orderLockService.reserveAccountForOrderInTransaction(
            tx,
            {
              orderId: order.id,
              accountId,
              expiresAt: dueAt,
              lockScope,
              reason: '订单修改后重新锁定'
            },
            operator
          );
        }

        await tx.auditLog.create({
          data: {
            userId: operator?.id,
            module: 'id_business_v2',
            action: 'id_business_v2.order.update',
            objectType: 'id_business_v2_order',
            objectId: order.id,
            beforeData: this.support.toOrderAuditSnapshot(order),
            afterData: {
              customerId,
              serviceOptionId,
              accountId,
              settlementPlatformOptionId,
              platformOrderNo,
              websiteAccountMasked: website.masked,
              receivedAmount: receivedAmount.toString(),
              platformFeeAmount: platformFeeAmount.toString(),
              balanceAmount: balanceAmount.toString(),
              profitAmount: profitAmount?.toString() ?? null,
              openedAt,
              dueAt,
              remark,
              lockScope,
              lockRecreated: lockSensitiveChanged,
              consumedLockExpiryUpdated: consumedLockExpiryChanged,
              previousLockReleased: lockReleased
            },
            remark: `修改 V2 订单：${order.orderNo}`
          }
        });
      });
    } catch (error) {
      this.support.rethrowWriteConflict(error, '平台订单号已存在或订单刚被其他请求修改');
    }

    return this.ordersService.get(orderId);
  }

  async cancel(
    orderIdValue: string,
    dto: CancelIdBusinessV2OrderDto,
    operator?: AuthenticatedUser
  ) {
    const orderId = this.support.normalizeUuid(orderIdValue, '订单');
    const reason = this.support.normalizeReason(dto.reason);
    const idempotencyKey = this.support.buildReversalIdempotencyKey(
      orderId,
      this.support.normalizeIdempotencyKey(dto.idempotencyKey)
    );

    const result = await this.support.runLifecycleTransaction(
      async (tx): Promise<LifecycleTransactionResult> => {
        const order = await this.support.lockOrder(tx, orderId);
        const existingReversal = await this.support.findReversal(tx, order.id);
        if (order.status === 'cancelled') {
          this.support.assertReversalReplay(existingReversal, idempotencyKey);
          return {
            orderId: order.id,
            reversalLedger: existingReversal,
            balanceRestored: Boolean(existingReversal),
            lockReleased: false,
            idempotentReplay: true
          };
        }
        if (!CANCELLABLE_STATUSES.has(order.status)) {
          throw new ConflictException('只有草稿、待处理、处理中或失败订单可以取消');
        }
        const activation = await tx.idBusinessV2Activation.findUnique({
          where: {
            orderId: order.id
          },
          select: {
            id: true
          }
        });
        if (activation) {
          throw new ConflictException('订单已有开通记录，不能取消；请按真实结果执行退款');
        }

        const consumption = await this.support.findConsumption(tx, order.id);
        if (order.status === 'processing' && !consumption) {
          throw new ConflictException('处理中订单缺少消费流水，不能直接取消');
        }
        if (existingReversal) {
          throw new ConflictException('订单消费已经撤销，请刷新后核对订单状态');
        }

        let reversalLedger: IdBusinessV2BalanceLedger | null = null;
        let balanceRestored = false;
        let profitAmount: PrismaNamespace.Decimal | null = null;
        if (consumption) {
          const restoration = await this.support.restoreConsumption(
            tx,
            order,
            consumption,
            idempotencyKey,
            `取消订单：${reason}`,
            operator
          );
          reversalLedger = restoration.ledger;
          balanceRestored = true;
          profitAmount = this.support.calculateProfit(
            order.receivedAmount,
            order.platformFeeAmount,
            new PrismaNamespace.Decimal(0),
            order.refundCostAmount
          );
        }

        const release = await this.orderLockService.releaseOrderLockInTransaction(
          tx,
          order.id,
          `订单取消：${reason}`,
          operator
        );
        const statusChangedAt = new Date();
        await tx.idBusinessV2Order.update({
          where: {
            id: order.id
          },
          data: {
            status: 'cancelled',
            statusChangedAt,
            balanceCostAmount: balanceRestored ? 0 : order.balanceCostAmount,
            profitAmount,
            updatedByUserId: operator?.id
          }
        });
        await this.support.writeLifecycleAudit(
          tx,
          'cancel',
          order,
          {
            status: 'cancelled',
            statusChangedAt,
            reason,
            balanceRestored,
            reversalLedgerId: reversalLedger?.id ?? null,
            profitAmount: profitAmount?.toString() ?? null,
            lockReleased: release.released
          },
          operator
        );
        return {
          orderId: order.id,
          reversalLedger,
          balanceRestored,
          lockReleased: release.released,
          idempotentReplay: false
        };
      },
      '订单已经取消或消费撤销正在并发处理，请刷新后核对'
    );

    return this.support.buildLifecycleResponse(result);
  }

  async refund(
    orderIdValue: string,
    dto: RefundIdBusinessV2OrderDto,
    operator?: AuthenticatedUser
  ) {
    const orderId = this.support.normalizeUuid(orderIdValue, '订单');
    const refundCostAmount = this.support.normalizeAmount(dto.refundCostAmount, '退款成本', true);
    const reason = this.support.normalizeReason(dto.reason);
    const restoreBalance = this.support.normalizeBoolean(dto.restoreBalance, '是否恢复余额');
    const idempotencyKey = this.support.buildReversalIdempotencyKey(
      orderId,
      this.support.normalizeIdempotencyKey(dto.idempotencyKey)
    );

    const result = await this.support.runLifecycleTransaction(
      async (tx): Promise<LifecycleTransactionResult> => {
        const order = await this.support.lockOrder(tx, orderId);
        const existingReversal = await this.support.findReversal(tx, order.id);
        if (order.status === 'refunded') {
          if (
            order.refundCostAmount === null ||
            !order.refundCostAmount.equals(refundCostAmount) ||
            Boolean(existingReversal) !== restoreBalance
          ) {
            throw new ConflictException('订单已经按其他退款内容处理，请刷新后核对');
          }
          this.support.assertReversalReplay(existingReversal, idempotencyKey);
          return {
            orderId: order.id,
            reversalLedger: existingReversal,
            balanceRestored: Boolean(existingReversal),
            lockReleased: false,
            idempotentReplay: true
          };
        }
        if (!REFUNDABLE_STATUSES.has(order.status)) {
          throw new ConflictException('只有处理中或已完成订单可以退款');
        }

        const consumption = await this.support.findConsumption(tx, order.id);
        if (!consumption) {
          throw new ConflictException('订单缺少真实消费流水，不能退款');
        }
        if (existingReversal) {
          throw new ConflictException('订单消费已经撤销，不能再次退款');
        }
        const activation = await tx.idBusinessV2Activation.findUnique({
          where: {
            orderId: order.id
          },
          select: {
            id: true
          }
        });
        if (restoreBalance && activation) {
          throw new ConflictException('订单已有开通记录，不能把 Apple 余额自动恢复');
        }

        let reversalLedger: IdBusinessV2BalanceLedger | null = null;
        if (restoreBalance) {
          const restoration = await this.support.restoreConsumption(
            tx,
            order,
            consumption,
            idempotencyKey,
            `订单退款并恢复余额：${reason}`,
            operator
          );
          reversalLedger = restoration.ledger;
        }
        const effectiveBalanceCost = restoreBalance
          ? new PrismaNamespace.Decimal(0)
          : order.balanceCostAmount;
        const profitAmount = this.support.calculateProfit(
          order.receivedAmount,
          order.platformFeeAmount,
          effectiveBalanceCost,
          refundCostAmount
        );
        const release = await this.orderLockService.releaseOrderLockInTransaction(
          tx,
          order.id,
          `订单退款：${reason}`,
          operator
        );
        const statusChangedAt = new Date();
        await tx.idBusinessV2Order.update({
          where: {
            id: order.id
          },
          data: {
            refundCostAmount,
            balanceCostAmount: effectiveBalanceCost,
            profitAmount,
            status: 'refunded',
            statusChangedAt,
            updatedByUserId: operator?.id
          }
        });
        await this.support.writeLifecycleAudit(
          tx,
          'refund',
          order,
          {
            status: 'refunded',
            statusChangedAt,
            reason,
            refundCostAmount: refundCostAmount.toString(),
            balanceRestored: restoreBalance,
            reversalLedgerId: reversalLedger?.id ?? null,
            balanceCostAmount: effectiveBalanceCost.toString(),
            profitAmount: profitAmount.toString(),
            lockReleased: release.released
          },
          operator
        );
        return {
          orderId: order.id,
          reversalLedger,
          balanceRestored: restoreBalance,
          lockReleased: release.released,
          idempotentReplay: false
        };
      },
      '订单已经退款或消费撤销正在并发处理，请刷新后核对'
    );

    return this.support.buildLifecycleResponse(result);
  }

  remove(orderIdValue: string, dto: DeleteIdBusinessV2OrderDto, operator?: AuthenticatedUser) {
    return this.support.remove(orderIdValue, dto, operator);
  }
}
