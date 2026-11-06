import { toV2DateTimeInput, v2DateTimeInputToIso } from '../time/dateTime.ts';
import type { V2GoogleMailbox, V2GoogleMailboxInput } from './contracts.ts';

export interface GoogleMailboxForm extends V2GoogleMailboxInput {
  registeredInput: string;
  expectedVersion: number | null;
}
export function googleMailboxForm(row?: V2GoogleMailbox | null): GoogleMailboxForm {
  return {
    email: row?.email ?? '',
    password: row?.password ?? '',
    totpSecret: row?.totpSecret ?? '',
    recoveryEmail: row?.recoveryEmail ?? '',
    phone: row?.phone ?? '',
    phoneUnboundConfirmed: row?.phoneUnboundConfirmed ?? false,
    countryOptionId: row?.countryOptionId ?? '',
    appPassword: row?.appPassword ?? '',
    health: row?.health ?? 'normal',
    sourceOptionId: row?.sourceOptionId ?? '',
    registeredAt: row?.registeredAt ?? null,
    registeredInput: row?.registeredAt ? toV2DateTimeInput(row.registeredAt) : '',
    loginDevice: row?.loginDevice ?? '',
    remark1: row?.remark1 ?? '',
    remark2: row?.remark2 ?? '',
    expectedVersion: row?.version ?? null
  };
}

export function googleMailboxInput(form: GoogleMailboxForm): V2GoogleMailboxInput {
  const phone = form.phone?.trim() ?? '';
  if (!form.email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim()))
    throw new Error('请输入有效的谷歌邮箱');
  if (!form.password.trim()) throw new Error('请输入邮箱密码');
  if (!form.sourceOptionId) throw new Error('请选择来源渠道');
  if (Boolean(phone) === form.phoneUnboundConfirmed)
    throw new Error('请填写绑定电话，或明确确认未绑定电话，二者选一');
  const registeredAt = !form.registeredInput
    ? null
    : form.registeredAt && form.registeredInput === toV2DateTimeInput(form.registeredAt)
      ? form.registeredAt
      : v2DateTimeInputToIso(form.registeredInput);
  if (form.registeredInput && !registeredAt) throw new Error('请输入有效的北京时间');
  return {
    email: form.email.trim().toLowerCase(),
    password: form.password,
    totpSecret: form.totpSecret?.trim(),
    recoveryEmail: form.recoveryEmail?.trim(),
    phone,
    phoneUnboundConfirmed: form.phoneUnboundConfirmed,
    countryOptionId: form.countryOptionId || null,
    appPassword: form.appPassword?.trim(),
    health: form.health,
    sourceOptionId: form.sourceOptionId,
    registeredAt,
    loginDevice: form.loginDevice?.trim(),
    remark1: form.remark1?.trim(),
    remark2: form.remark2?.trim()
  };
}
