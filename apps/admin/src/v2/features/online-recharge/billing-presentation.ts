export interface OnlineBillingSummary {
  currency: string;
  amount: string | null;
  knownAmount: string | null;
  count: number;
  unknownAmountCount: number;
  isComplete: boolean;
}

export function onlineBillingAmountText(row: OnlineBillingSummary) {
  if (row.isComplete) return `${row.amount ?? '—'}（${row.count} 笔，金额完整）`;
  const known = row.knownAmount ?? row.amount ?? '尚无已知金额';
  return `已知金额小计 ${known}；${row.unknownAmountCount ?? row.count} 笔金额待核对（共 ${row.count} 笔）`;
}

export function onlineBillingActionResult(value: Record<string, unknown> | unknown[]) {
  if (!Array.isArray(value)) return value;
  return value.length ? { billingSummary: value } : { message: '当前没有已确认成功的账单' };
}
