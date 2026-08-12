import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import {
  IdBusinessV2FinanceFxService,
  normalizeFinanceCurrency,
  normalizeFinanceMoney,
  normalizeFinanceRate
} from '../finance/public-api';
import {
  Amount4,
  Rate8,
  V2CommandTransactionManager,
  type V2CommandTransaction,
  type V2DecimalInput
} from '../runtime/public-api';
import type { CreateIdBusinessV2OrderDto } from './dto/create-id-business-v2-order.dto';
import type { QuoteIdBusinessV2OrderReceiptFxDto } from './dto/quote-id-business-v2-order-receipt-fx.dto';
import { applyNewOrderAccountDisposition } from './id-business-v2-order-account-disposition';
import { IdBusinessV2OrderLockService } from './id-business-v2-order-lock.service';
import { getIdBusinessV2OrderEntryOptions } from './id-business-v2-order-entry-options';
import { IdBusinessV2OrdersService } from './id-business-v2-orders.service';
import { IdBusinessV2OrdersRepository } from './persistence/id-business-v2-orders.repository';
import {
  assertOrderEntryReplayMatches,
  calculatePlatformFee,
  generateOrderNo,
  maskWebsiteAccount,
  normalizeCreateOrderInput,
  toOrderEntryLockSummary,
  writeOrderEntryAuditLog,
  type OrderEntryLockSummary
} from './id-business-v2-order-entry-support';

export interface CreateWaitingExternalOrderInput {
  customerId: string;
  serviceOptionId: string;
  accountId: string;
  settlementPlatformOptionId: string;
  platformOrderNo: string | null;
  websiteAccountEncrypted: string | null;
  websiteAccountHash: string | null;
  websiteAccountMasked: string | null;
  receivedAmount: V2DecimalInput;
  balanceAmount: V2DecimalInput;
  openedAt: Date;
  dueAt: Date;
  idempotencyKey: string;
  remark: string | null;
  sourceActivationId: string;
}

export interface CreateManualRenewalOrderInput {
  customerId: string;
  serviceOptionId: string;
  accountId: string;
  settlementPlatformOptionId: string;
  platformOrderNo: string | null;
  websiteAccountEncrypted: string | null;
  websiteAccountHash: string | null;
  websiteAccountMasked: string | null;
  receivedAmount: V2DecimalInput;
  balanceAmount: V2DecimalInput;
  openedAt: Date;
  dueAt: Date;
  idempotencyKey: string;
  remark: string | null;
  accountSource?: 'inventory' | 'customer_owned';
}

@Injectable()
export class IdBusinessV2OrderEntryService {
  constructor(
    private readonly repository: IdBusinessV2OrdersRepository,
    private readonly fieldEncryptionService: FieldEncryptionService,
    private readonly ordersService: IdBusinessV2OrdersService,
    private readonly orderLockService: IdBusinessV2OrderLockService,
    private readonly financeFxService: IdBusinessV2FinanceFxService,
    private readonly transactionManager: V2CommandTransactionManager
  ) {}

  async getEntryOptions(customerKeywordValue?: string) {
    const [options, latestFxRates] = await Promise.all([
      getIdBusinessV2OrderEntryOptions(
        this.repository,
        this.fieldEncryptionService,
        customerKeywordValue
      ),
      this.financeFxService.listLatest()
    ]);
    return {
      ...options,
      latestFxRates: latestFxRates.items
    };
  }

  quoteReceiptFx(dto: QuoteIdBusinessV2OrderReceiptFxDto, operator?: AuthenticatedUser) {
    const currency = normalizeFinanceCurrency(dto.currency, '收款币种');
    return this.financeFxService.quoteOrderRate(currency, operator);
  }

  async create(dto: CreateIdBusinessV2OrderDto, operator?: AuthenticatedUser) {
    const orderTimestamp = new Date();
    const receivedCurrency = normalizeFinanceCurrency(dto.receivedCurrency ?? 'CNY', '收款币种');
    if (dto.receivedOriginalAmount === undefined && dto.receivedAmount === undefined) {
      throw new BadRequestException('原币收款金额不能为空');
    }
    const receivedOriginalAmount = Amount4.from(
      dto.receivedOriginalAmount === undefined
        ? normalizeFinanceMoney(dto.receivedAmount, '实收金额', true)
        : normalizeFinanceMoney(dto.receivedOriginalAmount, '原币收款金额', true)
    );
    const inputBeforeRate = normalizeCreateOrderInput(
      {
        ...dto,
        receivedAmount: dto.receivedAmount ?? receivedOriginalAmount.toString()
      },
      (value) => this.fieldEncryptionService.hash(value)
    );
    const manualRate =
      dto.receivedFxRateToCny === undefined
        ? null
        : Rate8.from(normalizeFinanceRate(dto.receivedFxRateToCny, receivedCurrency));
    const receiptRate = await this.financeFxService.resolve({
      currency: receivedCurrency,
      occurredAt: orderTimestamp,
      fxRateSnapshotId: dto.receivedFxSnapshotId,
      manualRate,
      manualReason: dto.receivedManualRateReason,
      operator
    });
    const receiptFxRate = Rate8.from(receiptRate.rateToCny);
    const derivedReceivedAmount = receiptFxRate.apply(receivedOriginalAmount);
    if (
      dto.receivedAmount !== undefined &&
      !derivedReceivedAmount.equals(inputBeforeRate.receivedAmount)
    ) {
      throw new BadRequestException('人民币实收与原币金额、交易汇率计算结果不一致');
    }
    const input =
      dto.receivedAmount === undefined
        ? normalizeCreateOrderInput(
            {
              ...dto,
              receivedAmount: derivedReceivedAmount.toString()
            },
            (value) => this.fieldEncryptionService.hash(value)
          )
        : inputBeforeRate;
    type TransactionResult = {
      orderId: string;
      lock: OrderEntryLockSummary | null;
      idempotentReplay: boolean;
    };
    const verifyReplay = async (tx: V2CommandTransaction): Promise<TransactionResult> => {
      const existing = await this.repository.findOrderEntryReplay(tx, input.idempotencyKey);
      if (!existing) {
        throw new ConflictException('平台订单号已存在或订单刚被其他请求创建，请刷新后核对');
      }
      assertOrderEntryReplayMatches(existing, existing.locks[0] ?? null, input);
      if (
        existing.receivedCurrency !== receivedCurrency ||
        !existing.receivedOriginalAmount.equals(receivedOriginalAmount) ||
        (manualRate !== null && !existing.receivedFxRateToCny.equals(manualRate))
      ) {
        throw new ConflictException('幂等键已用于其他收款证据');
      }
      return {
        orderId: existing.id,
        lock: toOrderEntryLockSummary(existing.locks[0] ?? null),
        idempotentReplay: true
      };
    };

    const transactionResult = await this.transactionManager.execute<TransactionResult>(
      async (tx) => {
        const existing = await this.repository.findOrderEntryReplay(tx, input.idempotencyKey);
        if (existing) {
          return verifyReplay(tx);
        }

        await this.assertActiveCustomer(tx, input.customerId);
        await this.assertActiveService(tx, input.serviceOptionId);
        const sourceSoldOrderId = await this.resolveAccountSource(
          tx,
          input.accountId,
          input.customerId,
          input.accountSource
        );
        const settlementPlatform = await this.resolveSettlementPlatform(
          tx,
          input.settlementPlatformOptionId
        );
        const platformFeeAmount = calculatePlatformFee(input.receivedAmount, settlementPlatform);
        const order = await this.repository.createOrder(tx, {
          orderNo: generateOrderNo(),
          customerId: input.customerId,
          serviceOptionId: input.serviceOptionId,
          accountId: null,
          settlementPlatformOptionId: input.settlementPlatformOptionId,
          platformOrderNo: input.platformOrderNo,
          websiteAccountEncrypted: this.fieldEncryptionService.encrypt(input.websiteAccount),
          websiteAccountHash: input.websiteAccountHash,
          websiteAccountMasked: maskWebsiteAccount(input.websiteAccount),
          receivedAmount: input.receivedAmount.toString(),
          receivedOriginalAmount: receivedOriginalAmount.toString(),
          receivedCurrency,
          receivedFxRateToCny: receiptFxRate.toString(),
          receivedFxSnapshotId: receiptRate.id,
          receivedFinanceAccountId: null,
          receivedAt: orderTimestamp,
          platformFeeAmount: platformFeeAmount.toString(),
          accountCostAmount: 0,
          appliedAccountCostAmount: 0,
          accountSource: input.accountSource,
          sourceSoldOrderId,
          accountDisposition: input.accountDisposition,
          balanceAmount: input.balanceAmount.toString(),
          balanceCostAmount: 0,
          refundCostAmount: null,
          profitAmount: null,
          status: 'pending',
          openedAt: input.openedAt,
          dueAt: input.dueAt,
          idempotencyKey: input.idempotencyKey,
          remark: input.remark,
          createdByUserId: operator?.id,
          updatedByUserId: operator?.id,
          createdAt: orderTimestamp
        });
        const reservation = await this.orderLockService.reserveAccountForOrderInTransaction(
          tx,
          {
            orderId: order.id,
            accountId: input.accountId,
            expiresAt: input.dueAt,
            lockScope: input.lockScope,
            reason: '订单录入'
          },
          operator
        );
        await applyNewOrderAccountDisposition(
          tx,
          this.repository,
          order.id,
          input.accountId,
          input.accountDisposition,
          input.accountSource,
          operator
        );
        const auditedOrder = await this.repository.requireOrderInTransaction(tx, order.id);

        await writeOrderEntryAuditLog(
          tx,
          this.repository,
          auditedOrder,
          input,
          platformFeeAmount,
          reservation.lock,
          operator
        );
        return {
          orderId: order.id,
          lock: reservation.lock,
          idempotentReplay: false
        };
      },
      {
        requestId: randomUUID(),
        operator,
        businessTime: orderTimestamp,
        retryMode: 'fullReplay',
        idempotencyKey: input.idempotencyKey,
        replay: verifyReplay,
        uniqueConflictMessage: '平台订单号已存在或订单刚被其他请求创建，请刷新后核对'
      }
    );

    return {
      order: await this.ordersService.get(transactionResult.orderId),
      lock: transactionResult.lock,
      idempotentReplay: transactionResult.idempotentReplay,
      nextStep: 'waiting_balance_consumption' as const
    };
  }

  async createWaitingExternalOrderInTransaction(
    tx: V2CommandTransaction,
    input: CreateWaitingExternalOrderInput,
    operator?: AuthenticatedUser
  ) {
    await this.assertActiveCustomer(tx, input.customerId);
    await this.assertActiveService(tx, input.serviceOptionId);
    const settlementPlatform = await this.resolveSettlementPlatform(
      tx,
      input.settlementPlatformOptionId
    );
    const receivedAmount = Amount4.from(input.receivedAmount);
    const balanceAmount = Amount4.from(input.balanceAmount);
    const platformFeeAmount = calculatePlatformFee(receivedAmount, settlementPlatform);
    const sourceSoldOrderId = await this.resolveRenewalAccountSource(
      tx,
      input.accountId,
      input.customerId
    );
    const orderTimestamp = new Date();
    const order = await this.repository.createOrder(tx, {
      orderNo: generateOrderNo(),
      customerId: input.customerId,
      serviceOptionId: input.serviceOptionId,
      accountId: input.accountId,
      settlementPlatformOptionId: input.settlementPlatformOptionId,
      platformOrderNo: input.platformOrderNo,
      websiteAccountEncrypted: input.websiteAccountEncrypted,
      websiteAccountHash: input.websiteAccountHash,
      websiteAccountMasked: input.websiteAccountMasked,
      receivedAmount: receivedAmount.toString(),
      receivedOriginalAmount: receivedAmount.toString(),
      receivedCurrency: 'CNY',
      receivedFxRateToCny: 1,
      receivedFinanceAccountId: null,
      receivedAt: orderTimestamp,
      platformFeeAmount: platformFeeAmount.toString(),
      accountCostAmount: 0,
      appliedAccountCostAmount: 0,
      accountSource: sourceSoldOrderId ? 'customer_owned' : 'inventory',
      sourceSoldOrderId,
      accountDisposition: 'retained',
      balanceAmount: balanceAmount.toString(),
      balanceCostAmount: 0,
      refundCostAmount: null,
      profitAmount: null,
      status: 'waiting_external',
      statusChangedAt: orderTimestamp,
      openedAt: input.openedAt,
      dueAt: input.dueAt,
      idempotencyKey: input.idempotencyKey,
      remark: input.remark,
      createdByUserId: operator?.id,
      updatedByUserId: operator?.id,
      createdAt: orderTimestamp
    });

    await this.repository.appendAudit(tx, {
      userId: operator?.id,
      module: 'id_business_v2',
      action: 'id_business_v2.renewal.open_request.order_create',
      objectType: 'id_business_v2_order',
      objectId: order.id,
      afterData: {
        orderNo: order.orderNo,
        sourceActivationId: input.sourceActivationId,
        customerId: input.customerId,
        serviceOptionId: input.serviceOptionId,
        accountId: input.accountId,
        settlementPlatformOptionId: input.settlementPlatformOptionId,
        platformOrderNo: input.platformOrderNo,
        websiteAccountMasked: input.websiteAccountMasked,
        receivedAmount: receivedAmount.toString(),
        platformFeeAmount: platformFeeAmount.toString(),
        balanceAmount: balanceAmount.toString(),
        openedAt: input.openedAt,
        dueAt: input.dueAt,
        status: 'waiting_external',
        balanceConsumed: false,
        appleOfficialOpenExecuted: false,
        nextStep: 'waiting_apple_execution'
      },
      remark: `创建 V2 续费待执行订单：${order.orderNo}`
    });

    return {
      order,
      platformFeeAmount
    };
  }

  async createManualRenewalOrderInTransaction(
    tx: V2CommandTransaction,
    input: CreateManualRenewalOrderInput,
    operator?: AuthenticatedUser
  ) {
    await this.assertActiveCustomer(tx, input.customerId);
    await this.assertActiveService(tx, input.serviceOptionId);
    const settlementPlatform = await this.resolveSettlementPlatform(
      tx,
      input.settlementPlatformOptionId
    );
    const receivedAmount = Amount4.from(input.receivedAmount);
    const balanceAmount = Amount4.from(input.balanceAmount);
    const platformFeeAmount = calculatePlatformFee(receivedAmount, settlementPlatform);
    const sourceSoldOrderId = await this.resolveAccountSource(
      tx,
      input.accountId,
      input.customerId,
      input.accountSource ?? 'customer_owned'
    );
    const orderTimestamp = new Date();
    const order = await this.repository.createOrder(tx, {
      orderNo: generateOrderNo(),
      customerId: input.customerId,
      serviceOptionId: input.serviceOptionId,
      accountId: input.accountId,
      settlementPlatformOptionId: input.settlementPlatformOptionId,
      platformOrderNo: input.platformOrderNo,
      websiteAccountEncrypted: input.websiteAccountEncrypted,
      websiteAccountHash: input.websiteAccountHash,
      websiteAccountMasked: input.websiteAccountMasked,
      receivedAmount: receivedAmount.toString(),
      receivedOriginalAmount: receivedAmount.toString(),
      receivedCurrency: 'CNY',
      receivedFxRateToCny: 1,
      receivedFinanceAccountId: null,
      receivedAt: orderTimestamp,
      platformFeeAmount: platformFeeAmount.toString(),
      accountCostAmount: 0,
      appliedAccountCostAmount: 0,
      accountSource: sourceSoldOrderId ? 'customer_owned' : 'inventory',
      sourceSoldOrderId,
      accountDisposition: 'retained',
      balanceAmount: balanceAmount.toString(),
      balanceCostAmount: 0,
      refundCostAmount: null,
      profitAmount: null,
      status: 'processing',
      statusChangedAt: orderTimestamp,
      openedAt: input.openedAt,
      dueAt: input.dueAt,
      idempotencyKey: input.idempotencyKey,
      remark: input.remark,
      createdByUserId: operator?.id,
      updatedByUserId: operator?.id,
      createdAt: orderTimestamp
    });

    return {
      order,
      platformFeeAmount
    };
  }

  private async assertActiveCustomer(tx: V2CommandTransaction, customerId: string) {
    const customer = await this.repository.findActiveCustomer(tx, customerId);
    if (!customer) {
      throw new BadRequestException('客户不存在、已停用或已删除');
    }
  }

  private async resolveRenewalAccountSource(
    tx: V2CommandTransaction,
    accountId: string,
    customerId: string
  ) {
    const ownership = await this.repository.findSoldAccountOwnership(tx, accountId);
    if (!ownership?.soldByOrder) return null;
    if (ownership.soldByOrder.customerId !== customerId) {
      throw new ConflictException('已售 ID 只能由原购买客户续费');
    }
    return ownership.soldByOrder.id;
  }

  private async resolveAccountSource(
    tx: V2CommandTransaction,
    accountId: string,
    customerId: string,
    accountSource: 'inventory' | 'customer_owned'
  ) {
    if (accountSource === 'inventory') {
      return null;
    }
    const ownership = await this.repository.findSoldAccountOwnership(tx, accountId);
    if (!ownership?.soldByOrder || ownership.soldByOrder.deletedAt) {
      throw new ConflictException('客户已购 ID 缺少有效的原销售订单');
    }
    if (ownership.soldByOrder.customerId !== customerId) {
      throw new ConflictException('该 ID 不属于当前客户');
    }
    return ownership.soldByOrder.id;
  }

  private async assertActiveService(tx: V2CommandTransaction, serviceOptionId: string) {
    const service = await this.repository.findEligibleOrderEntryService(tx, serviceOptionId);
    if (!service) {
      throw new BadRequestException('业务不存在、已停用或尚未配置国家、金额和货币');
    }
  }

  private async resolveSettlementPlatform(
    tx: V2CommandTransaction,
    settlementPlatformOptionId: string | null
  ) {
    if (!settlementPlatformOptionId) return null;
    const platform = await this.repository.findActiveSettlementPlatform(
      tx,
      settlementPlatformOptionId
    );
    if (!platform) {
      throw new BadRequestException('结算平台不存在或已停用');
    }
    return platform;
  }
}
