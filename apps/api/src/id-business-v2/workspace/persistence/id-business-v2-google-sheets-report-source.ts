import { Prisma } from '@prisma/client';
import {
  GOOGLE_SHEETS_ROW_LIMIT,
  retainGoogleSheetsRecords,
  type GoogleSheetsReportRetention,
  type GoogleSheetsRetentionCursor
} from '../id-business-v2-google-sheets-retention';
import {
  ORDER_REPORT_SELECT,
  GIFT_CARD_REPORT_SELECT,
  RENEWAL_REPORT_SELECT,
  FINANCE_REPORT_SELECT,
  BANK_CARD_REPORT_SELECT,
  CHATGPT_REPORT_SELECT,
  CUSTOMER_REPORT_SELECT,
  FINANCE_ENTRY_REPORT_SELECT,
  MAILBOX_REPORT_SELECT,
  WALLET_REPORT_SELECT
} from './id-business-v2-google-sheets-detail.select';

function after(cursor?: GoogleSheetsRetentionCursor) {
  if (!cursor) return {};
  const createdAt = cursor.createdAt;
  return { OR: [{ createdAt: { gt: createdAt } }, { createdAt, id: { gt: cursor.id } }] };
}

// Counts and rows share one read snapshot. No business records are deleted here.
export async function loadGoogleSheetsReportSource(
  tx: Prisma.TransactionClient,
  previous: GoogleSheetsReportRetention
) {
  const filters = {
    orders: { deletedAt: null, ...after(previous.records.orders) },
    giftCards: after(previous.records.giftCards),
    renewals: after(previous.records.renewals),
    chatgptAccounts: { ...after(previous.records.chatgptAccounts), deletedAt: null },
    mailboxes: after(previous.records.mailboxes),
    bankCards: after(previous.records.bankCards),
    customers: { deletedAt: null, ...after(previous.records.customers) },
    wallets: after(previous.records.wallets),
    financeEntries: after(previous.records.financeEntries)
  };
  const orderBy = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];
  const take = GOOGLE_SHEETS_ROW_LIMIT;
  const [
    orders,
    giftCards,
    renewals,
    chatgptAccounts,
    mailboxes,
    bankCards,
    customers,
    wallets,
    financeEntries,
    financeJournals
  ] = await Promise.all([
    Promise.all([
      tx.idBusinessV2Order.count({ where: filters.orders }),
      tx.idBusinessV2Order.findMany({
        where: filters.orders,
        orderBy,
        take,
        select: ORDER_REPORT_SELECT
      })
    ]),
    Promise.all([
      tx.idBusinessV2GiftCard.count({ where: filters.giftCards }),
      tx.idBusinessV2GiftCard.findMany({
        where: filters.giftCards,
        orderBy,
        take,
        select: GIFT_CARD_REPORT_SELECT
      })
    ]),
    Promise.all([
      tx.idBusinessV2Activation.count({ where: filters.renewals }),
      tx.idBusinessV2Activation.findMany({
        where: filters.renewals,
        orderBy,
        take,
        select: RENEWAL_REPORT_SELECT
      })
    ]),
    Promise.all([
      tx.idBusinessV2ChatgptAccount.count({ where: filters.chatgptAccounts }),
      tx.idBusinessV2ChatgptAccount.findMany({
        where: filters.chatgptAccounts,
        orderBy,
        take,
        select: CHATGPT_REPORT_SELECT
      })
    ]),
    Promise.all([
      tx.idBusinessV2ManagedMailbox.count({ where: filters.mailboxes }),
      tx.idBusinessV2ManagedMailbox.findMany({
        where: filters.mailboxes,
        orderBy,
        take,
        select: MAILBOX_REPORT_SELECT
      })
    ]),
    Promise.all([
      tx.idBusinessV2BankRechargeCard.count({ where: filters.bankCards }),
      tx.idBusinessV2BankRechargeCard.findMany({
        where: filters.bankCards,
        orderBy,
        take,
        select: BANK_CARD_REPORT_SELECT
      })
    ]),
    Promise.all([
      tx.idBusinessV2Customer.count({ where: filters.customers }),
      tx.idBusinessV2Customer.findMany({
        where: filters.customers,
        orderBy,
        take,
        select: CUSTOMER_REPORT_SELECT
      })
    ]),
    Promise.all([
      tx.idBusinessV2FinanceAccount.count({ where: filters.wallets }),
      tx.idBusinessV2FinanceAccount.findMany({
        where: filters.wallets,
        orderBy,
        take,
        select: WALLET_REPORT_SELECT
      })
    ]),
    Promise.all([
      tx.idBusinessV2FinanceJournalLine.count({ where: filters.financeEntries }),
      tx.idBusinessV2FinanceJournalLine.findMany({
        where: filters.financeEntries,
        orderBy,
        take,
        select: FINANCE_ENTRY_REPORT_SELECT
      })
    ]),
    tx.idBusinessV2FinanceJournal.findMany({
      orderBy: [{ businessDate: 'desc' }, { id: 'desc' }],
      take,
      select: FINANCE_REPORT_SELECT
    })
  ]);
  const windows = {
    orders: retainGoogleSheetsRecords(orders[1], orders[0], previous.records.orders),
    giftCards: retainGoogleSheetsRecords(giftCards[1], giftCards[0], previous.records.giftCards),
    renewals: retainGoogleSheetsRecords(renewals[1], renewals[0], previous.records.renewals),
    chatgptAccounts: retainGoogleSheetsRecords(
      chatgptAccounts[1],
      chatgptAccounts[0],
      previous.records.chatgptAccounts
    ),
    mailboxes: retainGoogleSheetsRecords(mailboxes[1], mailboxes[0], previous.records.mailboxes),
    bankCards: retainGoogleSheetsRecords(bankCards[1], bankCards[0], previous.records.bankCards),
    customers: retainGoogleSheetsRecords(customers[1], customers[0], previous.records.customers),
    wallets: retainGoogleSheetsRecords(wallets[1], wallets[0], previous.records.wallets),
    financeEntries: retainGoogleSheetsRecords(
      financeEntries[1],
      financeEntries[0],
      previous.records.financeEntries
    )
  };
  const records: GoogleSheetsReportRetention['records'] = Object.fromEntries(
    Object.entries(windows).flatMap(([name, window]) =>
      window.cursor ? [[name, window.cursor]] : []
    )
  );
  const tables = {
    orders: 'id_business_v2_orders',
    giftCards: 'id_business_v2_gift_cards',
    renewals: 'id_business_v2_activations',
    chatgptAccounts: 'id_business_v2_chatgpt_accounts',
    mailboxes: 'id_business_v2_managed_mailboxes',
    bankCards: 'id_business_v2_bank_recharge_cards',
    customers: 'id_business_v2_customers',
    wallets: 'id_business_v2_finance_accounts',
    financeEntries: 'id_business_v2_finance_journal_lines'
  } as const;
  // MySQL stores microseconds; JS Date drops them. Preserve the exact cutoff so same-millisecond rows stay retired.
  for (const name of Object.keys(records) as Array<keyof typeof records>) {
    const cursor = records[name]!;
    if (
      cursor === previous.records[name] ||
      (cursor.id === previous.records[name]?.id &&
        cursor.createdAt === previous.records[name]?.createdAt)
    )
      continue;
    const table = Prisma.raw(tables[name]);
    const rows = await tx.$queryRaw<Array<{ createdAt: string }>>(
      Prisma.sql`SELECT DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS createdAt FROM ${table} WHERE id = ${cursor.id} LIMIT 1`
    );
    if (!rows[0]?.createdAt) throw new Error('Google 报表清理边界记录不存在');
    records[name] = { ...cursor, createdAt: rows[0].createdAt };
  }
  return {
    orders: windows.orders.rows,
    giftCards: windows.giftCards.rows,
    renewals: windows.renewals.rows,
    chatgptAccounts: windows.chatgptAccounts.rows,
    mailboxes: windows.mailboxes.rows,
    bankCards: windows.bankCards.rows,
    customers: windows.customers.rows,
    wallets: windows.wallets.rows,
    financeEntries: windows.financeEntries.rows,
    financeJournals,
    retention: { ...previous, records }
  };
}
