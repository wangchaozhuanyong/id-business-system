import { Prisma } from '@prisma/client';
import type { V2CommandTransaction } from '../../runtime/public-api';
import { PrismaService } from '../../../common/prisma/prisma.service';

type Database = PrismaService | V2CommandTransaction;

export const chatgptRestoreSelect = {
  id: true,
  emailMasked: true,
  status: true,
  deletedAt: true,
  updatedAt: true,
  officialAccountKey: true,
  subscription: { select: { id: true } },
  _count: { select: { jobs: true, orders: true, registrationJobs: true } }
} satisfies Prisma.IdBusinessV2ChatgptAccountSelect;

export const bankOrderRestoreSelect = {
  id: true,
  orderNo: true,
  deletedAt: true,
  updatedAt: true,
  source: true,
  status: true,
  financeStatus: true,
  verifiedAt: true,
  rechargeJobId: true,
  checkoutIdentifier: true,
  paymentEvidenceId: true,
  receivedAmount: true,
  activeSubscription: { select: { status: true } },
  renewedBy: { select: { id: true } }
} satisfies Prisma.IdBusinessV2BankRechargeOrderSelect;

export function chatgptRestoreAllowed(
  item: Prisma.IdBusinessV2ChatgptAccountGetPayload<{ select: typeof chatgptRestoreSelect }>
) {
  return (
    item.status === 'disabled' &&
    !item.officialAccountKey &&
    !item.subscription &&
    Object.values(item._count).every((count) => count === 0)
  );
}

export function bankOrderRestoreAllowed(
  item: Prisma.IdBusinessV2BankRechargeOrderGetPayload<{ select: typeof bankOrderRestoreSelect }>,
  journals: number
) {
  return (
    item.source === 'manual' &&
    item.status === 'cancelled' &&
    item.financeStatus === 'unposted' &&
    !item.verifiedAt &&
    !item.rechargeJobId &&
    !item.checkoutIdentifier &&
    !item.paymentEvidenceId &&
    (!item.receivedAmount || item.receivedAmount.isZero()) &&
    journals === 0 &&
    !item.renewedBy &&
    item.activeSubscription?.status !== 'active'
  );
}

export function restoreChatgptAccount(
  tx: V2CommandTransaction,
  input: { id: string; deletedAt: Date; updatedAt: Date; operatorId: string }
) {
  return tx.idBusinessV2ChatgptAccount.updateMany({
    where: {
      id: input.id,
      deletedAt: input.deletedAt,
      updatedAt: input.updatedAt,
      status: 'disabled',
      officialAccountKey: null,
      jobs: { none: {} },
      orders: { none: {} },
      registrationJobs: { none: {} },
      subscription: { is: null }
    },
    data: { deletedAt: null, status: 'disabled', updatedByUserId: input.operatorId }
  });
}

export function restoreBankOrder(
  tx: V2CommandTransaction,
  input: { id: string; deletedAt: Date; updatedAt: Date; operatorId: string }
) {
  return tx.idBusinessV2BankRechargeOrder.updateMany({
    where: {
      id: input.id,
      deletedAt: input.deletedAt,
      updatedAt: input.updatedAt,
      source: 'manual',
      status: 'cancelled',
      financeStatus: 'unposted',
      verifiedAt: null,
      rechargeJobId: null,
      checkoutIdentifier: null,
      paymentEvidenceId: null,
      renewedBy: { is: null },
      OR: [{ receivedAmount: null }, { receivedAmount: '0' }],
      NOT: { activeSubscription: { is: { status: 'active' } } }
    },
    data: {
      deletedAt: null,
      status: 'pending_details',
      openedAt: null,
      dueAt: null,
      updatedByUserId: input.operatorId
    }
  });
}

export function findChatgptRestoreState(tx: V2CommandTransaction, id: string) {
  return tx.idBusinessV2ChatgptAccount.findUnique({ where: { id }, select: chatgptRestoreSelect });
}

export async function findBankOrderRestoreState(tx: V2CommandTransaction, id: string) {
  const [item, journals] = await Promise.all([
    tx.idBusinessV2BankRechargeOrder.findUnique({ where: { id }, select: bankOrderRestoreSelect }),
    tx.idBusinessV2FinanceJournal.count({ where: { sourceType: 'bank_recharge', sourceId: id } })
  ]);
  return { item, journals };
}

export async function bankRestoreSources(
  database: Database,
  ids: { chatgpt_account: string[]; bank_recharge_order: string[] }
) {
  const [chatgptAccounts, bankOrders, journals] = await Promise.all([
    ids.chatgpt_account.length
      ? database.idBusinessV2ChatgptAccount.findMany({
          where: { id: { in: ids.chatgpt_account } },
          select: chatgptRestoreSelect
        })
      : [],
    ids.bank_recharge_order.length
      ? database.idBusinessV2BankRechargeOrder.findMany({
          where: { id: { in: ids.bank_recharge_order } },
          select: bankOrderRestoreSelect
        })
      : [],
    ids.bank_recharge_order.length
      ? database.idBusinessV2FinanceJournal.findMany({
          where: { sourceType: 'bank_recharge', sourceId: { in: ids.bank_recharge_order } },
          select: { sourceId: true }
        })
      : []
  ]);
  return {
    chatgptAccounts,
    bankOrders,
    bankJournalIds: new Set(journals.map((item) => item.sourceId))
  };
}
