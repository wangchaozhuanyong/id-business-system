import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import type { IdBusinessV2FinanceCurrency } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { BankRechargeRepository } from './persistence/bank-recharge.repository';
import { IdBusinessV2FinancePostingService } from '../finance/public-api';
import {
  Amount4,
  Rate8,
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  assertV2ExpectedUpdatedAt,
  normalizeV2ExpectedUpdatedAt
} from '../runtime/public-api';
import { bankRechargeId, bankRechargeObject, bankRechargeText } from './bank-recharge-validation';

const FINANCE_CURRENCIES = new Set(['CNY', 'MYR', 'USD', 'USDT']);

@Injectable()
export class BankRechargeFinanceService {
  constructor(
    private readonly repository: BankRechargeRepository,
    private readonly transactions: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService,
    private readonly posting: IdBusinessV2FinancePostingService
  ) {}

  async complete(id: string, value: unknown, operator: AuthenticatedUser) {
    bankRechargeId(id, '银充订单');
    const input = bankRechargeObject(value);
    const expectedUpdatedAt = normalizeV2ExpectedUpdatedAt(input.expectedUpdatedAt, '银充订单');
    return this.transactions.execute(
      async (tx) => {
        const order = await this.repository.findOrderForCompletion(tx, id);
        if (!order) throw new NotFoundException('银充订单不存在');
        if (order.status === 'completed') throw new ConflictException('银充订单已经完成');
        if (['refunded', 'cancelled'].includes(order.status))
          throw new ConflictException('银充订单已结束');
        assertV2ExpectedUpdatedAt(order.updatedAt, expectedUpdatedAt, '银充订单');
        if (
          !order.account ||
          !order.customer ||
          !order.card ||
          !order.openedAt ||
          !order.dueAt ||
          !order.receivedAmount ||
          !order.receivedCurrencyCode ||
          !order.receivedFinanceAccountId ||
          !order.chargeFxRateToCny
        ) {
          throw new BadRequestException('请先补齐账号、客户、银行卡、开通与到期时间、收款和汇率');
        }
        if (
          order.customer.deletedAt ||
          order.customer.recordStatus !== 'active' ||
          order.account.status !== 'active' ||
          !order.card.active
        ) {
          throw new ConflictException('账号、客户或银行卡已停用');
        }
        if (!FINANCE_CURRENCIES.has(order.receivedCurrencyCode)) {
          throw new BadRequestException(
            '客户实收币种暂不支持财务入账，请选择 CNY、MYR、USD 或 USDT'
          );
        }
        const receivedAccount = await this.repository.findFinanceAccount(
          tx,
          order.receivedFinanceAccountId
        );
        if (
          !receivedAccount ||
          receivedAccount.status !== 'active' ||
          receivedAccount.currency !== order.receivedCurrencyCode
        ) {
          throw new BadRequestException('客户收款账户不存在或币种不一致');
        }
        if (!order.fundingFinanceAccountId) {
          throw new BadRequestException('请为预存资金银行卡选择代付资金账户');
        }
        const fundingAccount = await this.repository.findFinanceAccount(
          tx,
          order.fundingFinanceAccountId
        );
        if (
          !fundingAccount ||
          fundingAccount.status !== 'active' ||
          fundingAccount.currency !== 'CNY'
        ) {
          throw new BadRequestException('代付资金账户必须是启用中的人民币账户');
        }
        const charge = Amount4.from(order.chargeAmount);
        const chargeFx = Rate8.from(order.chargeFxRateToCny);
        const chargeCny = chargeFx.apply(charge);
        const serviceFeeCny = chargeFx.apply(Amount4.from(order.customerFeeAmount));
        const received = Amount4.from(order.receivedAmount);
        const receivedFx =
          order.receivedCurrencyCode === 'CNY'
            ? Rate8.one()
            : order.receivedFxRateToCny
              ? Rate8.from(order.receivedFxRateToCny)
              : null;
        if (!receivedFx || !receivedFx.gt('0')) throw new BadRequestException('请填写客户实收汇率');
        const receivedCny = receivedFx.apply(received);
        if (serviceFeeCny.gt(receivedCny)) {
          throw new BadRequestException('客户手续费折算金额不能高于客户实收');
        }
        const bankFee = order.bankFeeAmount ? Amount4.from(order.bankFeeAmount) : Amount4.zero();
        const bankFeeFx = bankFee.isZero()
          ? Rate8.one()
          : order.bankFeeCurrencyCode === order.chargeCurrencyCode
            ? chargeFx
            : order.bankFeeFxRateToCny
              ? Rate8.from(order.bankFeeFxRateToCny)
              : null;
        if (!bankFeeFx || !bankFeeFx.gt('0')) throw new BadRequestException('请填写银行手续费汇率');
        const bankFeeCny = bankFeeFx.apply(bankFee);
        const profit = receivedCny.sub(chargeCny).sub(bankFeeCny);
        const journal = await this.posting.post(tx, {
          journalType: 'bank_recharge_completed',
          sourceType: 'bank_recharge',
          sourceId: order.id,
          sourceReference: order.orderNo,
          occurredAt: new Date(),
          summary: `银充订单完成：${order.orderNo}`,
          idempotencyKey: `bank_recharge_completed:${order.id}`,
          operator,
          metadata: {
            chargeAmount: charge.toString(),
            chargeCurrencyCode: order.chargeCurrencyCode,
            bankFeeAmount: bankFee.toString(),
            bankFeeCurrencyCode: order.bankFeeCurrencyCode,
            cardId: order.card.id
          },
          lines: [
            {
              accountCode: 'cash',
              direction: 'debit',
              currency: order.receivedCurrencyCode as IdBusinessV2FinanceCurrency,
              amountOriginal: received,
              fxRateToCny: receivedFx,
              amountCny: receivedCny,
              financeAccountId: receivedAccount.id,
              memo: '银充客户实收'
            },
            {
              accountCode: 'bank_recharge_revenue',
              direction: 'credit',
              currency: 'CNY',
              amountOriginal: receivedCny.sub(serviceFeeCny),
              fxRateToCny: Rate8.one(),
              amountCny: receivedCny.sub(serviceFeeCny),
              memo: '银充代充收入'
            },
            ...(serviceFeeCny.isZero()
              ? []
              : [
                  {
                    accountCode: 'bank_recharge_service_fee' as const,
                    direction: 'credit' as const,
                    currency: 'CNY' as const,
                    amountOriginal: serviceFeeCny,
                    fxRateToCny: Rate8.one(),
                    amountCny: serviceFeeCny,
                    memo: '客户手续费收入'
                  }
                ]),
            {
              accountCode: 'bank_recharge_cost',
              direction: 'debit',
              currency: 'CNY',
              amountOriginal: chargeCny,
              fxRateToCny: Rate8.one(),
              amountCny: chargeCny,
              memo: '官网代付成本'
            },
            {
              accountCode: 'cash',
              direction: 'credit',
              currency: 'CNY',
              amountOriginal: chargeCny,
              fxRateToCny: Rate8.one(),
              amountCny: chargeCny,
              financeAccountId: fundingAccount.id,
              memo: '银行卡代付'
            },
            ...(bankFeeCny.isZero()
              ? []
              : [
                  {
                    accountCode: 'bank_recharge_bank_fee' as const,
                    direction: 'debit' as const,
                    currency: 'CNY' as const,
                    amountOriginal: bankFeeCny,
                    fxRateToCny: Rate8.one(),
                    amountCny: bankFeeCny,
                    memo: '银行通道手续费'
                  },
                  {
                    accountCode: 'cash' as const,
                    direction: 'credit' as const,
                    currency: 'CNY' as const,
                    amountOriginal: bankFeeCny,
                    fxRateToCny: Rate8.one(),
                    amountCny: bankFeeCny,
                    financeAccountId: fundingAccount.id,
                    memo: '银行卡通道手续费支出'
                  }
                ])
          ]
        });
        const updated = await this.repository.updateOrder(tx, {
          where: { id },
          data: {
            status: 'completed',
            financeStatus: 'posted',
            profitAmountCny: profit.toString(),
            updatedByUserId: operator.id
          }
        });
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.bank_recharge.order.complete',
          objectType: 'bank_recharge_order',
          objectId: id,
          afterData: {
            orderNo: order.orderNo,
            journalId: journal.id,
            receivedCny: receivedCny.toString(),
            chargeCny: chargeCny.toString(),
            bankFeeCny: bankFeeCny.toString(),
            serviceFeeCny: serviceFeeCny.toString(),
            profitCny: profit.toString()
          },
          remark: '银充订单完成并同步生成财务日记'
        });
        return updated;
      },
      {
        changedScopes: [
          'auto-recharge',
          'renewals',
          'renewal-warning-summary',
          'dashboard',
          'finance-ledger'
        ],
        requestId: randomUUID(),
        operator,
        retryMode: 'none'
      }
    );
  }

  async refund(id: string, value: unknown, operator: AuthenticatedUser) {
    bankRechargeId(id, '银充订单');
    const input = bankRechargeObject(value);
    const reason = bankRechargeText(input.reason, '退款原因', 300);
    const evidence = bankRechargeText(input.refundReference, '退款凭据', 160);
    const expectedUpdatedAt = normalizeV2ExpectedUpdatedAt(input.expectedUpdatedAt, '银充订单');
    return this.transactions.execute(
      async (tx) => {
        const order = await this.repository.findOrder(tx, id);
        if (!order) throw new NotFoundException('银充订单不存在');
        if (order.status !== 'completed' || order.financeStatus !== 'posted') {
          throw new ConflictException('只有已完成并入账的银充订单可以登记退款');
        }
        assertV2ExpectedUpdatedAt(order.updatedAt, expectedUpdatedAt, '银充订单');
        const journal = await this.repository.findPostedJournal(
          tx,
          `bank_recharge_completed:${id}`
        );
        if (!journal) throw new ConflictException('找不到银充订单财务日记');
        await this.posting.reverse(
          tx,
          journal.id,
          `${reason}；凭据 ${evidence}`,
          `bank_recharge_refund:${id}`,
          operator
        );
        const updated = await this.repository.updateOrder(tx, {
          where: { id },
          data: {
            status: 'refunded',
            financeStatus: 'reversed',
            profitAmountCny: '0',
            updatedByUserId: operator.id
          }
        });
        if (order.accountId) {
          await this.repository.cancelSubscriptionForOrder(tx, order.accountId, id);
        }
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.bank_recharge.order.refund',
          objectType: 'bank_recharge_order',
          objectId: id,
          afterData: { orderNo: order.orderNo, refundReference: evidence, reason },
          remark: '银充订单登记已发生退款并冲销原财务日记'
        });
        return updated;
      },
      {
        changedScopes: [
          'auto-recharge',
          'renewals',
          'renewal-warning-summary',
          'dashboard',
          'finance-ledger'
        ],
        requestId: randomUUID(),
        operator,
        retryMode: 'none'
      }
    );
  }
}
