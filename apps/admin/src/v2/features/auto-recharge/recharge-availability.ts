import type { V2RechargeAvailability, V2RechargeJob } from './contracts';

export const executionAvailabilityLabels: Record<V2RechargeAvailability['execution'], string> = {
  active: '本次任务仍在执行',
  released: '执行名额已释放',
  expired: '执行租约已结束'
};
export const paymentAvailabilityLabels: Record<V2RechargeAvailability['payment'], string> = {
  no_request: '本次未发送付款请求',
  unknown: '付款结果待核实',
  declined: '官网已明确拒付',
  paid_pending: '已有付款凭证，订阅待生效',
  completed: '付款与订阅均已核实',
  resolved: '原单已核实处理'
};

export function paymentBlockedForAccount(
  job: V2RechargeJob,
  account: { reference?: string; savedId?: string }
) {
  const same =
    Boolean(account.reference && job.availability?.accountReference === account.reference) ||
    Boolean(account.savedId && job.chatgptAccountId === account.savedId);
  if (!same) return false;
  if (job.availability) return job.availability.accountPaymentRestricted;
  const r = job.result;
  if (r.manual_settlement) return false;
  return (
    r.mode !== 'open_browser' &&
    r.operator_resolution !== 'confirmed_no_bank_request' &&
    r.status !== 'subscription_activated' &&
    r.payment_status !== 'declined' &&
    (r.payment_attempted === true ||
      Number(r.payment_requests_sent ?? 0) > 0 ||
      Number(r.confirmation_requests_sent ?? 0) > 0 ||
      ['paid', 'unknown', 'requires_action'].includes(String(r.payment_status)))
  );
}

export async function accountReferenceFromJson(raw: string): Promise<string | undefined> {
  try {
    const value = JSON.parse(raw) as { account?: { id?: unknown } };
    const id = value.account?.id;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id) || !crypto.subtle) return;
    const digest = async (text: string) =>
      Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
      )
        .map((value) => value.toString(16).padStart(2, '0'))
        .join('');
    return await digest(await digest(id));
  } catch {
    return;
  }
}
