import type { BankChatgptAccount } from './bank-recharge-api';

export function canSelectRechargeAccount(account: BankChatgptAccount, targetPlan: string) {
  if (account.status !== 'active') return false;
  if (['never_subscribed', 'expired'].includes(account.subscriptionState)) return true;
  return (
    ['pro-5x', 'pro-20x', 'pro-500'].includes(targetPlan) &&
    account.currentPlan === 'plus' &&
    ['active', 'due_soon'].includes(account.subscriptionState)
  );
}

export function rechargeAccountOptionLabel(account: BankChatgptAccount) {
  const upgrade =
    account.currentPlan === 'plus' && ['active', 'due_soon'].includes(account.subscriptionState);
  return `${account.emailMasked}${upgrade ? ' · Plus 升级' : ''}${account.hasPassword ? '' : ' · 未保存密码'}`;
}
