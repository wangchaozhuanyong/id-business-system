import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { IdBusinessV2BalanceCalculatorService } from '../balances/public-api';
import { IdBusinessV2FinancePostingService } from '../finance/public-api';
import { Amount4, V2CommandTransactionManager } from '../runtime/public-api';
import type { CancelIdBusinessV2OrderDto } from './dto/cancel-id-business-v2-order.dto';
import type { DeleteIdBusinessV2OrderDto } from './dto/delete-id-business-v2-order.dto';
import type { RecoverIdBusinessV2SoldAccountDto } from './dto/recover-id-business-v2-sold-account.dto';
import type { RefundIdBusinessV2OrderDto } from './dto/refund-id-business-v2-order.dto';
import type { UpdateIdBusinessV2OrderDto } from './dto/update-id-business-v2-order.dto';
import {
  applyUpdatedOrderAccountDisposition,
  normalizeOrderAccountDisposition
} from './id-business-v2-order-account-disposition';
import { cancelIdBusinessV2Order } from './id-business-v2-order-cancel';
import { IdBusinessV2OrderLockService } from './id-business-v2-order-lock.service';
import { IdBusinessV2OrdersService } from './id-business-v2-orders.service';
import { IdBusinessV2OrderLifecycleSupport } from './id-business-v2-order-lifecycle-support';
import { refundIdBusinessV2Order } from './id-business-v2-order-refund';
import type { IdBusinessV2OrderStatus } from './id-business-v2-order.types';
import { IdBusinessV2OrdersRepository } from './persistence/id-business-v2-orders.repository';
import {
  buildSoldAccountRecoveryPreview,
  recoverIdBusinessV2SoldAccount
} from './id-business-v2-order-sold-account-recovery';

const FULLY_EDITABLE_STATUSES = new Set<IdBusinessV2OrderStatus>(['draft', 'pending']);
const EDITABLE_STATUSES = new Set<IdBusinessV2OrderStatus>([
  'draft',
  'pending',
  'processing',
  'completed',
  'failed'
]);
@Injectable()
export class IdBusinessV2OrderLifecycleService {
  private readonly support: IdBusinessV2OrderLifecycleSupport;

  constructor(
    private readonly fieldEncryptionService: FieldEncryptionService,
    private readonly balanceCalculator: IdBusinessV2BalanceCalculatorService,
    private readonly orderLockService: IdBusinessV2OrderLockService,
    private readonly ordersService: IdBusinessV2OrdersService,
    private readonly financePostingService: IdBusinessV2FinancePostingService,
    transactionManager: V2CommandTransactionManager,
    private readonly repository: IdBusinessV2OrdersRepository
  ) {
    this.support = new IdBusinessV2OrderLifecycleSupport(
      fieldEncryptionService,
      balanceCalculator,
      orderLockService,
      ordersService,
      transactionManager,
      repository
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

    await this.support.runLifecycleTransaction(
      async (tx) => {
        const order = await this.support.lockOrder(tx, orderId);
        if (order.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
          throw new ConflictException('订单已被其他操作修改，请刷新后重新编辑');
        }
        if (!EDITABLE_STATUSES.has(order.status)) {
          throw new ConflictException('当前订单状态不能修改');
        }
        const immutableReceiptEvidenceRequested = [
          dto.receivedCurrency,
          dto.receivedFxRateToCny,
          dto.receivedFxSnapshotId,
          dto.receivedManualRateReason
        ].some((value) => value !== undefined);
        if (immutableReceiptEvidenceRequested) {
          throw new ConflictException('原币金额、币种和汇率快照只能在订单录入时确定');
        }
        const pricingEvidenceRequested = [
          dto.receivedAmount,
          dto.receivedOriginalAmount,
          dto.settlementPlatformOptionId,
          dto.platformOrderNo
        ].some((value) => value !== undefined);
        if (
          pricingEvidenceRequested &&
          (order.status === 'completed' || order.status === 'refunded')
        ) {
          throw new ConflictException(
            '已完成或已退款订单的价格和结算平台不可直接修改，请冲销并重记'
          );
        }
        if (dto.receivedAmount !== undefined && order.receivedCurrency !== 'CNY') {
          throw new ConflictException('非人民币订单请修改原币实收，人民币折算将沿用锁定汇率');
        }

        const [consumption, activation, activeLock] = await Promise.all([
          this.support.findConsumption(tx, order.id),
          this.repository.hasActivationByOrder(tx, order.id),
          this.repository.findActiveLockForOrder(tx, order.id)
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
        const accountSource = this.support.normalizeAccountSource(
          dto.accountSource,
          order.accountSource
        );
        const accountDisposition =
          accountSource === 'customer_owned'
            ? 'retained'
            : dto.accountDisposition === undefined
              ? order.accountDisposition
              : normalizeOrderAccountDisposition(dto.accountDisposition);
        if (
          order.accountDisposition === 'sold' &&
          (customerId !== order.customerId ||
            accountId !== order.accountId ||
            accountSource !== order.accountSource ||
            accountDisposition !== 'sold')
        ) {
          throw new ConflictException('已售出 ID 请从 ID 管理执行“纠正售出”');
        }
        const sourceSoldOrderId = await this.support.resolveUpdatedAccountSource(
          tx,
          order.id,
          accountId,
          customerId,
          accountSource
        );
        const settlementPlatformOptionId =
          dto.settlementPlatformOptionId === undefined
            ? order.settlementPlatformOptionId
            : this.support.normalizeOptionalUuid(dto.settlementPlatformOptionId, '结算平台');
        if (dto.settlementPlatformOptionId !== undefined && !settlementPlatformOptionId) {
          throw new BadRequestException('结算平台不能为空');
        }
        const platformOrderNo =
          dto.platformOrderNo === undefined
            ? order.platformOrderNo
            : this.support.normalizeOptionalString(dto.platformOrderNo, '平台订单号', 160);
        if (platformOrderNo && !settlementPlatformOptionId) {
          throw new BadRequestException('填写平台订单号时必须选择结算平台');
        }

        const requestedOriginalAmount =
          dto.receivedOriginalAmount === undefined
            ? null
            : this.support.normalizeAmount(dto.receivedOriginalAmount, '原币实收', true);
        const receivedAmount = requestedOriginalAmount
          ? order.receivedFxRateToCny.apply(requestedOriginalAmount)
          : dto.receivedAmount === undefined
            ? order.receivedAmount
            : this.support.normalizeAmount(dto.receivedAmount, '实收金额', true);
        const receivedOriginalAmount =
          requestedOriginalAmount ??
          (dto.receivedAmount !== undefined && order.receivedCurrency === 'CNY'
            ? receivedAmount
            : order.receivedOriginalAmount);
        if (
          (dto.receivedAmount !== undefined || dto.receivedOriginalAmount !== undefined) &&
          !settlementPlatformOptionId
        ) {
          throw new BadRequestException('修改实收金额前必须先选择结算平台');
        }
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

        const requestedLockScope =
          dto.lockScope === undefined
            ? (activeLock?.lockScope ?? 'by_service')
            : this.support.normalizeLockScope(dto.lockScope);
        const lockScope =
          accountSource === 'customer_owned'
            ? 'by_service'
            : accountDisposition === 'sold'
              ? 'global'
              : requestedLockScope;
        const reservationChanged =
          order.serviceOptionId !== serviceOptionId ||
          order.accountId !== accountId ||
          order.accountSource !== accountSource ||
          order.sourceSoldOrderId !== sourceSoldOrderId ||
          order.accountDisposition !== accountDisposition ||
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
        const accountCostAmount = await applyUpdatedOrderAccountDisposition(
          tx,
          this.repository,
          { ...order, accountSource },
          accountId,
          accountDisposition,
          operator
        );
        const appliedAccountCostAmount =
          accountSource === 'inventory' && accountDisposition === 'sold'
            ? accountCostAmount
            : Amount4.zero();
        const profitAmount = consumption
          ? this.support.calculateProfit(
              receivedAmount,
              platformFeeAmount,
              appliedAccountCostAmount,
              order.appliedBalanceCostAmount,
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

        await this.repository.updateOrder(tx, order.id, {
          customerId,
          serviceOptionId,
          accountId,
          accountSource,
          sourceSoldOrderId,
          settlementPlatformOptionId,
          platformOrderNo,
          websiteAccountEncrypted: website.encrypted,
          websiteAccountHash: website.hash,
          websiteAccountMasked: website.masked,
          receivedAmount: receivedAmount.toString(),
          receivedOriginalAmount: receivedOriginalAmount.toString(),
          platformFeeAmount: platformFeeAmount.toString(),
          balanceAmount: balanceAmount.toString(),
          accountDisposition,
          accountCostAmount: accountCostAmount.toString(),
          appliedAccountCostAmount: appliedAccountCostAmount.toString(),
          appliedBalanceCostAmount: order.appliedBalanceCostAmount.toString(),
          profitAmount: profitAmount?.toString() ?? null,
          openedAt,
          dueAt,
          remark,
          updatedByUserId: operator?.id
        });

        if (activation && (dto.openedAt !== undefined || dto.dueAt !== undefined)) {
          await this.repository.updateActivation(tx, order.id, {
            openedAt,
            dueAt,
            updatedByUserId: operator?.id
          });
        }

        if (consumedLockExpiryChanged && activeLock) {
          await this.repository.updateAccountLock(tx, activeLock.id, {
            expiresAt: dueAt
          });
          await this.repository.appendAudit(tx, {
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

        await this.repository.appendAudit(tx, {
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
            accountSource,
            sourceSoldOrderId,
            settlementPlatformOptionId,
            platformOrderNo,
            websiteAccountMasked: website.masked,
            receivedAmount: receivedAmount.toString(),
            receivedOriginalAmount: receivedOriginalAmount.toString(),
            receivedCurrency: order.receivedCurrency,
            receivedFxRateToCny: order.receivedFxRateToCny.toString(),
            receivedFxSnapshotId: order.receivedFxSnapshotId,
            platformFeeAmount: platformFeeAmount.toString(),
            balanceAmount: balanceAmount.toString(),
            accountDisposition,
            accountCostAmount: accountCostAmount.toString(),
            appliedAccountCostAmount: appliedAccountCostAmount.toString(),
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
        });
      },
      '平台订单号已存在或订单刚被其他请求修改',
      operator
    );

    return this.ordersService.get(orderId);
  }

  cancel(orderIdValue: string, dto: CancelIdBusinessV2OrderDto, operator?: AuthenticatedUser) {
    return cancelIdBusinessV2Order(
      this.support,
      this.orderLockService,
      this.financePostingService,
      this.repository,
      orderIdValue,
      dto,
      operator
    );
  }
  refund(orderIdValue: string, dto: RefundIdBusinessV2OrderDto, operator?: AuthenticatedUser) {
    return refundIdBusinessV2Order(
      this.support,
      this.orderLockService,
      this.financePostingService,
      this.repository,
      orderIdValue,
      dto,
      operator
    );
  }
  async previewSoldAccountRecovery(orderIdValue: string, accountIdValue: string) {
    const orderId = this.support.normalizeUuid(orderIdValue, '订单');
    const accountId = this.support.normalizeUuid(accountIdValue, 'ID');
    return this.support.runLifecycleTransaction(async (tx) => {
      const order = await this.support.lockOrder(tx, orderId);
      if (order.accountId !== accountId || order.accountDisposition !== 'sold') {
        throw new ConflictException('该 ID 与已售订单归属不一致，请刷新后核对');
      }
      const account = await this.repository.lockAccountForSale(tx, accountId);
      if (!account || account.soldByOrderId !== order.id) {
        throw new ConflictException('ID 售出关联已变化，请刷新后核对');
      }
      const blockers = await this.repository.findSoldAccountRecoveryBlockers(tx, {
        accountId,
        sourceOrderId: order.id,
        evaluatedAt: new Date()
      });
      return buildSoldAccountRecoveryPreview({ ...account, ...blockers });
    }, 'ID 售出状态已被其他操作修改，请刷新后核对');
  }

  recoverSoldAccount(
    orderIdValue: string,
    dto: RecoverIdBusinessV2SoldAccountDto,
    operator?: AuthenticatedUser
  ) {
    return recoverIdBusinessV2SoldAccount(
      this.support,
      this.orderLockService,
      this.financePostingService,
      this.repository,
      orderIdValue,
      dto,
      operator
    );
  }

  remove(orderIdValue: string, dto: DeleteIdBusinessV2OrderDto, operator?: AuthenticatedUser) {
    return this.support.remove(orderIdValue, dto, operator);
  }
}
