import { BadRequestException } from '@nestjs/common';
import {
  bankRechargeCurrency,
  bankRechargeObject,
  bankRechargeText
} from './bank-recharge-validation';

export type ManagedCardInput = {
  number: string;
  last4: string;
  expiry: string;
  label: string;
  currencyCode: string;
  remark1: string;
  remark2: string;
};

export function cardNumber(value: unknown) {
  const number = typeof value === 'string' ? value.replace(/[ -]/g, '') : '';
  if (!/^\d{13,19}$/.test(number)) throw new BadRequestException('银行卡号格式无效');
  let sum = 0;
  for (let index = number.length - 1; index >= 0; index -= 1) {
    let digit = Number(number[index]);
    if ((number.length - index) % 2 === 0) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  if (sum % 10 !== 0) throw new BadRequestException('银行卡号校验失败');
  return number;
}

export function cardExpiry(value: unknown) {
  const expiry = bankRechargeText(value, '有效期', 5);
  const match = /^(0[1-9]|1[0-2])\/(\d{2})$/.exec(expiry);
  if (!match) throw new BadRequestException('有效期请使用 MM/YY 格式');
  const endOfMonth = new Date(2000 + Number(match[2]), Number(match[1]), 0, 23, 59, 59, 999);
  if (endOfMonth < new Date()) throw new BadRequestException('银行卡已过有效期');
  return expiry;
}

export function parseManagedCard(value: unknown, currency?: string): ManagedCardInput {
  const input = bankRechargeObject(value);
  if (
    Object.keys(input).some(
      (key) => !['number', 'expiry', 'label', 'currencyCode', 'remark1', 'remark2'].includes(key)
    )
  )
    throw new BadRequestException('银行卡资料包含不支持的字段；安全码不能导入或保存');
  const number = cardNumber(input.number);
  const remark1 = bankRechargeText(input.remark1, '备注1', 500, false);
  const remark2 = bankRechargeText(input.remark2, '备注2', 500, false);
  if (/^\d{3,4}$/.test(remark1) || /^\d{3,4}$/.test(remark2)) {
    throw new BadRequestException('不能把安全码填入备注；安全码仅在单笔充值时临时输入');
  }
  return {
    number,
    last4: number.slice(-4),
    expiry: cardExpiry(input.expiry),
    label:
      bankRechargeText(input.label, '银行卡名称', 80, false) || `银行卡 ····${number.slice(-4)}`,
    currencyCode: bankRechargeCurrency(currency ?? input.currencyCode),
    remark1,
    remark2
  };
}
