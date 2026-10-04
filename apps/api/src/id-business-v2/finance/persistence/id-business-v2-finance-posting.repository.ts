import type {
  Prisma,
  IdBusinessV2FinanceJournal,
  IdBusinessV2FinanceJournalLine
} from '@prisma/client';
import type { IdBusinessV2FinanceCurrency } from '@prisma/client';
import { mapAmount4 } from '../../runtime/public-api';
import { mapJournal } from './id-business-v2-finance-command.repository';

export async function findLockedJournalReplay(
  tx: Prisma.TransactionClient,
  idempotencyKey: string
) {
  // Both header and immutable lines use current reads, including under RepeatableRead.
  const journals = await tx.$queryRaw<IdBusinessV2FinanceJournal[]>`
    SELECT \`id\`, \`journal_no\` AS \`journalNo\`, \`journal_type\` AS \`journalType\`,
      \`source_type\` AS \`sourceType\`, \`source_id\` AS \`sourceId\`, \`source_reference\` AS \`sourceReference\`,
      \`business_date\` AS \`businessDate\`, \`period_month\` AS \`periodMonth\`, \`occurred_at\` AS \`occurredAt\`,
      \`status\`, \`reversal_of_journal_id\` AS \`reversalOfJournalId\`, \`reversed_at\` AS \`reversedAt\`,
      \`summary\`, \`metadata\`, \`idempotency_key\` AS \`idempotencyKey\`, \`created_by_user_id\` AS \`createdByUserId\`,
      \`created_at\` AS \`createdAt\`, \`updated_at\` AS \`updatedAt\`
    FROM \`id_business_v2_finance_journals\`
    WHERE \`idempotency_key\` = ${idempotencyKey}
    FOR SHARE
  `;
  const journal = journals[0];
  if (!journal) return null;
  const lines = await tx.$queryRaw<IdBusinessV2FinanceJournalLine[]>`
    SELECT \`id\`, \`journal_id\` AS \`journalId\`, \`line_no\` AS \`lineNo\`, \`account_code\` AS \`accountCode\`,
      \`direction\`, \`currency\`, \`amount_original\` AS \`amountOriginal\`, \`fx_rate_to_cny\` AS \`fxRateToCny\`,
      \`amount_cny\` AS \`amountCny\`, \`finance_account_id\` AS \`financeAccountId\`,
      \`supplier_account_id\` AS \`supplierAccountId\`, \`fx_rate_snapshot_id\` AS \`fxRateSnapshotId\`,
      \`memo\`, \`created_at\` AS \`createdAt\`
    FROM \`id_business_v2_finance_journal_lines\`
    WHERE \`journal_id\` = ${journal.id}
    ORDER BY \`line_no\`
    FOR SHARE
  `;
  return mapJournal({ ...journal, lines });
}

export async function findLockedFinancePeriodStatus(tx: Prisma.TransactionClient, month: string) {
  const rows = await tx.$queryRaw<Array<{ status: string }>>`
    SELECT \`status\`
    FROM \`id_business_v2_finance_periods\`
    WHERE \`month\` = ${month}
    FOR SHARE
  `;
  return rows[0]?.status ?? null;
}

export async function lockFinanceAccount(tx: Prisma.TransactionClient, accountId: string) {
  const rows = await tx.$queryRaw<
    Array<{
      id: string;
      status: string;
      currency: IdBusinessV2FinanceCurrency;
      currentBalance: unknown;
      currentBalanceCny: unknown;
    }>
  >`
    SELECT \`id\`, \`status\`, \`currency\`, \`current_balance\` AS \`currentBalance\`, \`current_balance_cny\` AS \`currentBalanceCny\`
    FROM \`id_business_v2_finance_accounts\`
    WHERE \`id\` = ${accountId}
    FOR UPDATE
  `;
  const row = rows[0];
  return row
    ? {
        ...row,
        currentBalance: mapAmount4(
          row.currentBalance,
          'id_business_v2_finance_accounts.current_balance'
        ),
        currentBalanceCny: mapAmount4(
          row.currentBalanceCny,
          'id_business_v2_finance_accounts.current_balance_cny'
        )
      }
    : null;
}
