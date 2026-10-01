import { BadRequestException, ConflictException } from '@nestjs/common';
import type { FinancePostingLineInput } from '../finance/public-api';
import { Amount4, Rate8 } from '../runtime/public-api';
import { bankRechargeMoney } from './bank-recharge-validation';

type Journal = { lines: FinancePostingLineInput[]; metadata?: unknown };
export function calculateSubscriptionCostRefund(
  original: Journal,
  refunds: Journal[],
  input: Record<string, unknown>
) {
  const receipt = original.lines.find((l) => l.accountCode === 'cash' && l.direction === 'debit');
  const funding = original.lines.find(
    (l) => l.accountCode === 'cash' && l.direction === 'credit' && l.memo === '银行卡代付'
  );
  if (!receipt?.financeAccountId || !funding?.financeAccountId)
    throw new ConflictException('原订阅日记缺少收付款账户');
  const sum = (
    journals: Journal[],
    code: FinancePostingLineInput['accountCode'],
    direction: FinancePostingLineInput['direction'],
    native = false
  ) =>
    journals
      .flatMap((j) => j.lines)
      .filter((l) => l.accountCode === code && l.direction === direction)
      .reduce((a, l) => a.add(native ? l.amountOriginal : l.amountCny), Amount4.zero());
  const priorRefundNative = sum(refunds, 'bank_recharge_revenue', 'debit', true);
  // Revenue is CNY while receipts can be a different currency; cash refunds are the native fact.
  const priorCustomer = refunds
    .flatMap((j) => j.lines)
    .filter(
      (l) =>
        l.accountCode === 'cash' &&
        l.direction === 'credit' &&
        l.financeAccountId === receipt.financeAccountId
    )
    .reduce((a, l) => a.add(l.amountOriginal), Amount4.zero());
  const received = Amount4.from(receipt.amountOriginal),
    remaining = received.sub(priorCustomer);
  const customerRefund =
    input.customerRefundAmount === undefined || input.customerRefundAmount === ''
      ? remaining
      : bankRechargeMoney(input.customerRefundAmount, '客户退款', 4);
  if (remaining.isNegative() || customerRefund.gt(remaining))
    throw new BadRequestException('客户退款超过剩余可退金额');
  const fullyRefunded = priorCustomer.add(customerRefund).equals(received);
  const customerRefundCny = (
    fullyRefunded
      ? Amount4.from(receipt.amountCny)
      : Rate8.from(receipt.fxRateToCny).apply(priorCustomer.add(customerRefund))
  ).sub(priorRefundNative);
  const lines: FinancePostingLineInput[] = [];
  if (!customerRefund.isZero())
    lines.push(
      {
        accountCode: 'cash',
        direction: 'credit',
        currency: receipt.currency,
        amountOriginal: customerRefund,
        fxRateToCny: receipt.fxRateToCny,
        amountCny: customerRefundCny,
        financeAccountId: receipt.financeAccountId,
        memo: '订阅客户实际退款'
      },
      {
        accountCode: 'bank_recharge_revenue',
        direction: 'debit',
        currency: 'CNY',
        amountOriginal: customerRefundCny,
        fxRateToCny: Rate8.one(),
        amountCny: customerRefundCny
      }
    );
  const chargeRecovery = bankRechargeMoney(
    input.chargeRecoveryAmountCny ?? '0',
    '订阅本金实际回款',
    4
  );
  const chargeCost = sum([original], 'bank_recharge_cost', 'debit'),
    priorCharge = sum(refunds, 'bank_recharge_cost', 'credit');
  if (chargeRecovery.gt(chargeCost.sub(priorCharge)))
    throw new BadRequestException('订阅本金回款超过剩余成本');
  if (!chargeRecovery.isZero())
    lines.push(
      {
        accountCode: 'cash',
        direction: 'debit',
        currency: 'CNY',
        amountOriginal: chargeRecovery,
        fxRateToCny: Rate8.one(),
        amountCny: chargeRecovery,
        financeAccountId: funding.financeAccountId
      },
      {
        accountCode: 'bank_recharge_cost',
        direction: 'credit',
        currency: 'CNY',
        amountOriginal: chargeRecovery,
        fxRateToCny: Rate8.one(),
        amountCny: chargeRecovery
      }
    );
  let feeRecovery = Amount4.zero(),
    feesFullyRecovered = true;
  const recoveries = {
    usdtFeeRecoveryAmount: Amount4.zero(),
    shoppingFeeRecoveryAmount: Amount4.zero(),
    usdtFeeRecoveryCny: Amount4.zero(),
    shoppingFeeRecoveryCny: Amount4.zero()
  };
  for (const [prefix, code, label] of [
    ['usdtFee', 'bank_recharge_usdt_fee', 'USDT 手续费'],
    ['shoppingFee', 'bank_recharge_shopping_fee', '购物网手续费']
  ] as const) {
    const amount = bankRechargeMoney(
      input[`${prefix}RecoveryAmount`] ?? '0',
      `${label}实际退回`,
      4
    );
    const fee = original.lines.find((l) => l.accountCode === code && l.direction === 'debit');
    const originalNative = fee ? Amount4.from(fee.amountOriginal) : Amount4.zero();
    const priorNative = sum(refunds, code, 'credit', true),
      cumulative = priorNative.add(amount);
    if (cumulative.gt(originalNative)) throw new BadRequestException(`${label}退回超过剩余费用`);
    const complete = cumulative.equals(originalNative);
    feesFullyRecovered &&= complete;
    recoveries[`${prefix}RecoveryAmount`] = amount;
    if (amount.isZero()) continue;
    if (!fee?.financeAccountId) throw new ConflictException(`${label}原付款账户缺失`);
    const cny = (
      complete ? Amount4.from(fee.amountCny) : Rate8.from(fee.fxRateToCny).apply(cumulative)
    ).sub(sum(refunds, code, 'credit'));
    recoveries[`${prefix}RecoveryCny`] = cny;
    feeRecovery = feeRecovery.add(cny);
    lines.push(
      {
        accountCode: 'cash',
        direction: 'debit',
        currency: fee.currency,
        amountOriginal: amount,
        fxRateToCny: fee.fxRateToCny,
        amountCny: cny,
        financeAccountId: fee.financeAccountId,
        fxRateSnapshotId: fee.fxRateSnapshotId,
        memo: `${label}实际退回`
      },
      {
        accountCode: code,
        direction: 'credit',
        currency: fee.currency,
        amountOriginal: amount,
        fxRateToCny: fee.fxRateToCny,
        amountCny: cny,
        financeAccountId: fee.financeAccountId,
        fxRateSnapshotId: fee.fxRateSnapshotId
      }
    );
  }
  if (
    customerRefund.isZero() &&
    chargeRecovery.isZero() &&
    recoveries.usdtFeeRecoveryAmount.isZero() &&
    recoveries.shoppingFeeRecoveryAmount.isZero()
  )
    throw new BadRequestException('请填写实际发生的退款或回款');
  return {
    lines,
    customerRefund,
    customerRefundCny,
    chargeRecovery,
    feeRecovery,
    fullyRefunded,
    fullyReversed:
      fullyRefunded && priorCharge.add(chargeRecovery).equals(chargeCost) && feesFullyRecovered,
    ...recoveries
  };
}
