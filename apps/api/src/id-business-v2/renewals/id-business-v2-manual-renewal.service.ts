import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { IdBusinessV2BalanceCalculatorService } from '../balances/public-api';
import {
  IdBusinessV2OrderCompletionService,
  IdBusinessV2OrderEntryService,
  IdBusinessV2OrdersService
} from '../orders/public-api';
import {
  Amount4,
  V2CommandTransactionManager,
  mapStringArray,
  type V2CommandTransaction
} from '../runtime/public-api';
import type { CreateIdBusinessV2ManualRenewalDto } from './dto/create-id-business-v2-manual-renewal.dto';
import {
  buildManualRenewalReplayResult,
  normalizeManualRenewalInput,
  normalizeUuid,
  toManualRenewalLedgerResponse
} from './id-business-v2-manual-renewal-support';
import { IdBusinessV2RenewalsRepository } from './persistence/id-business-v2-renewals.repository';
import type {
  ManualRenewalActivationRecord,
  ManualRenewalLedgerRecord
} from './id-business-v2-renewal.types';

interface ManualRenewalTransactionResult {
  orderId: string;
  activation: ManualRenewalActivationRecord;
  ledgerEntry: ManualRenewalLedgerRecord;
  profitAmount: Amount4;
  idempotentReplay: boolean;
}

const MAX_AMOUNT = Amount4.from('99999999999999.9999');
@Injectable()
export class IdBusinessV2ManualRenewalService {
  constructor(
    private readonly balanceCalculator: IdBusinessV2BalanceCalculatorService,
    private readonly orderEntryService: IdBusinessV2OrderEntryService,
    private readonly ordersService: IdBusinessV2OrdersService,
    private readonly orderCompletionService: IdBusinessV2OrderCompletionService,
    private readonly renewalsRepository: IdBusinessV2RenewalsRepository,
    private readonly transactionManager: V2CommandTransactionManager
  ) {}

  async listOptions() {
    return this.renewalsRepository.listManualRenewalOptions();
  }

  async create(
    activationIdValue: string,
    dto: CreateIdBusinessV2ManualRenewalDto,
    operator?: AuthenticatedUser
  ) {
    const activationId = normalizeUuid(activationIdValue, '续费记录');
    const input = normalizeManualRenewalInput(activationId, dto);
    const businessTime = new Date();
    const verifyReplay = async (
      tx: V2CommandTransaction
    ): Promise<ManualRenewalTransactionResult> => {
      const replay = await this.renewalsRepository.findManualRenewalReplay(
        tx,
        input.idempotencyKey
      );
      if (!replay) {
        throw new ConflictException('平台订单号已存在或续费刚被其他请求处理，请刷新后核对');
      }
      return buildManualRenewalReplayResult(replay, input);
    };

    const result = await this.transactionManager.execute<ManualRenewalTransactionResult>(
      async (tx, context) => {
        const replay = await this.renewalsRepository.findManualRenewalReplay(
          tx,
          input.idempotencyKey
        );
        if (replay) {
          return buildManualRenewalReplayResult(replay, input);
        }

        const lockedActivation = await this.renewalsRepository.lockActivation(tx, activationId);
        if (!lockedActivation) {
          throw new NotFoundException('续费记录不存在或已不在可处理范围');
        }
        const evaluatedAt = context.businessTime;
        const sourceActivation = await this.renewalsRepository.findManualRenewalSourceActivation(
          tx,
          activationId,
          evaluatedAt
        );
        if (!sourceActivation) {
          throw new NotFoundException('续费记录不存在或已不在可处理范围');
        }
        if (sourceActivation.order.status !== 'completed' || sourceActivation.order.deletedAt) {
          throw new ConflictException('原订单不是有效的已完成订单，不能续费');
        }
        if (!sourceActivation.dueAt) {
          throw new ConflictException('原开通记录缺少到期时间，不能续费');
        }
        if (input.openedAt.getTime() < sourceActivation.dueAt.getTime()) {
          throw new BadRequestException('续费开始时间不能早于原到期时间');
        }
        if (
          sourceActivation.account.recordStatus !== 'active' ||
          sourceActivation.account.deletedAt ||
          sourceActivation.account.lossReportedAt ||
          sourceActivation.account.statusOption.code !== 'normal' ||
          sourceActivation.account.statusOption.status !== 'active' ||
          sourceActivation.account.statusOption.deletedAt
        ) {
          throw new ConflictException('只有启用且状态正常的 ID 才能续费');
        }

        const selectedService = await this.renewalsRepository.findManualRenewalService(
          tx,
          input.serviceOptionId
        );
        if (!selectedService) {
          throw new BadRequestException('续费业务不存在或已停用');
        }
        if (
          !selectedService.countryOption ||
          selectedService.countryOption.id !== sourceActivation.account.countryOption.id
        ) {
          throw new ConflictException('续费业务所属国家与当前 ID 国家不一致');
        }

        const account = await this.renewalsRepository.lockAccount(tx, sourceActivation.accountId);
        if (!account) {
          throw new ConflictException('ID 不存在、已停用或已删除');
        }
        if (account.soldByOrderId && account.soldByCustomerId !== sourceActivation.customerId) {
          throw new ConflictException('该已售 ID 不属于续费客户');
        }
        if (
          sourceActivation.account.soldByOrderId &&
          sourceActivation.account.soldByOrder?.customerId !== sourceActivation.customerId
        ) {
          throw new ConflictException('原开通记录客户与 ID 销售归属不一致');
        }
        if (account.lossReportedAt) {
          throw new ConflictException('已报损冻结 ID 不能续费');
        }
        const { activeOrderLock, duplicateRenewalOrder } =
          await this.renewalsRepository.findManualRenewalConflicts(tx, {
            sourceOrderId: sourceActivation.orderId,
            accountId: sourceActivation.accountId,
            serviceOptionId: input.serviceOptionId,
            openedAt: input.openedAt,
            dueAt: input.dueAt,
            evaluatedAt
          });
        if (activeOrderLock) {
          throw new ConflictException('该 ID 已被其他订单占用，请处理完成后再续费');
        }
        if (duplicateRenewalOrder) {
          throw new ConflictException(
            `相同续费周期的订单 ${duplicateRenewalOrder.orderNo} 已完成，请勿重复扣款`
          );
        }

        const movement = this.balanceCalculator.calculateConsumption(
          {
            currentBalance: account.currentBalance,
            balanceCostAmount: account.balanceCostAmount
          },
          input.balanceAmount
        );
        const createdOrder = await this.orderEntryService.createManualRenewalOrderInTransaction(
          tx,
          {
            customerId: sourceActivation.customerId,
            serviceOptionId: input.serviceOptionId,
            accountId: sourceActivation.accountId,
            settlementPlatformOptionId: input.settlementPlatformOptionId,
            platformOrderNo: input.platformOrderNo,
            websiteAccountEncrypted: sourceActivation.order.websiteAccountEncrypted,
            websiteAccountHash: sourceActivation.order.websiteAccountHash,
            websiteAccountMasked: sourceActivation.order.websiteAccountMasked,
            websiteAccountSearchTokens: mapStringArray(
              sourceActivation.order.websiteAccountSearchTokens,
              'id_business_v2_orders.website_account_search_tokens'
            ),
            receivedAmount: input.receivedAmount,
            balanceAmount: input.balanceAmount,
            openedAt: input.openedAt,
            dueAt: input.dueAt,
            idempotencyKey: input.idempotencyKey,
            remark: input.remark,
            accountSource: account.soldByOrderId ? 'customer_owned' : 'inventory'
          },
          operator
        );
        const refundCostAmount = Amount4.zero();
        const profitAmount = input.receivedAmount
          .sub(createdOrder.platformFeeAmount)
          .sub(movement.costAmount)
          .sub(refundCostAmount);
        if (profitAmount.abs().gt(MAX_AMOUNT)) {
          throw new BadRequestException('续费订单利润数值超出数据库范围');
        }

        const ledgerEntry = await this.renewalsRepository.createManualRenewalLedger(tx, {
          accountId: account.id,
          giftCardId: null,
          orderId: createdOrder.order.id,
          entryType: 'order_consumption',
          direction: 'debit',
          balanceAmount: movement.balanceAmount.toString(),
          costAmount: movement.costAmount.toString(),
          balanceBefore: movement.balanceBefore.toString(),
          balanceAfter: movement.balanceAfter.toString(),
          costBefore: movement.costBefore.toString(),
          costAfter: movement.costAfter.toString(),
          averageCostBefore: movement.averageCostBefore.toString(),
          averageCostAfter: movement.averageCostAfter.toString(),
          reversalOfEntryId: null,
          idempotencyKey: `manual_renewal:${createdOrder.order.id}:consumption`,
          remark: `手工续费余额扣减：${createdOrder.order.orderNo}`,
          createdByUserId: operator?.id
        });
        await this.renewalsRepository.updateManualRenewalAccount(tx, account.id, {
          currentBalance: movement.balanceAfter.toString(),
          balanceCostAmount: movement.costAfter.toString(),
          updatedByUserId: operator?.id
        });
        const completedAt = context.businessTime;
        await this.renewalsRepository.updateManualRenewalOrder(tx, createdOrder.order.id, {
          accountCostAmount: '0',
          appliedAccountCostAmount: '0',
          balanceCostAmount: movement.costAmount.toString(),
          refundCostAmount: refundCostAmount.toString(),
          profitAmount: profitAmount.toString(),
          status: 'completed',
          statusChangedAt: completedAt,
          updatedByUserId: operator?.id
        });
        const activation = await this.renewalsRepository.createManualRenewalActivation(tx, {
          orderId: createdOrder.order.id,
          renewedFromActivationId: sourceActivation.id,
          customerId: sourceActivation.customerId,
          accountId: account.id,
          serviceOptionId: input.serviceOptionId,
          openedAt: input.openedAt,
          dueAt: input.dueAt,
          status: 'active',
          statusChangedAt: completedAt,
          autoRenewalStatus: 'unknown',
          autoRenewalChangedAt: null,
          remark: input.remark,
          createdByUserId: operator?.id,
          updatedByUserId: operator?.id
        });
        await this.orderCompletionService.postCompletionJournalInTransaction(
          tx,
          {
            ...createdOrder.order,
            accountCostAmount: Amount4.zero(),
            appliedAccountCostAmount: Amount4.zero(),
            balanceCostAmount: movement.costAmount,
            refundCostAmount,
            profitAmount,
            status: 'completed'
          },
          completedAt,
          operator
        );

        await this.renewalsRepository.appendAudit(tx, {
          userId: operator?.id,
          module: 'id_business_v2',
          action: 'id_business_v2.renewal.manual.complete',
          objectType: 'id_business_v2_order',
          objectId: createdOrder.order.id,
          beforeData: {
            sourceActivationId: sourceActivation.id,
            sourceOrderId: sourceActivation.orderId,
            accountId: account.id,
            appleIdMasked: sourceActivation.account.appleIdMasked,
            balance: movement.balanceBefore.toString(),
            balanceCostAmount: movement.costBefore.toString()
          },
          afterData: {
            executionMode: 'manual_operator_confirmation',
            orderId: createdOrder.order.id,
            orderNo: createdOrder.order.orderNo,
            activationId: activation.id,
            customerId: sourceActivation.customerId,
            serviceOptionId: input.serviceOptionId,
            websiteAccountMasked: sourceActivation.order.websiteAccountMasked,
            consumedBalance: movement.balanceAmount.toString(),
            consumedCost: movement.costAmount.toString(),
            balance: movement.balanceAfter.toString(),
            balanceCostAmount: movement.costAfter.toString(),
            platformFeeAmount: createdOrder.platformFeeAmount.toString(),
            profitAmount: profitAmount.toString(),
            openedAt: input.openedAt,
            dueAt: input.dueAt,
            externalSubscriptionActionPerformed: false
          },
          remark: `手工续费完成，已扣减余额并生成续费记录：${createdOrder.order.orderNo}`
        });

        return {
          orderId: createdOrder.order.id,
          activation,
          ledgerEntry,
          profitAmount,
          idempotentReplay: false
        };
      },
      {
        requestId: randomUUID(),
        operator,
        businessTime,
        retryMode: 'fullReplay',
        idempotencyKey: input.idempotencyKey,
        replay: verifyReplay,
        uniqueConflictMessage: '平台订单号已存在或续费刚被其他请求处理，请刷新后核对'
      }
    );

    return {
      order: await this.ordersService.get(result.orderId),
      activation: result.activation,
      ledgerEntry: toManualRenewalLedgerResponse(result.ledgerEntry),
      balance: {
        before: result.ledgerEntry.balanceBefore.toString(),
        consumed: result.ledgerEntry.balanceAmount.toString(),
        after: result.ledgerEntry.balanceAfter.toString(),
        costBefore: result.ledgerEntry.costBefore.toString(),
        consumedCost: result.ledgerEntry.costAmount.toString(),
        costAfter: result.ledgerEntry.costAfter.toString(),
        averageCostBefore: result.ledgerEntry.averageCostBefore.toString(),
        averageCostAfter: result.ledgerEntry.averageCostAfter.toString()
      },
      profitAmount: result.profitAmount.toString(),
      idempotentReplay: result.idempotentReplay,
      executionBoundary: {
        manualAccountingCompleted: true,
        systemBalanceConsumed: true,
        activationCreated: true,
        externalSubscriptionActionPerformed: false,
        nextStep: 'completed' as const
      }
    };
  }
}
