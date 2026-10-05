import { Injectable } from '@nestjs/common';
import type { IdBusinessV2FinanceJournal, IdBusinessV2FinanceJournalLine } from '@prisma/client';
import { getSystemSuperAdminUserId } from '../../../v2-auth/system-super-admin';
import { mapAmount4, mapRate8, type V2CommandTransaction } from '../../runtime/public-api';
import {
  findLockedJournalReplay,
  lockFinanceAccount
} from './id-business-v2-finance-posting.repository';

@Injectable()
export class IdBusinessV2HistoricalCashRepository {
  async lockBatchGate(tx: V2CommandTransaction) {
    const rows = await tx.$queryRaw<Array<{ id: number }>>`
      SELECT \`id\` FROM \`id_business_v2_finance_settings\` WHERE \`id\` = 1 FOR UPDATE
    `;
    return Boolean(rows.length);
  }

  async readOperator(tx: V2CommandTransaction, id: string) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT \`id\` FROM \`users\` WHERE \`id\` = ${id} FOR SHARE
    `;
    if (!rows.length) return null;
    const user = await tx.user.findUnique({
      where: { id },
      select: {
        id: true,
        username: true,
        displayName: true,
        status: true,
        deletedAt: true,
        v2AuthIdentity: { select: { enabled: true, mustResetPassword: true } },
        userRoles: {
          select: {
            role: {
              select: {
                code: true,
                rolePermissions: { select: { permission: { select: { code: true } } } }
              }
            }
          }
        }
      }
    });
    if (!user) return null;
    return { ...user, systemSuperAdminId: await getSystemSuperAdminUserId(tx) };
  }

  async findBatchReceipt(tx: V2CommandTransaction, idempotencyKey: string) {
    const rows = await tx.$queryRaw<Array<{ id: string; afterData: unknown }>>`
      SELECT \`id\`, \`after_data\` AS \`afterData\` FROM \`audit_logs\`
      WHERE \`module\` = 'id_business_v2_finance'
        AND \`action\` = 'id_business_v2.historical_cash.execute'
        AND JSON_UNQUOTE(JSON_EXTRACT(\`after_data\`, '$.idempotencyKey')) = ${idempotencyKey}
      FOR SHARE
    `;
    return rows;
  }

  async findVerification(tx: V2CommandTransaction, sourceLineId: string) {
    const rows = await tx.$queryRaw<Array<{ id: string; afterData: unknown }>>`
      SELECT \`id\`, \`after_data\` AS \`afterData\` FROM \`audit_logs\`
      WHERE \`module\` = 'id_business_v2_finance'
        AND \`action\` = 'id_business_v2.historical_cash.verify'
        AND \`object_id\` = ${sourceLineId}
      FOR SHARE
    `;
    return rows;
  }

  findAdjustment(tx: V2CommandTransaction, key: string) {
    return findLockedJournalReplay(tx, key);
  }

  async findSourceExpense(tx: V2CommandTransaction, journalId: string) {
    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        financeAccountId: string;
        currency: string;
        amountOriginal: unknown;
        amountCny: unknown;
      }>
    >`
      SELECT \`id\`, \`finance_account_id\` AS \`financeAccountId\`, \`currency\`,
        \`amount_original\` AS \`amountOriginal\`, \`amount_cny\` AS \`amountCny\`
      FROM \`id_business_v2_finance_expenses\` WHERE \`journal_id\` = ${journalId} FOR SHARE
    `;
    const row = rows[0];
    return row
      ? {
          ...row,
          amountOriginal: mapAmount4(
            row.amountOriginal,
            'historical_cash.expense_original'
          ).toString(),
          amountCny: mapAmount4(row.amountCny, 'historical_cash.expense_cny').toString()
        }
      : null;
  }

  findSourceJournalIds(tx: V2CommandTransaction, lineIds: string[]) {
    return tx.idBusinessV2FinanceJournalLine.findMany({
      where: { id: { in: lineIds } },
      select: { id: true, journalId: true }
    });
  }

  async findOrderJournalIds(tx: V2CommandTransaction, orderId: string) {
    return tx.$queryRaw<Array<{ id: string }>>`
      SELECT \`id\` FROM \`id_business_v2_finance_journals\`
      WHERE \`source_type\` = 'order' AND \`source_id\` = ${orderId}
      ORDER BY \`id\` FOR SHARE
    `;
  }

  async lockSource(tx: V2CommandTransaction, id: string) {
    const journals = await tx.$queryRaw<IdBusinessV2FinanceJournal[]>`
      SELECT \`id\`, \`journal_no\` AS \`journalNo\`, \`journal_type\` AS \`journalType\`,
        \`source_type\` AS \`sourceType\`, \`source_id\` AS \`sourceId\`, \`source_reference\` AS \`sourceReference\`,
        \`business_date\` AS \`businessDate\`, \`period_month\` AS \`periodMonth\`, \`occurred_at\` AS \`occurredAt\`,
        \`status\`, \`reversal_of_journal_id\` AS \`reversalOfJournalId\`, \`reversed_at\` AS \`reversedAt\`,
        \`summary\`, \`metadata\`, \`idempotency_key\` AS \`idempotencyKey\`, \`created_by_user_id\` AS \`createdByUserId\`,
        \`created_at\` AS \`createdAt\`, \`updated_at\` AS \`updatedAt\`
      FROM \`id_business_v2_finance_journals\` WHERE \`id\` = ${id} FOR UPDATE
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
      WHERE \`journal_id\` = ${id} ORDER BY \`line_no\` FOR SHARE
    `;
    const reversals = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT \`id\` FROM \`id_business_v2_finance_journals\`
      WHERE \`reversal_of_journal_id\` = ${id} FOR SHARE
    `;
    return {
      ...journal,
      hasReversal: Boolean(reversals.length),
      lines: lines.map((line) => ({
        ...line,
        amountOriginal: mapAmount4(
          line.amountOriginal,
          'historical_cash.amount_original'
        ).toString(),
        fxRateToCny: mapRate8(line.fxRateToCny, 'historical_cash.fx_rate').toString(),
        amountCny: mapAmount4(line.amountCny, 'historical_cash.amount_cny').toString()
      }))
    };
  }

  async lockAccount(tx: V2CommandTransaction, id: string) {
    const account = await lockFinanceAccount(tx, id);
    if (!account) return null;
    const rows = await tx.$queryRaw<Array<{ updatedAt: Date }>>`
      SELECT \`updated_at\` AS \`updatedAt\` FROM \`id_business_v2_finance_accounts\` WHERE \`id\` = ${id} FOR UPDATE
    `;
    return { ...account, updatedAt: rows[0].updatedAt };
  }

  async lockOrder(tx: V2CommandTransaction, id: string) {
    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        status: string;
        updatedAt: Date;
        receivedFinanceAccountId: string | null;
        receivedCurrency: string;
        receivedAmount: unknown;
        receivedOriginalAmount: unknown;
        receivedFxRateToCny: unknown;
      }>
    >`
      SELECT \`id\`, \`status\`, \`updated_at\` AS \`updatedAt\`, \`received_finance_account_id\` AS \`receivedFinanceAccountId\`,
        \`received_currency\` AS \`receivedCurrency\`, \`received_amount\` AS \`receivedAmount\`,
        \`received_original_amount\` AS \`receivedOriginalAmount\`, \`received_fx_rate_to_cny\` AS \`receivedFxRateToCny\`
      FROM \`id_business_v2_orders\` WHERE \`id\` = ${id} FOR UPDATE
    `;
    const row = rows[0];
    return row
      ? {
          ...row,
          receivedAmount: mapAmount4(row.receivedAmount, 'historical_cash.order_amount').toString(),
          receivedOriginalAmount: mapAmount4(
            row.receivedOriginalAmount,
            'historical_cash.order_original'
          ).toString(),
          receivedFxRateToCny: mapRate8(
            row.receivedFxRateToCny,
            'historical_cash.order_fx'
          ).toString()
        }
      : null;
  }

  attributeOrder(
    tx: V2CommandTransaction,
    id: string,
    expectedUpdatedAt: Date,
    targetAccountId: string,
    operatorId: string
  ) {
    return tx.idBusinessV2Order.updateMany({
      where: { id, updatedAt: expectedUpdatedAt, receivedFinanceAccountId: null },
      data: { receivedFinanceAccountId: targetAccountId, updatedByUserId: operatorId }
    });
  }
}
