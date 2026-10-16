import type { V2AccountOffer } from '@apple-business/shared';
import { currentV2BusinessDate } from '@/v2/utils/dateTime';
import type { BankChatgptAccount } from './bank-recharge-api';

export interface ChatgptAccountEditorForm {
  email: string;
  registrationCountryCode: string;
  registeredDate: string;
  password: string;
  totpSecret: string;
  remark: string;
  active: boolean;
  offerStatus: V2AccountOffer;
}

export function chatgptAccountEditPayload(
  form: ChatgptAccountEditorForm,
  account: BankChatgptAccount,
  version: string | null | undefined
) {
  const payload: Record<string, unknown> = {
    remark: form.remark,
    status: form.active ? 'active' : 'disabled',
    expectedUpdatedAt: version
  };
  if (form.registrationCountryCode !== (account.registrationCountryCode ?? ''))
    payload.registrationCountryCode = form.registrationCountryCode || null;
  if (form.offerStatus !== (account.offerStatus ?? 'unknown'))
    payload.offerStatus = form.offerStatus;
  if (form.registeredDate && form.registeredDate !== currentV2BusinessDate(account.registeredAt))
    payload.registeredDate = form.registeredDate;
  if (form.password) payload.password = form.password;
  if (form.totpSecret) payload.totpSecret = form.totpSecret;
  if (form.email.trim()) payload.email = form.email.trim();
  return payload;
}
