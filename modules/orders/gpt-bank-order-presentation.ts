import type { V2GptBankOrderPlan } from '../contracts/subscription-orders.ts';

export const gptBankOrderPlanLabels: Record<V2GptBankOrderPlan, string> = {
  go: 'Go',
  plus: 'Plus',
  pro_5x: 'Pro 5x',
  pro_20x: 'Pro 20x',
  pro_50x: 'Pro 50x'
};

export const gptBankOrderBusinessLabels = {
  renewal: '续费',
  finished_delivery: '成品交付'
} as const;

export const gptBankOrderCostLabels = { standard: '标准成本', actual: '实际成本' } as const;

export const gptBankCardSearchHint = '请输入银行卡尾六位或名称，避免输入完整卡号';

export function isGptBankCardSearchAllowed(keyword: string) {
  const normalized = keyword.normalize('NFKC').trim();
  return !/^\d{7,}$/.test(normalized) && (normalized.match(/[0-9]/g)?.length ?? 0) < 13;
}

export function gptBankOrderActor(actor: { displayName: string; username: string } | null) {
  return actor?.displayName || actor?.username || '—';
}

export function gptBankOrderConfirmationLabel(confirmed: boolean) {
  return confirmed ? '已确认' : '待确认';
}
