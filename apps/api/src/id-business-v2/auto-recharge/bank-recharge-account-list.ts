import { getPagination } from '../../common/pagination';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import {
  accountListItem,
  parseAccountSubscriptionState
} from './bank-recharge-account-subscription';
import { bankRechargeText } from './bank-recharge-validation';
import {
  BankRechargeRepository,
  bankRechargeAccountFilter
} from './persistence/bank-recharge.repository';
import { loginNetworkSummary } from './recharge-login-network';
import { readBankRechargeCardSummary } from './bank-recharge-card-summary';
import { V2_ACCOUNT_OFFERS, type V2AccountOffer } from '@apple-business/shared';
import { BadRequestException } from '@nestjs/common';

export type ChatgptAccountListQuery = {
  page?: string;
  pageSize?: string;
  keyword?: string;
  subscriptionState?: string;
  offerStatus?: string;
  deleted?: string;
};

export async function listChatgptAccounts(
  query: ChatgptAccountListQuery,
  repository: BankRechargeRepository,
  encryption: FieldEncryptionService
) {
  const pagination =
    query.page !== undefined || query.pageSize !== undefined ? getPagination(query) : null;
  const keyword = bankRechargeText(query.keyword, '搜索内容', 250, false);
  const subscriptionState = parseAccountSubscriptionState(query.subscriptionState);
  const now = Date.now();
  const warningBoundary = now + (await repository.renewalWarningDays()) * 24 * 60 * 60 * 1000;
  if (
    query.offerStatus &&
    query.offerStatus !== 'all' &&
    !V2_ACCOUNT_OFFERS.includes(query.offerStatus as V2AccountOffer)
  )
    throw new BadRequestException('优惠筛选无效');
  if (query.deleted && !['active', 'deleted'].includes(query.deleted))
    throw new BadRequestException('删除状态筛选无效');
  const where = {
    deletedAt: query.deleted === 'deleted' ? { not: null } : null,
    ...bankRechargeAccountFilter(
      keyword,
      keyword.includes('@') ? encryption.hash(keyword.toLowerCase()) : null,
      subscriptionState,
      new Date(now),
      new Date(warningBoundary)
    ),
    ...(query.offerStatus && query.offerStatus !== 'all'
      ? { offerStatus: query.offerStatus as V2AccountOffer }
      : {})
  };
  const items = await repository.listAccounts({
    where,
    ...(pagination ? { skip: pagination.skip, take: pagination.take } : {})
  });
  const [subscriptions, networks, openingCards, sources] = await Promise.all([
    repository.subscriptionsForAccounts(items.map((item) => item.id)),
    repository.loginNetworksByEmailHashes(items.map((item) => item.emailHash)),
    repository.openingCardsForAccounts(items.map((item) => item.id)),
    repository.registrationSourceAudits(items.map((item) => item.id))
  ]);
  const sourcesByAccount = new Map<string, 'automatic' | 'manual'>();
  const awaitingAuthorization = new Set<string>();
  const verifiedAuthorization = new Set<string>();
  for (const source of sources) {
    if (source.objectId && !sourcesByAccount.has(source.objectId)) {
      sourcesByAccount.set(
        source.objectId,
        source.action.endsWith('.manual_registered_mirror') ? 'manual' : 'automatic'
      );
    }
    if (
      source.objectId &&
      source.afterData &&
      typeof source.afterData === 'object' &&
      !Array.isArray(source.afterData)
    ) {
      if (source.afterData.identityStatus === 'creation_confirmed')
        awaitingAuthorization.add(source.objectId);
      if (source.afterData.identityStatus === 'verified')
        verifiedAuthorization.add(source.objectId);
    }
  }
  const subscriptionsByAccount = new Map(subscriptions.map((item) => [item.accountId, item]));
  const networksByEmail = new Map(networks.map((item) => [item.emailHash, item]));
  const openingByAccount = new Map<
    string,
    {
      id: string | null;
      label: string | null;
      last4: string | null;
      numberSummary: string | null;
      deleted: boolean;
    }
  >();
  for (const order of openingCards) {
    if (!order.accountId || openingByAccount.has(order.accountId)) continue;
    openingByAccount.set(order.accountId, {
      id: order.card?.id ?? null,
      label: order.card?.label ?? order.cardLabelSnapshot,
      last4: order.card?.last4 ?? order.cardLast4,
      numberSummary: readBankRechargeCardSummary(
        encryption,
        order.cardNumberSummaryEncrypted,
        order.card?.numberEncrypted
      ),
      deleted:
        order.channel === 'online'
          ? !order.onlineRechargeCard
          : Boolean(order.cardDeletedAt) || (!order.card && Boolean(order.cardLabelSnapshot))
    });
  }
  const total = pagination ? await repository.countAccounts(where) : items.length;
  return {
    total,
    page: pagination?.page ?? 1,
    pageSize: pagination?.pageSize ?? total,
    items: items.map((item) => ({
      ...accountListItem(item, subscriptionsByAccount.get(item.id), now, warningBoundary),
      registrationIp: encryption.decrypt(item.registrationIpEncrypted) ?? null,
      registrationSource: sourcesByAccount.get(item.id) ?? null,
      needsSupplement:
        (awaitingAuthorization.has(item.id) && !verifiedAuthorization.has(item.id)) ||
        !item.passwordEncrypted ||
        !item.registrationIpEncrypted ||
        !item.registrationCountryCode ||
        !item.registeredAt,
      ...loginNetworkSummary(networksByEmail.get(item.emailHash), encryption),
      openingCard: openingByAccount.get(item.id) ?? null
    }))
  };
}
