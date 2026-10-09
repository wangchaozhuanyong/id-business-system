import { BadRequestException } from '@nestjs/common';
import {
  V2_RECHARGE_PLANS,
  type V2RechargeBitBrowserOpenStart,
  type V2RechargeBitBrowserRecheckStart,
  type V2RechargeBitBrowserStart,
  type V2RechargeResolveNoBankRequest
} from '@apple-business/shared';
import { object, uuidPattern } from './recharge-validation';

export const supportedCurrencies = new Set(
  'USD MYR PHP CLP EUR GBP AUD CAD JPY KRW SGD INR IDR THB VND TWD HKD BRL MXN AED SAR ZAR NZD CHF SEK NOK DKK PLN TRY'.split(
    ' '
  )
);
export const zeroDecimalCurrencies = new Set(['JPY', 'KRW', 'VND', 'CLP']);
const hasControlCharacter = (value: string) =>
  [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });

export function validateRechargeBitBrowserStart(value: unknown) {
  const input = { ...object(value) };
  // 兼容旧客户端；历史上限不参与本次授权，也不进入新任务。
  delete input.maxAmount;
  const allowedKeys = new Set([
    'id',
    'plan',
    'addressId',
    'windowName',
    'lockedCurrency',
    'authorizeSinglePayment',
    'cardId',
    'billingName',
    'chatgptAccountId',
    'useSavedCredentials',
    'expectedEmail',
    'proxyId',
    'proxyCountryCode',
    'manualPaymentConfirmation'
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
    throw new BadRequestException('请选择套餐、可用账单地址并明确授权单次付款');
  }
  if (input.manualPaymentConfirmation !== undefined && input.manualPaymentConfirmation !== true)
    throw new BadRequestException('比特充值必须在官网核价后人工确认');
  if (
    (input.cardId !== undefined || input.billingName !== undefined) &&
    (typeof input.cardId !== 'string' ||
      !uuidPattern.test(input.cardId) ||
      typeof input.billingName !== 'string' ||
      !input.billingName.trim() ||
      input.billingName.length > 120)
  )
    throw new BadRequestException('银行卡或持卡人姓名格式无效');
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
  if (
    input.chatgptAccountId !== undefined &&
    (typeof input.chatgptAccountId !== 'string' || !uuidPattern.test(input.chatgptAccountId))
  ) {
    throw new BadRequestException('所选 ChatGPT 账号无效');
  }
  if (input.useSavedCredentials !== undefined && typeof input.useSavedCredentials !== 'boolean') {
    throw new BadRequestException('账号凭据选择无效');
  }
  if (input.useSavedCredentials && !input.chatgptAccountId) {
    throw new BadRequestException('请先选择已保存的 ChatGPT 账号');
  }
  if (
    input.expectedEmail !== undefined &&
    (typeof input.expectedEmail !== 'string' ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.expectedEmail.trim()) ||
      input.expectedEmail.length > 250)
  ) {
    throw new BadRequestException('ChatGPT 注册邮箱无效');
  }
  if (
    (input.proxyId !== undefined || input.proxyCountryCode !== undefined) &&
    (typeof input.proxyId !== 'string' ||
      !uuidPattern.test(input.proxyId) ||
      typeof input.proxyCountryCode !== 'string' ||
      !/^[A-Z]{2}$/.test(input.proxyCountryCode))
  ) {
    throw new BadRequestException('请选择有效的代理国家和代理 IP');
  }
  return {
    cardId: input.cardId as string | undefined,
    billingName: input.billingName as string | undefined,
    id: input.id,
    plan: input.plan,
    addressId: input.addressId,
    windowName,
    lockedCurrency,
    chatgptAccountId: input.chatgptAccountId as string | undefined,
    useSavedCredentials: input.useSavedCredentials === true,
    expectedEmail: input.expectedEmail as string | undefined,
    proxyId: input.proxyId as string | undefined,
    proxyCountryCode: input.proxyCountryCode as string | undefined,
    authorizeSinglePayment: true,
    manualPaymentConfirmation: true
  } as V2RechargeBitBrowserStart & {
    chatgptAccountId?: string;
    useSavedCredentials: boolean;
    expectedEmail?: string;
  };
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

export function validateRechargeBitBrowserOpenStart(value: unknown): V2RechargeBitBrowserOpenStart {
  const input = object(value);
  const allowedKeys = new Set(['id', 'windowName', 'directMode']);
  if (
    Object.keys(input).some((key) => !allowedKeys.has(key)) ||
    typeof input.id !== 'string' ||
    !uuidPattern.test(input.id) ||
    (input.directMode !== undefined && typeof input.directMode !== 'boolean')
  ) {
    throw new BadRequestException('开启浏览器请求参数无效');
  }
  const windowName = String(input.windowName ?? '').trim();
  if (!windowName || windowName.length > 80 || hasControlCharacter(windowName)) {
    throw new BadRequestException('比特浏览器窗口名称格式无效');
  }
  return {
    id: input.id,
    windowName,
    ...(input.directMode !== undefined ? { directMode: input.directMode as boolean } : {})
  };
}

export function validateRechargeNoBankRequest(value: unknown) {
  const input = object(value);
  const allowedKeys = new Set(['confirmNoBankRequest', 'verificationJobId']);
  if (
    Object.keys(input).some((key) => !allowedKeys.has(key)) ||
    input.confirmNoBankRequest !== true ||
    typeof input.verificationJobId !== 'string' ||
    !uuidPattern.test(input.verificationJobId)
  ) {
    throw new BadRequestException('请明确确认银行卡未收到付款请求');
  }
  return {
    confirmNoBankRequest: true,
    verificationJobId: input.verificationJobId
  } as V2RechargeResolveNoBankRequest;
}
