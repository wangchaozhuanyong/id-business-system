import type { BankChatgptAccount } from './bank-recharge-api';

export type ChatgptAccountView = 'all' | 'active' | 'sold' | 'deleted';

export function chatgptAccountInventoryFilter(view: ChatgptAccountView) {
  return {
    subscriptionState: view === 'active' ? 'never_subscribed' : 'all',
    saleStatus:
      view === 'active'
        ? ('unsold' as const)
        : view === 'sold'
          ? ('sold' as const)
          : ('all' as const),
    deleted: view === 'deleted' ? ('deleted' as const) : ('active' as const)
  };
}

export function canChangeChatgptAccountSale(account: BankChatgptAccount) {
  return !account.deletedAt && (account.saleStatus === 'sold' || account.registered === true);
}
