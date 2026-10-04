import type { FinancePostingLineInput } from '../finance/public-api';
import { Amount4 } from '../runtime/public-api';

const profitAccounts = new Set<string>([
  'bank_recharge_revenue',
  'bank_recharge_service_fee',
  'bank_recharge_cost',
  'bank_recharge_bank_fee',
  'bank_recharge_usdt_fee',
  'bank_recharge_shopping_fee',
  'realized_fx_gain_loss'
]);

export function bankRechargeJournalProfit(lines: readonly FinancePostingLineInput[]) {
  return lines.reduce((total, line) => {
    if (!profitAccounts.has(line.accountCode)) return total;
    return line.direction === 'credit' ? total.add(line.amountCny) : total.sub(line.amountCny);
  }, Amount4.zero());
}
