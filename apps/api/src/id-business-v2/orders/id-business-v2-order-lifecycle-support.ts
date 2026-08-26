import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import type { IdBusinessV2BalanceCalculatorService } from '../balances/public-api';
import {
  Amount4,
  Rate8,
  V2_DECIMAL_PATTERN,
  V2_DECIMAL_PLACES,
  V2CommandTransactionManager,
  buildIdBusinessV2BlindIndexTokens,
  toV2JsonDocument,
  type V2CommandTransaction,
  type V2DecimalInput
} from '../runtime/public-api';
import type { DeleteIdBusinessV2OrderDto } from './dto/delete-id-business-v2-order.dto';
import type { UpdateIdBusinessV2OrderDto } from './dto/update-id-business-v2-order.dto';
import type { IdBusinessV2OrderLockService } from './id-business-v2-order-lock.service';
import type { IdBusinessV2OrdersService } from './id-business-v2-orders.service';
import { maskWebsiteAccount } from './id-business-v2-order-entry-support';
import { toOrderReversalLedgerResponse } from './id-business-v2-order-lifecycle-input';
import { IdBusinessV2OrdersRepository } from './persistence/id-business-v2-orders.repository';
import type {
  IdBusinessV2AccountLockScope,
  IdBusinessV2BalanceLedgerRecord,
  IdBusinessV2OrderAccountSource,
  IdBusinessV2OrderRecord
} from './id-business-v2-order.types';

export interface LifecycleTransactionResult {
  orderId: string;
  reversalLedger: IdBusinessV2BalanceLedgerRecord | null;
  balanceRestored: boolean;
  lockReleased: boolean;
  idempotentReplay: boolean;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,100}$/;
const MAX_AMOUNT = Amount4.from('99999999999999.9999');
const DELETABLE_STATUSES = new Set(['refunded', 'cancelled', 'failed']);

export class IdBusinessV2OrderLifecycleSupport {
  constructor(
    private readonly fieldEncryptionService: FieldEncryptionService,
    private readonly balanceCalculator: IdBusinessV2BalanceCalculatorService,
    private readonly orderLockService: IdBusinessV2OrderLockService,
    private readonly ordersService: IdBusinessV2OrdersService,
    private readonly transactionManager: V2CommandTransactionManager,
    private readonly repository: IdBusinessV2OrdersRepository
  ) {}

  async remove(
    orderIdValue: string,
    dto: DeleteIdBusinessV2OrderDto,
    operator?: AuthenticatedUser
  ) {
    const orderId = this.normalizeUuid(orderIdValue, '订单');
    const reason = this.normalizeReason(dto.reason);

    return this.transactionManager.execute(
      async (tx) => {
        const order = await this.lockOrder(tx, orderId, true);
        if (order.deletedAt) {
          return {
            deleted: true,
            idempotentReplay: true
          };
        }
        if (!DELETABLE_STATUSES.has(order.status)) {
          throw new ConflictException('只有已退款、已取消或失败订单可以删除');
        }

        const release = await this.orderLockService.releaseOrderLockInTransaction(
          tx,
          order.id,
          `订单软删除：${reason}`,
          operator
        );
        const deletedAt = new Date();
        await this.repository.updateOrder(tx, order.id, {
          deletedAt,
          updatedByUserId: operator?.id
        });
        await this.writeLifecycleAudit(
          tx,
          'delete',
          order,
          {
            deletedAt,
            reason,
            lockReleased: release.released,
            dataPreserved: true
          },
          operator
        );
        return {
          deleted: true,
          idempotentReplay: false
        };
      },
      {
        requestId: randomUUID(),
        operator,
        retryMode: 'none'
      }
    );
  }

  async runLifecycleTransaction<T>(
    callback: (tx: V2CommandTransaction) => Promise<T>,
    conflictMessage: string,
    operator?: AuthenticatedUser
  ) {
    return this.transactionManager.execute(callback, {
      requestId: randomUUID(),
      operator,
      retryMode: 'none',
      uniqueConflictMessage: conflictMessage,
      writeConflictMessage: conflictMessage
    });
  }

  async buildLifecycleResponse(result: LifecycleTransactionResult) {
    return {
      order: await this.ordersService.get(result.orderId),
      reversalLedger: result.reversalLedger
        ? this.toReversalLedgerResponse(result.reversalLedger)
        : null,
      balanceRestored: result.balanceRestored,
      lockReleased: result.lockReleased,
      idempotentReplay: result.idempotentReplay
    };
  }

  async restoreConsumption(
    tx: V2CommandTransaction,
    order: IdBusinessV2OrderRecord,
    consumption: IdBusinessV2BalanceLedgerRecord,
    idempotencyKey: string,
    remark: string,
    operator?: AuthenticatedUser,
    requestedBalanceAmount?: Amount4,
    requestedCostAmount?: Amount4
  ) {
    if (!order.accountId || consumption.accountId !== order.accountId) {
      throw new ConflictException('订单消费流水与绑定 ID 不一致，不能恢复余额');
    }
    if (
      consumption.entryType !== 'order_consumption' ||
      consumption.direction !== 'debit' ||
      consumption.reversalOfEntryId !== null
    ) {
      throw new ConflictException('订单原消费流水证据无效，不能恢复余额');
    }

    const account = await this.lockAccount(tx, order.accountId);
    if (account.lossReportedAt) {
      throw new ConflictException('已报损冻结 ID 不能恢复余额');
    }
    if (order.accountSource === 'customer_owned') {
      if (!order.sourceSoldOrderId) {
        throw new ConflictException('客户已购 ID 订单缺少来源销售记录，不能恢复余额');
      }
      const ownedBySourceSale = account.soldByOrderId === order.sourceSoldOrderId;
      const ownedByRecoveredSource =
        account.soldByOrderId === null &&
        Boolean(
          await this.repository.findRecoveredCustomerOwnedSource(tx, {
            sourceOrderId: order.sourceSoldOrderId,
            accountId: account.id,
            customerId: order.customerId
          })
        );
      if (!ownedBySourceSale && !ownedByRecoveredSource) {
        throw new ConflictException('该 ID 已转售或归属已变化，订单只能退款，不能恢复 ID 余额');
      }
    }
    const balanceAmount = requestedBalanceAmount ?? consumption.balanceAmount;
    if (balanceAmount.gt(consumption.balanceAmount)) {
      throw new BadRequestException('退回 ID 余额不能超过本单原消费余额');
    }
    const costAmount =
      requestedCostAmount ??
      (balanceAmount.equals(consumption.balanceAmount)
        ? consumption.costAmount
        : consumption.costAmount.ratio(consumption.balanceAmount).apply(balanceAmount));
    if (costAmount.gt(consumption.costAmount)) {
      throw new BadRequestException('恢复人民币成本不能超过本单原消费成本');
    }
    const movement = this.balanceCalculator.calculateReversalCredit(
      {
        currentBalance: account.currentBalance,
        balanceCostAmount: account.balanceCostAmount
      },
      balanceAmount,
      costAmount
    );
    const ledger = await this.repository.createBalanceLedger(tx, {
      accountId: account.id,
      giftCardId: null,
      orderId: order.id,
      entryType: 'order_consumption_reversal',
      direction: 'credit',
      balanceAmount: movement.balanceAmount.toString(),
      costAmount: movement.costAmount.toString(),
      balanceBefore: movement.balanceBefore.toString(),
      balanceAfter: movement.balanceAfter.toString(),
      costBefore: movement.costBefore.toString(),
      costAfter: movement.costAfter.toString(),
      averageCostBefore: movement.averageCostBefore.toString(),
      averageCostAfter: movement.averageCostAfter.toString(),
      reversalOfEntryId: consumption.id,
      idempotencyKey,
      remark,
      createdByUserId: operator?.id
    });
    await this.repository.updateAccount(tx, account.id, {
      currentBalance: movement.balanceAfter.toString(),
      balanceCostAmount: movement.costAfter.toString(),
      updatedByUserId: operator?.id
    });
    return {
      account,
      ledger
    };
  }

  async lockOrder(tx: V2CommandTransaction, orderId: string, includeDeleted = false) {
    if (!(await this.repository.lockOrderId(tx, orderId, includeDeleted))) {
      throw new NotFoundException('订单不存在或已删除');
    }
    const order = await this.repository.findOrderInTransaction(tx, orderId);
    if (!order || (!includeDeleted && order.deletedAt)) {
      throw new NotFoundException('订单不存在或已删除');
    }
    return order;
  }

  async lockAccount(tx: V2CommandTransaction, accountId: string) {
    const account = await this.repository.lockOrderBalanceAccount(tx, accountId);
    if (!account) {
      throw new NotFoundException('订单绑定的 ID 不存在或已删除');
    }
    return account;
  }

  findConsumption(tx: V2CommandTransaction, orderId: string) {
    return this.repository.findLedgerByOrderAndType(tx, orderId, 'order_consumption');
  }

  findReversal(tx: V2CommandTransaction, orderId: string) {
    return this.repository.findLedgerByOrderAndType(tx, orderId, 'order_consumption_reversal');
  }

  assertReversalReplay(reversal: IdBusinessV2BalanceLedgerRecord | null, idempotencyKey: string) {
    if (reversal && reversal.idempotencyKey !== idempotencyKey) {
      throw new ConflictException('订单已经使用其他请求撤销消费，请刷新后核对');
    }
  }

  async assertActiveCustomer(tx: V2CommandTransaction, customerId: string) {
    const customer = await this.repository.findActiveCustomer(tx, customerId);
    if (!customer) {
      throw new BadRequestException('客户不存在、已停用或已删除');
    }
  }

  async assertActiveService(tx: V2CommandTransaction, serviceOptionId: string) {
    const service = await this.repository.findActiveService(tx, serviceOptionId);
    if (!service) {
      throw new BadRequestException('业务不存在或已停用');
    }
  }

  async resolveSettlementPlatform(
    tx: V2CommandTransaction,
    platformId: string | null,
    allowDisabledExisting: boolean
  ) {
    if (!platformId) return null;
    const platform = await this.repository.findSettlementPlatform(
      tx,
      platformId,
      allowDisabledExisting
    );
    if (!platform) {
      throw new BadRequestException('结算平台不存在、已停用或已删除');
    }
    return platform;
  }

  calculatePlatformFee(
    receivedAmount: V2DecimalInput,
    platform: {
      fixedFee: V2DecimalInput;
      percentageFee: V2DecimalInput;
    } | null
  ) {
    if (!platform) return Amount4.zero();
    const normalizedReceivedAmount = Amount4.from(receivedAmount);
    const percentage = Rate8.from(platform.percentageFee).div(100);
    const fee = Amount4.from(platform.fixedFee).add(percentage.apply(normalizedReceivedAmount));
    if (fee.gt(MAX_AMOUNT)) {
      throw new BadRequestException('平台手续费数值过大');
    }
    return fee;
  }

  calculateProfit(
    receivedAmount: V2DecimalInput,
    platformFeeAmount: V2DecimalInput,
    accountCostAmount: V2DecimalInput,
    balanceCostAmount: V2DecimalInput,
    refundCostAmount: V2DecimalInput | null
  ) {
    const profit = Amount4.from(receivedAmount)
      .sub(platformFeeAmount)
      .sub(accountCostAmount)
      .sub(balanceCostAmount)
      .sub(refundCostAmount ?? 0);
    if (profit.abs().gt(MAX_AMOUNT)) {
      throw new BadRequestException('订单利润数值超出数据库范围');
    }
    return profit;
  }

  resolveWebsiteAccount(dto: UpdateIdBusinessV2OrderDto, order: IdBusinessV2OrderRecord) {
    if (dto.clearWebsiteAccount && dto.websiteAccount !== undefined) {
      const normalized = this.normalizeOptionalString(dto.websiteAccount, '客户网站账号', 255);
      if (normalized) {
        throw new BadRequestException('清空网站账号时不能同时填写新账号');
      }
    }
    if (dto.clearWebsiteAccount) {
      return {
        encrypted: null,
        hash: null,
        masked: null,
        searchTokens: []
      };
    }
    if (dto.websiteAccount === undefined) {
      return {
        encrypted: order.websiteAccountEncrypted,
        hash: order.websiteAccountHash,
        masked: order.websiteAccountMasked,
        searchTokens: order.websiteAccountSearchTokens
      };
    }
    const value = this.normalizeOptionalString(dto.websiteAccount, '客户网站账号', 255);
    return {
      encrypted: this.fieldEncryptionService.encrypt(value),
      hash: this.fieldEncryptionService.hash(value),
      masked: maskWebsiteAccount(value),
      searchTokens: buildIdBusinessV2BlindIndexTokens(value, 'website-account', (token) =>
        this.fieldEncryptionService.hash(token)
      )
    };
  }

  async writeLifecycleAudit(
    tx: V2CommandTransaction,
    action: 'cancel' | 'refund' | 'delete',
    order: IdBusinessV2OrderRecord,
    afterData: unknown,
    operator?: AuthenticatedUser
  ) {
    const labels = {
      cancel: '取消',
      refund: '退款',
      delete: '软删除'
    };
    await this.repository.appendAudit(tx, {
      userId: operator?.id,
      module: 'id_business_v2',
      action: `id_business_v2.order.${action}`,
      objectType: 'id_business_v2_order',
      objectId: order.id,
      beforeData: this.toOrderAuditSnapshot(order),
      afterData: toV2JsonDocument(afterData),
      remark: `${labels[action]} V2 订单：${order.orderNo}`
    });
  }

  toOrderAuditSnapshot(order: IdBusinessV2OrderRecord) {
    return toV2JsonDocument({
      orderNo: order.orderNo,
      customerId: order.customerId,
      serviceOptionId: order.serviceOptionId,
      accountId: order.accountId,
      settlementPlatformOptionId: order.settlementPlatformOptionId,
      platformOrderNo: order.platformOrderNo,
      websiteAccountMasked: order.websiteAccountMasked,
      receivedAmount: order.receivedAmount.toString(),
      platformFeeAmount: order.platformFeeAmount.toString(),
      accountSource: order.accountSource,
      sourceSoldOrderId: order.sourceSoldOrderId,
      accountDisposition: order.accountDisposition,
      accountCostAmount: order.accountCostAmount.toString(),
      appliedAccountCostAmount: order.appliedAccountCostAmount.toString(),
      balanceAmount: order.balanceAmount.toString(),
      balanceCostAmount: order.balanceCostAmount.toString(),
      refundCostAmount: order.refundCostAmount?.toString() ?? null,
      profitAmount: order.profitAmount?.toString() ?? null,
      openedAt: order.openedAt,
      dueAt: order.dueAt,
      remark: order.remark,
      status: order.status,
      statusChangedAt: order.statusChangedAt,
      deletedAt: order.deletedAt
    });
  }

  toReversalLedgerResponse(entry: IdBusinessV2BalanceLedgerRecord) {
    return toOrderReversalLedgerResponse(entry);
  }

  assertUpdateHasChanges(dto: UpdateIdBusinessV2OrderDto) {
    const mutableKeys: Array<keyof UpdateIdBusinessV2OrderDto> = [
      'customerId',
      'serviceOptionId',
      'accountId',
      'accountSource',
      'settlementPlatformOptionId',
      'platformOrderNo',
      'websiteAccount',
      'clearWebsiteAccount',
      'receivedAmount',
      'receivedOriginalAmount',
      'receivedCurrency',
      'receivedFxRateToCny',
      'receivedFxSnapshotId',
      'receivedManualRateReason',
      'balanceAmount',
      'accountDisposition',
      'openedAt',
      'dueAt',
      'lockScope',
      'remark'
    ];
    if (!mutableKeys.some((key) => dto[key] !== undefined)) {
      throw new BadRequestException('至少填写一个需要修改的订单字段');
    }
  }

  hasCoreFieldChanges(dto: UpdateIdBusinessV2OrderDto) {
    return [
      dto.customerId,
      dto.serviceOptionId,
      dto.accountId,
      dto.accountSource,
      dto.balanceAmount,
      dto.accountDisposition,
      dto.lockScope
    ].some((value) => value !== undefined);
  }

  normalizeAccountSource(
    value: unknown,
    fallback: IdBusinessV2OrderAccountSource
  ): IdBusinessV2OrderAccountSource {
    if (value === undefined || value === null || value === '') return fallback;
    if (value === 'inventory' || value === 'customer_owned') return value;
    throw new BadRequestException('ID 来源无效');
  }

  async resolveUpdatedAccountSource(
    tx: V2CommandTransaction,
    orderId: string,
    accountId: string,
    customerId: string,
    accountSource: IdBusinessV2OrderAccountSource
  ) {
    const ownership = await this.repository.findSoldAccountOwnership(tx, accountId);
    if (accountSource === 'inventory') {
      if (ownership?.soldByOrder && ownership.soldByOrder.id !== orderId) {
        throw new ConflictException('该 ID 已售出，请使用客户已购 ID 模式');
      }
      return null;
    }
    if (!ownership?.soldByOrder || ownership.soldByOrder.deletedAt) {
      throw new ConflictException('客户已购 ID 缺少有效的原销售订单');
    }
    if (ownership.soldByOrder.id === orderId) {
      throw new ConflictException('订单不能把自身作为原销售订单');
    }
    if (ownership.soldByOrder.customerId !== customerId) {
      throw new ConflictException('该 ID 不属于当前客户');
    }
    return ownership.soldByOrder.id;
  }

  normalizeUuid(value: unknown, label: string) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!UUID_PATTERN.test(normalized)) {
      throw new BadRequestException(`${label}格式无效`);
    }
    return normalized;
  }

  normalizeOptionalUuid(value: unknown, label: string) {
    if (value === undefined || value === null || value === '') return null;
    return this.normalizeUuid(value, label);
  }

  normalizeOptionalString(value: unknown, label: string, maxLength: number) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new BadRequestException(`${label}格式无效`);
    }
    const normalized = String(value).trim();
    if (normalized.length > maxLength) {
      throw new BadRequestException(`${label}不能超过 ${maxLength} 个字符`);
    }
    return normalized || null;
  }

  normalizeAmount(value: unknown, label: string, allowZero: boolean) {
    const normalized =
      typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
    if (!V2_DECIMAL_PATTERN.test(normalized)) {
      throw new BadRequestException(`${label}必须是最多 ${V2_DECIMAL_PLACES} 位小数的非负数`);
    }
    const amount = Amount4.from(normalized);
    if ((!allowZero && amount.lte(0)) || (allowZero && amount.lt(0))) {
      throw new BadRequestException(`${label}${allowZero ? '不能为负数' : '必须大于 0'}`);
    }
    if (amount.gt(MAX_AMOUNT)) {
      throw new BadRequestException(`${label}数值过大`);
    }
    return amount;
  }

  normalizeDate(value: unknown, label: string) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new BadRequestException(`${label}不能为空`);
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException(`${label}格式无效`);
    }
    return date;
  }

  normalizeLockScope(value: unknown): IdBusinessV2AccountLockScope {
    if (value === 'by_service' || value === 'global') {
      return value;
    }
    throw new BadRequestException('锁定范围无效');
  }

  normalizeReason(value: unknown) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (normalized.length < 2 || normalized.length > 500) {
      throw new BadRequestException('操作原因必须为 2 至 500 个字符');
    }
    return normalized;
  }

  normalizeIdempotencyKey(value: unknown) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!IDEMPOTENCY_KEY_PATTERN.test(normalized)) {
      throw new BadRequestException('幂等键必须是 8 至 100 位字母、数字或 ._:-');
    }
    return normalized;
  }
}
