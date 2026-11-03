import { BadRequestException } from '@nestjs/common';
import { Amount4 } from '../runtime/public-api';
import { createHash } from 'node:crypto';
import type { OnlineRechargePlan } from './contracts';
import { object, text } from './validation';

export const BITBROWSER_PROTOCOL = 1;
export const BITBROWSER_CURRENCIES = ['USD', 'PHP', 'MYR', 'SGD', 'CLP'] as const;
export type OnlineExecutionChannel = 'local' | 'third_party' | 'bitbrowser';
export interface BitbrowserPolicy {
  mode: 'manual' | 'automatic';
  currency: string;
  maxAmount: string | null;
  proxyCountryCode: string;
  deviceId: string;
}
export const BITBROWSER_PLAN = {
  plus: 'plus',
  pro_5x: 'pro-5x',
  pro_20x: 'pro-20x',
  pro_500: 'pro-500'
} as const;
const prefixes = { plus: 'Plus', pro_5x: 'Pro5x', pro_20x: 'Pro20x' } as const;

export function executionChannel(settings: Record<string, unknown>): OnlineExecutionChannel {
  const value = settings.executionChannel;
  if (!value) return settings.gptApiEnabled === true ? 'third_party' : 'local';
  if (!['local', 'third_party', 'bitbrowser'].includes(String(value)))
    throw new BadRequestException('充值通道无效');
  return value as OnlineExecutionChannel;
}
export function validateBitbrowserSettings(settings: Record<string, unknown>) {
  executionChannel(settings);
  if (
    settings.bitBrowserDeviceId &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      String(settings.bitBrowserDeviceId)
    )
  )
    throw new BadRequestException('执行电脑编号无效');
  if (!['manual', 'automatic'].includes(String(settings.bitBrowserPaymentMode)))
    throw new BadRequestException('付款模式无效');
  let url: URL;
  try {
    url = new URL(String(settings.bitBrowserApiUrl));
  } catch {
    throw new BadRequestException('比特接口地址无效');
  }
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new BadRequestException('比特接口必须是本机 HTTP 地址并指定端口');
  for (const prefix of Object.values(prefixes)) {
    const currency = settings[`bitBrowser${prefix}Currency`];
    const amount = settings[`bitBrowser${prefix}MaxAmount`];
    if (!BITBROWSER_CURRENCIES.includes(currency as (typeof BITBROWSER_CURRENCIES)[number]))
      throw new BadRequestException('比特付款币种无效');
    if (prefix === 'Pro5x' && currency !== 'CLP')
      throw new BadRequestException('Pro 5 倍比特充值必须使用智利比索');
    if (
      amount !== '' &&
      (typeof amount !== 'string' ||
        !/^\d{1,12}(\.\d{1,4})?$/.test(amount) ||
        Amount4.from(amount).lte(0))
    )
      throw new BadRequestException('自动付款上限须为正数金额');
    if (settings.bitBrowserPaymentMode === 'automatic' && !amount)
      throw new BadRequestException('请先为每个套餐配置自动付款金额上限');
  }
}
export function bitbrowserPolicy(
  settings: Record<string, unknown>,
  plan: OnlineRechargePlan,
  deviceId: string
): BitbrowserPolicy {
  if (plan === 'pro_500')
    throw new BadRequestException('比特通道首版尚未验收 Pro 500，请使用原执行通道');
  const prefix = prefixes[plan];
  const country = plan === 'pro_5x' ? 'CL' : String(settings.proxyCountryCode ?? '');
  if (!/^[A-Z]{2}$/.test(country)) throw new BadRequestException('请先配置比特充值代理国家');
  return {
    mode: settings.bitBrowserPaymentMode as BitbrowserPolicy['mode'],
    currency: String(settings[`bitBrowser${prefix}Currency`]),
    maxAmount: settings[`bitBrowser${prefix}MaxAmount`]
      ? String(settings[`bitBrowser${prefix}MaxAmount`])
      : null,
    proxyCountryCode: country,
    deviceId
  };
}
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, sorted(item)])
    );
  return value;
}
export function documentDigest(value: unknown) {
  const json = JSON.stringify(sorted(value)).replace(
    /[\u007f-\uffff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
  return createHash('sha256').update(json).digest('hex');
}
export function validateBitbrowserQuote(
  raw: unknown,
  plan: OnlineRechargePlan,
  policy: BitbrowserPolicy
) {
  const quote = object(raw);
  if (quote.plan !== BITBROWSER_PLAN[plan] || quote.renewal_interval !== 'monthly')
    throw new BadRequestException('核价套餐或订阅周期不一致');
  const money = (value: unknown, zero: boolean) => {
    const item = object(value);
    const amount = text(item.amount, '核价金额', 32);
    if (
      !/^\d{1,12}(\.\d{1,4})?$/.test(amount) ||
      item.currency !== policy.currency ||
      !Number.isSafeInteger(item.amount_minor)
    )
      throw new BadRequestException('核价金额或币种无效');
    const decimal = Amount4.from(amount);
    const minor = decimal.mul(policy.currency === 'CLP' ? 1 : 100);
    if (
      (!zero && decimal.lte(0)) ||
      decimal.lt(0) ||
      minor.toString().includes('.') ||
      !minor.equals(String(item.amount_minor))
    )
      throw new BadRequestException('核价金额精度或金额单位不一致');
    return { amount, amount_minor: item.amount_minor as number, currency: policy.currency };
  };
  const canonical = {
    plan: BITBROWSER_PLAN[plan],
    today: money(quote.today, false),
    tax: money(quote.tax, true),
    renewal: money(quote.renewal, false),
    renewal_interval: 'monthly'
  };
  const automatic =
    policy.mode === 'automatic' &&
    Boolean(policy.maxAmount) &&
    Amount4.from(canonical.today.amount).lte(policy.maxAmount!);
  return { quote: canonical, digest: documentDigest(canonical), automatic };
}
