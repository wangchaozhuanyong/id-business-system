import { ConflictException } from '@nestjs/common';
import type { IdBusinessV2FinanceCurrency } from '@prisma/client';
import {
  lockFinanceAccount,
  normalizeOptionalFinanceUuid,
  type FinancePostingLineInput
} from '../finance/public-api';
import { Amount4, type V2CommandTransaction, type V2DecimalInput } from '../runtime/public-api';

export function normalizeOrderReceiptAccount(value: unknown) {
  return normalizeOptionalFinanceUuid(value, '收款账户');
}

export async function assertOrderReceiptAccount(
  tx: V2CommandTransaction,
  value: unknown,
  currency: IdBusinessV2FinanceCurrency,
  amounts: V2DecimalInput[]
) {
  const id = normalizeOrderReceiptAccount(value);
  if (!id) {
    if (amounts.some((amount) => !Amount4.from(amount).isZero()))
      throw new ConflictException('订单有收付金额但缺少真实收款账户，请先核对资金归属');
    return null;
  }
  const account = await lockFinanceAccount(tx, id);
  if (!account || account.status !== 'active')
    throw new ConflictException('收款账户不存在或已停用，请重新选择');
  if (account.currency !== currency)
    throw new ConflictException('收款账户币种与订单收款币种不一致');
  return id;
}

export function nonZeroOrderCashLines(lines: FinancePostingLineInput[]) {
  return lines.filter(
    (line) =>
      line.accountCode !== 'cash' ||
      !Amount4.from(line.amountOriginal).isZero() ||
      !Amount4.from(line.amountCny).isZero()
  );
}
