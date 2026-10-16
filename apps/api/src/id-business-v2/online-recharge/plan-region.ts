import { BadRequestException, ConflictException } from '@nestjs/common';
import type { OnlineRechargePlan } from './contracts';
import { onlineProxyCountry } from './proxy-input';
import { object } from './validation';

export const PAYMENT_REGION_CURRENCIES = {
  PH: 'PHP',
  US: 'USD',
  SG: 'SGD',
  MY: 'MYR',
  CL: 'CLP'
} as const;
export type PaymentRegion = keyof typeof PAYMENT_REGION_CURRENCIES;
export const PLAN_REGION_KEYS = {
  plus: ['planProxyCountryPlus', 'planPaymentRegionPlus'],
  pro_5x: ['planProxyCountryPro5x', 'planPaymentRegionPro5x'],
  pro_20x: ['planProxyCountryPro20x', 'planPaymentRegionPro20x'],
  pro_500: ['planProxyCountryPro500', 'planPaymentRegionPro500']
} as const satisfies Record<OnlineRechargePlan, readonly [string, string]>;

export interface PlanRegionSnapshot {
  policy: 'plan' | 'global';
  configVersion: number;
  targetPlan: OnlineRechargePlan;
  proxyCountryCode: string;
  paymentRegion: PaymentRegion;
  expectedCurrency: string;
}

export function paymentRegion(value: unknown): PaymentRegion {
  if (typeof value !== 'string' || !Object.hasOwn(PAYMENT_REGION_CURRENCIES, value))
    throw new BadRequestException('支付地区无效');
  return value as PaymentRegion;
}

export function validatePlanRegions(settings: Record<string, unknown>) {
  paymentRegion(settings.paymentRegion);
  for (const [country, region] of Object.values(PLAN_REGION_KEYS)) {
    settings[country] = onlineProxyCountry(settings[country]);
    paymentRegion(settings[region]);
  }
}

export function resolvePlanRegion(
  settings: Record<string, unknown>,
  targetPlan: OnlineRechargePlan,
  configVersion: number,
  debugRegion?: unknown
): PlanRegionSnapshot {
  const enabled = settings.planRegionRoutingEnabled === true;
  const keys = PLAN_REGION_KEYS[targetPlan];
  const region = paymentRegion(enabled ? settings[keys[1]] : debugRegion || settings.paymentRegion);
  return {
    policy: enabled ? 'plan' : 'global',
    configVersion,
    targetPlan,
    proxyCountryCode: onlineProxyCountry(enabled ? settings[keys[0]] : settings.proxyCountryCode),
    paymentRegion: region,
    expectedCurrency: PAYMENT_REGION_CURRENCIES[region]
  };
}

export function taskPlanRegion(
  payload: Record<string, unknown>,
  targetPlan: OnlineRechargePlan
): PlanRegionSnapshot | null {
  if (payload.planRegion === undefined) return null;
  const value = object(payload.planRegion);
  const region = paymentRegion(value.paymentRegion);
  if (
    !['plan', 'global'].includes(String(value.policy)) ||
    value.targetPlan !== targetPlan ||
    !Number.isSafeInteger(value.configVersion) ||
    Number(value.configVersion) < 0 ||
    value.expectedCurrency !== PAYMENT_REGION_CURRENCIES[region] ||
    value.proxyCountryCode !== onlineProxyCountry(value.proxyCountryCode) ||
    payload.proxyCountryCode !== value.proxyCountryCode ||
    payload.region !== region
  )
    throw new ConflictException('任务套餐地区快照不一致，停止执行，请核对原任务');
  return value as unknown as PlanRegionSnapshot;
}

export function runtimePlanRegion(
  payload: Record<string, unknown>,
  targetPlan: OnlineRechargePlan,
  operation: string,
  config: Record<string, unknown>
): PlanRegionSnapshot | null {
  const snapshot = taskPlanRegion(payload, targetPlan);
  if (
    !snapshot &&
    ['recharge', 'debug'].includes(operation) &&
    config.planRegionRoutingEnabled === true
  )
    throw new ConflictException('旧任务缺少固定地区资料，请先核对原任务，不自动套用新规则');
  return snapshot;
}
