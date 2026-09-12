import { BadRequestException } from '@nestjs/common';
import {
  V2_RECHARGE_PLANS,
  type V2RechargeBitBrowserRecheckStart,
  type V2RechargeBitBrowserStart
} from '@apple-business/shared';
import { object, uuidPattern } from './recharge-validation';

const supportedCurrencies = new Set(
  'USD MYR PHP EUR GBP AUD CAD JPY KRW SGD INR IDR THB VND TWD HKD BRL MXN AED SAR ZAR NZD CHF SEK NOK DKK PLN TRY'.split(
    ' '
  )
);
const zeroDecimalCurrencies = new Set(['JPY', 'KRW', 'VND']);
const hasControlCharacter = (value: string) =>
  [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });

export function amountMinor(value: unknown, currency: string) {
  if (typeof value !== 'string' || !/^\d{1,9}(?:\.\d{1,2})?$/.test(value)) {
    throw new BadRequestException('最高付款金额格式无效');
  }
  const places = zeroDecimalCurrencies.has(currency) ? 0 : 2;
  const [whole, fraction = ''] = value.split('.');
  if ((places === 0 && fraction) || fraction.length > places) {
    throw new BadRequestException('最高付款金额与币种精度不一致');
  }
  const padded = fraction.padEnd(places, '0');
  const minor = BigInt(whole!) * 10n ** BigInt(places) + BigInt(padded || '0');
  if (minor <= 0n || minor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new BadRequestException('最高付款金额必须大于 0');
  }
  return {
    amount: places ? `${whole}.${padded}` : whole!,
    amountMinor: Number(minor)
  };
}

export function validateRechargeBitBrowserStart(value: unknown) {
  const input = object(value);
  const allowedKeys = new Set([
    'id',
    'plan',
    'addressId',
    'windowName',
    'lockedCurrency',
    'maxAmount',
    'authorizeSinglePayment'
  ]);
  if (
    Object.keys(input).some((key) => !allowedKeys.has(key)) ||
    typeof input.id !== 'string' ||
    !uuidPattern.test(input.id) ||
    !V2_RECHARGE_PLANS.includes(input.plan as never) ||
    typeof input.addressId !== 'string' ||
    !uuidPattern.test(input.addressId) ||
    input.authorizeSinglePayment !== true
  ) {
    throw new BadRequestException('请选择套餐、未使用地址并明确授权单次付款');
  }
  const windowName = String(input.windowName ?? '').trim();
  if (!windowName || windowName.length > 80 || hasControlCharacter(windowName)) {
    throw new BadRequestException('比特浏览器窗口名称格式无效');
  }
  const lockedCurrency = String(input.lockedCurrency ?? '')
    .trim()
    .toUpperCase();
  if (!supportedCurrencies.has(lockedCurrency)) {
    throw new BadRequestException('锁定币种不受支持');
  }
  const maximum = amountMinor(input.maxAmount, lockedCurrency);
  return {
    id: input.id,
    plan: input.plan,
    addressId: input.addressId,
    windowName,
    lockedCurrency,
    maxAmount: maximum.amount,
    maxAmountMinor: maximum.amountMinor,
    authorizeSinglePayment: true
  } as V2RechargeBitBrowserStart & { maxAmountMinor: number };
}

export function validateRechargeBitBrowserRecheckStart(value: unknown) {
  const input = object(value);
  const allowedKeys = new Set(['id', 'sourceJobId', 'plan', 'windowName']);
  if (
    Object.keys(input).some((key) => !allowedKeys.has(key)) ||
    typeof input.id !== 'string' ||
    !uuidPattern.test(input.id) ||
    typeof input.sourceJobId !== 'string' ||
    !uuidPattern.test(input.sourceJobId) ||
    input.id === input.sourceJobId ||
    !V2_RECHARGE_PLANS.includes(input.plan as never)
  ) {
    throw new BadRequestException('请选择需要只读复查的原任务');
  }
  const windowName = String(input.windowName ?? '').trim();
  if (!windowName || windowName.length > 80 || hasControlCharacter(windowName)) {
    throw new BadRequestException('比特浏览器窗口名称格式无效');
  }
  return {
    id: input.id,
    sourceJobId: input.sourceJobId,
    plan: input.plan,
    windowName
  } as V2RechargeBitBrowserRecheckStart;
}
