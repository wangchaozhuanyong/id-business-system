import { ConflictException } from '@nestjs/common';
import { divideDecimalStrings, multiplyDecimalStrings } from '@apple-business/shared';
import { Amount4, Rate8 } from '../runtime/public-api';
import type { IdBusinessV2FinanceCurrency } from '@prisma/client';
import type { FinancePostingLineInput } from './id-business-v2-finance-posting.service';

export function assertSupplierBookCost(currency: string, balance: Amount4, cost: Amount4) {
  if (currency === 'CNY') {
    if (!balance.equals(cost))
      throw new ConflictException('供应商人民币余额与账面成本不一致，请先核对');
    return;
  }
  if (balance.isNegative() || cost.isNegative() || balance.isZero() !== cost.isZero()) {
    throw new ConflictException('供应商外币余额或历史成本异常，请先核对，不能自动重估或跨过欠款');
  }
}

export function allocateSupplierBookCost(balance: Amount4, cost: Amount4, quantity: Amount4) {
  if (balance.lte('0') || quantity.lte('0') || quantity.gt(balance)) {
    throw new ConflictException('供应商成本结转数量不正确');
  }
  if (quantity.equals(balance)) return cost;
  // Both inputs have four decimals: their product is exact at eight, before the final division.
  const allocated = Amount4.from(
    divideDecimalStrings(
      multiplyDecimalStrings(cost.toString(), quantity.toString(), 8),
      balance.toString(),
      4
    )
  );
  if (allocated.gte(cost)) {
    throw new ConflictException('剩余外币成本低于金额精度，请核对或全额结转');
  }
  return allocated;
}

export function supplierCarryingRate(currency: string, quantity: Amount4, cost: Amount4) {
  return currency === 'CNY' ? Rate8.one() : cost.ratio(quantity);
}

export function supplierRefundPostingLines(input: {
  currency: IdBusinessV2FinanceCurrency;
  quantity: Amount4;
  cashCny: Amount4;
  cashRate: Rate8;
  cashSnapshotId: string | null;
  financeAccountId: string;
  walletId: string;
  bookCost: Amount4;
  bookRate: Rate8;
}): FinancePostingLineInput[] {
  const difference = input.cashCny.sub(input.bookCost);
  const lines: FinancePostingLineInput[] = [
    {
      accountCode: 'cash',
      direction: 'debit',
      currency: input.currency,
      amountOriginal: input.quantity,
      fxRateToCny: input.cashRate,
      amountCny: input.cashCny,
      financeAccountId: input.financeAccountId,
      fxRateSnapshotId: input.cashSnapshotId
    },
    {
      accountCode: 'supplier_prepayment',
      direction: 'credit',
      currency: input.currency,
      amountOriginal: input.quantity,
      fxRateToCny: input.bookRate,
      amountCny: input.bookCost,
      supplierAccountId: input.walletId,
      memo: '按退款前余额比例结转历史账面成本'
    }
  ];
  if (!difference.isZero())
    lines.push({
      accountCode: 'realized_fx_gain_loss',
      direction: difference.gt(0) ? 'credit' : 'debit',
      currency: 'CNY',
      amountOriginal: difference.abs(),
      fxRateToCny: Rate8.one(),
      amountCny: difference.abs(),
      memo: '供应商退款实际到账与历史成本差额'
    });
  return lines;
}

export function supplierAdjustmentPostingLines(input: {
  currency: IdBusinessV2FinanceCurrency;
  quantity: Amount4;
  bookCost: Amount4;
  bookRate: Rate8;
  walletId: string;
  increase: boolean;
  fxRateSnapshotId: string | null;
}): FinancePostingLineInput[] {
  const valuation = {
    currency: input.currency,
    amountOriginal: input.quantity,
    fxRateToCny: input.bookRate,
    amountCny: input.bookCost,
    fxRateSnapshotId: input.fxRateSnapshotId
  };
  return [
    {
      ...valuation,
      accountCode: 'supplier_prepayment',
      direction: input.increase ? 'debit' : 'credit',
      supplierAccountId: input.walletId
    },
    {
      ...valuation,
      accountCode: 'manual_adjustment',
      direction: input.increase ? 'credit' : 'debit'
    }
  ];
}
