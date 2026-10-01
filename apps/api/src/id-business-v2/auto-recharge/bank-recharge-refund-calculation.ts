import { calculateSubscriptionCostRefund } from './subscription-cost-refund';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { FinancePostingLineInput } from '../finance/public-api';
import { Amount4, Rate8 } from '../runtime/public-api';
import { bankRechargeMoney } from './bank-recharge-validation';
import { object } from './recharge-validation';

type Journal = { lines: FinancePostingLineInput[]; metadata?: unknown };

export function calculateBankRechargeRefund(
  original: Journal,
  refunds: Journal[],
  input: Record<string, unknown>
) {
  if (object(original.metadata ?? {}).accountingVersion === 'subscription_cost_v2')
    return calculateSubscriptionCostRefund(original, refunds, input);
  const receipt = original.lines.find(
    (line) => line.accountCode === 'cash' && line.direction === 'debit'
  );
  const funding = original.lines.find(
    (line) => line.accountCode === 'cash' && line.direction === 'credit'
  );
  if (!receipt?.financeAccountId || !funding?.financeAccountId) {
    throw new ConflictException('原银充日记缺少收付款账户，请先核对账务');
  }
  const sum = (
    journals: Journal[],
    code: FinancePostingLineInput['accountCode'],
    direction: FinancePostingLineInput['direction']
  ) =>
    journals
      .flatMap((journal) => journal.lines)
      .filter((line) => line.accountCode === code && line.direction === direction)
      .reduce((total, line) => total.add(line.amountCny), Amount4.zero());
  const refundedOriginal = refunds.reduce(
    (total, journal) =>
      total.add(String(object(journal.metadata ?? {}).customerRefundAmount ?? '0')),
    Amount4.zero()
  );
  const receivedOriginal = Amount4.from(receipt.amountOriginal);
  const remaining = receivedOriginal.sub(refundedOriginal);
  const customerRefund =
    input.customerRefundAmount === undefined || input.customerRefundAmount === ''
      ? remaining
      : bankRechargeMoney(
          input.customerRefundAmount,
          '客户退款金额',
          receipt.currency === 'USDT' ? 4 : 2
        );
  const chargeRecovery = bankRechargeMoney(input.chargeRecoveryAmountCny ?? '0', '官网实际回款', 4);
  const feeRecovery = bankRechargeMoney(
    input.bankFeeRecoveryAmountCny ?? '0',
    '银行手续费实际退回',
    4
  );
  const chargeCost = sum([original], 'bank_recharge_cost', 'debit');
  const bankFee = sum([original], 'bank_recharge_bank_fee', 'debit');
  const priorChargeRecovery = sum(refunds, 'bank_recharge_cost', 'credit');
  const priorFeeRecovery = sum(refunds, 'bank_recharge_bank_fee', 'credit');
  if (
    remaining.isNegative() ||
    customerRefund.gt(remaining) ||
    chargeRecovery.gt(chargeCost.sub(priorChargeRecovery)) ||
    feeRecovery.gt(bankFee.sub(priorFeeRecovery))
  ) {
    throw new BadRequestException('退款或回款金额超过原单尚未处理的金额');
  }
  if (customerRefund.isZero() && chargeRecovery.isZero() && feeRecovery.isZero()) {
    throw new BadRequestException('请填写已经发生的退款或回款金额');
  }
  const cumulativeRefund = refundedOriginal.add(customerRefund);
  const fullyRefunded = cumulativeRefund.equals(receivedOriginal);
  const previousRevenueRefund = sum(refunds, 'bank_recharge_revenue', 'debit').add(
    sum(refunds, 'bank_recharge_service_fee', 'debit')
  );
  const customerRefundCny = (
    fullyRefunded
      ? Amount4.from(receipt.amountCny)
      : Rate8.from(receipt.fxRateToCny).apply(cumulativeRefund)
  ).sub(previousRevenueRefund);
  const originalServiceFee = sum([original], 'bank_recharge_service_fee', 'credit');
  const serviceFeeRefund = (
    fullyRefunded
      ? originalServiceFee
      : cumulativeRefund.ratio(receivedOriginal).apply(originalServiceFee)
  ).sub(sum(refunds, 'bank_recharge_service_fee', 'debit'));
  const lines: FinancePostingLineInput[] = [];
  if (!customerRefund.isZero()) {
    lines.push({
      accountCode: 'cash',
      direction: 'credit',
      currency: receipt.currency,
      amountOriginal: customerRefund,
      fxRateToCny: receipt.fxRateToCny,
      amountCny: customerRefundCny,
      financeAccountId: receipt.financeAccountId,
      memo: '银充客户实际退款'
    });
    for (const [accountCode, amount] of [
      ['bank_recharge_revenue', customerRefundCny.sub(serviceFeeRefund)],
      ['bank_recharge_service_fee', serviceFeeRefund]
    ] as const) {
      if (!amount.isZero())
        lines.push({
          accountCode,
          direction: 'debit',
          currency: 'CNY',
          amountOriginal: amount,
          fxRateToCny: Rate8.one(),
          amountCny: amount,
          memo: '银充退款减少收入'
        });
    }
  }
  for (const [accountCode, amount] of [
    ['bank_recharge_cost', chargeRecovery],
    ['bank_recharge_bank_fee', feeRecovery]
  ] as const) {
    if (amount.isZero()) continue;
    lines.push(
      {
        accountCode: 'cash',
        direction: 'debit',
        currency: 'CNY',
        amountOriginal: amount,
        fxRateToCny: Rate8.one(),
        amountCny: amount,
        financeAccountId: funding.financeAccountId,
        memo: '银充上游实际回款'
      },
      {
        accountCode,
        direction: 'credit',
        currency: 'CNY',
        amountOriginal: amount,
        fxRateToCny: Rate8.one(),
        amountCny: amount,
        memo: '银充已回收成本'
      }
    );
  }
  return {
    usdtFeeRecoveryAmount: Amount4.zero(),
    shoppingFeeRecoveryAmount: Amount4.zero(),
    usdtFeeRecoveryCny: Amount4.zero(),
    shoppingFeeRecoveryCny: Amount4.zero(),
    lines,
    customerRefund,
    customerRefundCny,
    chargeRecovery,
    feeRecovery,
    fullyRefunded,
    fullyReversed:
      fullyRefunded &&
      priorChargeRecovery.add(chargeRecovery).equals(chargeCost) &&
      priorFeeRecovery.add(feeRecovery).equals(bankFee)
  };
}
