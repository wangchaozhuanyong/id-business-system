import { ConflictException } from '@nestjs/common';
import { Amount4, mapAmount4, type V2CommandTransaction } from '../../runtime/public-api';

const profitCodes = [
  'sales_revenue',
  'platform_fee',
  'gift_card_cost',
  'id_cost',
  'customer_owned_balance_cost',
  'refund_loss',
  'gift_card_redemption_loss',
  'balance_loss',
  'id_purchase_loss',
  'operating_expense',
  'realized_fx_gain_loss'
] as const;

export async function synchronizePostedOrderProfit(tx: V2CommandTransaction, orderId: string) {
  const journals = await tx.idBusinessV2FinanceJournal.findMany({
    where: {
      sourceType: 'order',
      OR: [
        { sourceId: orderId },
        { metadata: { path: '$.restoredSourceOrderId', equals: orderId } }
      ]
    },
    select: {
      sourceId: true,
      metadata: true,
      status: true,
      lines: {
        where: { accountCode: { in: [...profitCodes] } },
        select: { direction: true, amountCny: true }
      }
    }
  });
  if (!journals.some((journal) => journal.sourceId === orderId)) {
    throw new ConflictException('订单缺少财务凭证，不能重算已确认利润');
  }
  let profit = Amount4.zero();
  for (const journal of journals) {
    const metadata =
      journal.metadata && typeof journal.metadata === 'object' && !Array.isArray(journal.metadata)
        ? journal.metadata
        : null;
    const allocated =
      journal.status !== 'reversed' && typeof metadata?.restoredSourceOrderCostAmount === 'string'
        ? Amount4.from(metadata.restoredSourceOrderCostAmount)
        : Amount4.zero();
    if (journal.sourceId === orderId) {
      for (const line of journal.lines) {
        const amount = mapAmount4(line.amountCny, 'finance_journal_lines.amount_cny');
        profit = line.direction === 'credit' ? profit.add(amount) : profit.sub(amount);
      }
      if (
        typeof metadata?.restoredSourceOrderId === 'string' &&
        metadata.restoredSourceOrderId !== orderId
      ) {
        profit = profit.sub(allocated);
      }
    } else if (metadata?.restoredSourceOrderId === orderId) {
      profit = profit.add(allocated);
    }
  }
  await tx.idBusinessV2Order.update({
    where: { id: orderId },
    data: { profitAmount: profit.toString() }
  });
  return profit;
}
