import type { BankChatgptAccount } from './bank-recharge-api';
import { statusLabel } from './recharge-presentation';

export function canSelectRechargeAccount(account: BankChatgptAccount) {
  // 资料库套餐仅用于提示；实际开通、升级或无需付款由所属官网窗口重新核实。
  return account.status === 'active';
}

export function rechargeAccountOptionLabel(account: BankChatgptAccount) {
  const current = account.currentPlan ? ` · ${statusLabel(account.currentPlan)}（历史记录）` : '';
  return `${account.emailMasked}${current}${account.hasPassword ? '' : ' · 请先补充登录密码'}`;
}
