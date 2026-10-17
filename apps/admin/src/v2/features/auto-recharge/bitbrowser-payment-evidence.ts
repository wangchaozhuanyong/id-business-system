import type { V2RechargePlan, V2RechargeQuote, V2RechargeMoney } from '@apple-business/shared';
import type { V2RechargeDetails } from './contracts';

export const directOfficialPlans: Record<V2RechargePlan, string> = {
  go: 'chatgptgoplan',
  plus: 'chatgptplusplan',
  'pro-5x': 'chatgptprolite',
  'pro-20x': 'chatgptpro',
  'pro-500': 'chatgptpromax'
};
export type PaymentDocument = Record<string, unknown>;
export const paymentObject = (value: unknown): PaymentDocument =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as PaymentDocument) : {};
export function directPaymentMoney(currency: string, minor: unknown): V2RechargeMoney {
  if (
    !/^[A-Z]{3}$/.test(currency) ||
    !Number.isSafeInteger(minor) ||
    Number(minor) < 0 ||
    Number(minor) > 1e12
  )
    throw new Error('官网金额未核实，已停止付款。');
  const zero = [
    'JPY',
    'KRW',
    'VND',
    'CLP',
    'ISK',
    'UGX',
    'PYG',
    'RWF',
    'XAF',
    'XOF',
    'XPF',
    'BIF',
    'DJF',
    'GNF',
    'KMF',
    'MGA',
    'VUV'
  ].includes(currency);
  const n = BigInt(Number(minor));
  return {
    currency,
    amount_minor: Number(minor),
    amount: zero ? n.toString() : `${n / 100n}.${(n % 100n).toString().padStart(2, '0')}`
  };
}
function visibleMoney(value: string, currency: string) {
  if (/[-−%]|\d,\d{1,2}(?!\d)/.test(value)) return undefined;
  const codes = [...new Set(value.match(/\b[A-Z]{3}\b/g) ?? [])];
  if (
    codes.some((code) => code !== currency) ||
    (value.includes('₱') && currency !== 'PHP') ||
    (value.includes('€') && currency !== 'EUR') ||
    (value.includes('£') && currency !== 'GBP') ||
    (/[¥￥]/.test(value) && !['JPY', 'CNY'].includes(currency)) ||
    (/\bRM\s*\d/.test(value) && currency !== 'MYR')
  )
    return undefined;
  const amounts = value.match(/(?<![\w.])(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?![\w.])/g);
  if (amounts?.length !== 1) return undefined;
  const number = amounts[0]!.replaceAll(',', '');
  const [whole, fraction = ''] = number.split('.');
  const zero = directPaymentMoney(currency, 0).amount.indexOf('.') < 0;
  if (fraction.length > (zero ? 0 : 2)) return undefined;
  return directPaymentMoney(
    currency,
    Number(BigInt(whole!) * (zero ? 1n : 100n) + BigInt(zero ? '0' : fraction.padEnd(2, '0')))
  );
}
export function parseDirectVisibleQuote(
  text: string,
  currency: string,
  plan: V2RechargePlan
): V2RechargeQuote {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const patterns = {
    today:
      /^(?:Total due today|Due today|Total today|Amount due today|今日应付(?:金额)?|今天应付|今日总计|今天支付)(?:\s|$|:|：)/i,
    tax: /^(?:Tax|Taxes|Estimated tax|预估税费|税费|税金|增值税(?:\s*\(VAT\))?|VAT)(?:\s*\(\s*\d+(?:\.\d+)?%\s*\))?(?:\s|$|:|：)/i,
    renewal: /^(?:Then|Renews|Renewal|续费)(?:\s|$|:|：)/i
  };
  const monthly = /\/\s*(?:month|月)(?!\w)|per\s+month\b|\bmonthly\b|每月|每个月|按月|月付/i;
  const yearly = /\/\s*(?:year|年)(?!\w)|per\s+year\b|annual|yearly|每年|按年|年付|年度/i;
  const result: Partial<Record<'today' | 'tax' | 'renewal', V2RechargeMoney>> = {};
  const renewalPeriods: boolean[] = [];
  for (const key of ['today', 'tax', 'renewal'] as const) {
    const found: V2RechargeMoney[] = [];
    let count = 0;
    for (let i = 0; i < lines.length; i++) {
      const match = patterns[key].exec(lines[i]!);
      if (!match) continue;
      count++;
      let clause = key === 'tax' ? lines[i]!.slice(match[0].length).trim() : lines[i]!;
      let money = visibleMoney(clause, currency);
      if (!money && !/[0-9]/.test(clause)) {
        clause = lines[i + 1] ?? '';
        money = visibleMoney(clause, currency);
        if (
          key === 'renewal' &&
          !monthly.test(clause) &&
          /^(?:\/\s*(?:month|月)|monthly|每月)$/i.test(lines[i + 2] ?? '')
        )
          clause += ' monthly';
      }
      if (money) found.push(money);
      if (key === 'renewal') renewalPeriods.push(monthly.test(clause) && !yearly.test(clause));
    }
    if (key === 'renewal')
      for (const match of text.matchAll(/将按\s*([^。\n]+?)\/\s*(月|年)\s*收费/g)) {
        const money = visibleMoney(match[1]!, currency);
        if (money) found.push(money);
        renewalPeriods.push(match[2] === '月' && !yearly.test(match[0]));
      }
    const unique = new Map(found.map((m) => [m.amount_minor, m]));
    if (unique.size === 1 && (key !== 'tax' || count === 1)) result[key] = [...unique.values()][0]!;
  }
  if (
    !result.today ||
    !result.tax ||
    !result.renewal ||
    !renewalPeriods.length ||
    !renewalPeriods.every(Boolean) ||
    result.today.amount_minor <= 0
  )
    throw new Error('官网今日应付、税费或月度续费金额尚未完整核实。');
  return {
    plan,
    today: result.today,
    tax: result.tax,
    renewal: result.renewal,
    renewal_interval: 'monthly'
  };
}
export async function paymentFingerprint(value: object) {
  const sorted = Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(sorted))
  );
  return Array.from(new Uint8Array(digest), (part) => part.toString(16).padStart(2, '0')).join('');
}
export function billingValues(value: unknown, name: unknown) {
  const address = paymentObject(value);
  const normalized: Record<string, string> = {};
  for (const key of ['country', 'line1', 'line2', 'city', 'state', 'postal_code']) {
    const raw = address[key] ?? '';
    if (typeof raw !== 'string') throw new Error('官网账单资料尚未核实。');
    normalized[key] = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  }
  normalized.name = typeof name === 'string' ? name.trim().toLowerCase().replace(/\s+/g, ' ') : '';
  if (
    ['name', 'country', 'line1', 'city', 'postal_code'].some((k) => !normalized[k]) ||
    (['us', 'ca', 'au'].includes(normalized.country!) && !normalized.state)
  )
    throw new Error('官网账单资料尚未核实。');
  return normalized;
}
export async function verifyNativeDirectQuote(
  data: unknown,
  checkoutId: string,
  entity: string,
  plan: V2RechargePlan,
  details: V2RechargeDetails,
  text: string,
  lockedCurrency: string
) {
  const envelope = paymentObject(data);
  const session = paymentObject(envelope.checkout_session ?? envelope);
  const state = paymentObject(session.checkout_state);
  if (
    session.checkout_session_id !== checkoutId ||
    session.processor_entity !== entity ||
    session.plan_name !== directOfficialPlans[plan] ||
    state.id !== checkoutId ||
    session.status !== 'open' ||
    session.payment_status !== 'unpaid'
  )
    throw new Error('官网原单状态或套餐未核实。');
  const currency = String(state.currency ?? '').toUpperCase();
  if (currency !== lockedCurrency) throw new Error('官网付款币种与锁定币种不一致。');
  const items = state.lineItems;
  const taxes = state.taxAmounts;
  if (!Array.isArray(items) || items.length !== 1 || !Array.isArray(taxes))
    throw new Error('官网账单金额未核实。');
  const item = paymentObject(items[0]);
  const recurring = paymentObject(item.recurring);
  if (item.quantity !== 1 || recurring.interval !== 'month' || (recurring.intervalCount ?? 1) !== 1)
    throw new Error('官网订阅周期未核实。');
  const quote = parseDirectVisibleQuote(text, currency, plan);
  const due = paymentObject(paymentObject(state.total).total).minorUnitsAmount;
  const tax = taxes.reduce((sum: bigint, value: unknown) => {
    const amount = paymentObject(value).minorUnitsAmount;
    if (!Number.isSafeInteger(amount) || Number(amount) < 0) throw new Error('官网税费未核实。');
    return sum + BigInt(Number(amount));
  }, 0n);
  if (due !== quote.today!.amount_minor || tax !== BigInt(quote.tax!.amount_minor))
    throw new Error('官网页面与结算接口金额不一致。');
  const billing = paymentObject(state.billingAddress);
  const actual = billingValues(billing.address, billing.name);
  const expected = billingValues(details, details.name);
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error('官网重新计税的账单资料与本次填写不一致。');
  const fingerprint = await paymentFingerprint({
    ...expected,
    card_last4: details.number.slice(-4),
    card_expiry: details.expiry
  });
  return { quote, billing_fingerprint: fingerprint };
}

/** This expression reads official data in the owned window; credentials never leave it. */
export function officialPaymentRead(
  identity: { accountId: string; userId: string; email: string },
  path: string
) {
  if (
    !/^\/backend-api\/(?:payments\/checkout\/[a-z][a-z0-9_]{0,40}\/(?:oaics|cs)_[A-Za-z0-9_]{1,200}|accounts\/check\/v4-2023-04-27|invoices\?account_id=[A-Za-z0-9_%.-]+&limit=100|payments\/payment_methods\?account_id=[A-Za-z0-9_%.-]+|subscriptions(?:\?account_id=[A-Za-z0-9_%.-]+|\/update\/preview\?[^#]*)?)$/.test(
      path
    )
  )
    throw new Error('官网读取路径不允许。');
  return `(${async function (
    expected: { accountId: string; userId: string; email: string },
    relative: string
  ) {
    if (location.origin !== 'https://chatgpt.com') return { ok: false, status: 0 };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const sessionResponse = await fetch('/api/auth/session', {
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal
      });
      const session = await sessionResponse.json();
      if (
        !sessionResponse.ok ||
        session.error ||
        session.user?.id !== expected.userId ||
        String(session.user?.email ?? '').toLowerCase() !== expected.email.toLowerCase()
      )
        return { ok: false, status: 401 };
      const token = session.accessToken ?? session.access_token;
      if (typeof token !== 'string') return { ok: false, status: 401 };
      const encoded = token.split('.')[1]?.replace(/-/g, '+').replace(/_/g, '/');
      const claims = JSON.parse(atob(encoded));
      if (
        claims['https://api.openai.com/auth']?.chatgpt_account_id !== expected.accountId ||
        typeof claims.exp !== 'number' ||
        !Number.isFinite(claims.exp) ||
        claims.exp * 1000 <= Date.now()
      )
        return { ok: false, status: 401 };
      const response = await fetch(relative, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
        headers: { authorization: 'Bearer ' + token, 'chatgpt-account-id': expected.accountId }
      });
      if (!response.ok) return { ok: false, status: response.status };
      const raw = await response.text();
      return raw.length <= 65000
        ? { ok: true, status: response.status, data: JSON.parse(raw) }
        : { ok: false, status: 0 };
    } finally {
      clearTimeout(timer);
    }
  }.toString()})(${JSON.stringify(identity)},${JSON.stringify(path)})`;
}
