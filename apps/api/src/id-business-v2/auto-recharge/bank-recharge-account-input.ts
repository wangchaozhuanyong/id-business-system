import { BadRequestException } from '@nestjs/common';
import { parseIdBusinessV2TotpSecret } from '../workspace/public-api';
import {
  bankRechargeObject,
  bankRechargeEmail,
  bankRechargePassword,
  bankRechargeText,
  bankRechargeCountryCode
} from './bank-recharge-validation';

export type NewChatgptAccount = {
  email: string;
  registrationCountryCode: string | null;
  password: string;
  totp: ReturnType<typeof parseIdBusinessV2TotpSecret> | null;
  remark: string;
};

export function parseNewChatgptAccount(value: unknown): NewChatgptAccount {
  const input = bankRechargeObject(value);
  const email = bankRechargeEmail(input.email);
  const password =
    input.password === undefined || input.password === ''
      ? ''
      : bankRechargePassword(input.password);
  const totpInput = bankRechargeText(input.totpSecret, '2FA 密钥', 2048, false);
  let totp: ReturnType<typeof parseIdBusinessV2TotpSecret> | null = null;
  if (totpInput) {
    try {
      totp = parseIdBusinessV2TotpSecret(totpInput);
    } catch {
      throw new BadRequestException('2FA 密钥格式无效');
    }
  }
  const remark = bankRechargeText(input.remark, '备注', 500, false);
  const registrationCountryCode = bankRechargeCountryCode(input.registrationCountryCode);
  return { email, registrationCountryCode, password, totp, remark };
}
