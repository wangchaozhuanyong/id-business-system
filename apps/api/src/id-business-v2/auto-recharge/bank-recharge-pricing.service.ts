import { V2_BANK_RECHARGE_PLANS, V2_FINANCE_CURRENCIES } from '@apple-business/shared';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { IdBusinessV2FinanceFxService } from '../finance/public-api';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  normalizeOptionalV2ExpectedUpdatedAt,
  toV2JsonDocument
} from '../runtime/public-api';
import {
  BIT_ORDER_PRICING_SETTINGS_OWNER_ID,
  RechargeSettingsRepository
} from './persistence/recharge-settings.repository';
import {
  bankRechargeFeeRate,
  bankRechargeMoney,
  bankRechargeObject
} from './bank-recharge-validation';

export { BIT_ORDER_PRICING_SETTINGS_OWNER_ID } from './persistence/recharge-settings.repository';
type PricingPlan = (typeof V2_BANK_RECHARGE_PLANS)[number];
type ReceiptCurrency = (typeof V2_FINANCE_CURRENCIES)[number];
export interface BankRechargePricingSettings {
  receivedCurrencyCode: ReceiptCurrency;
  shoppingFeePercent: string | null;
  usdtFeePercent: string | null;
  planPrices: Record<PricingPlan, string | null>;
  updatedAt: string | null;
}
const settingsKeys = new Set([
  'receivedCurrencyCode',
  'shoppingFeePercent',
  'usdtFeePercent',
  'planPrices',
  'updatedAt'
]);
const currencies = new Set<string>(V2_FINANCE_CURRENCIES);
const plans = new Set<string>(V2_BANK_RECHARGE_PLANS);

function emptyPlanPrices(): BankRechargePricingSettings['planPrices'] {
  return Object.fromEntries(
    V2_BANK_RECHARGE_PLANS.map((plan) => [plan, null])
  ) as BankRechargePricingSettings['planPrices'];
}

function percent(value: unknown, label: string) {
  if (value === null || value === '') return null;
  try {
    return bankRechargeFeeRate(value).toString();
  } catch {
    throw new BadRequestException(`${label}必须为 0–100 的百分比，最多四位小数；未设置请留空`);
  }
}

function normalizeSettings(value: unknown): Omit<BankRechargePricingSettings, 'updatedAt'> {
  const input = bankRechargeObject(value);
  if (Object.keys(input).some((key) => !settingsKeys.has(key))) {
    throw new BadRequestException('收费设置包含不支持的字段');
  }
  if (
    typeof input.receivedCurrencyCode !== 'string' ||
    !currencies.has(input.receivedCurrencyCode)
  ) {
    throw new BadRequestException('客户收费币种必须选择系统支持的币种');
  }
  const values = bankRechargeObject(input.planPrices);
  if (Object.keys(values).some((key) => !plans.has(key))) {
    throw new BadRequestException('套餐收费包含不支持的套餐');
  }
  const planPrices = emptyPlanPrices();
  for (const plan of V2_BANK_RECHARGE_PLANS) {
    const value = values[plan];
    planPrices[plan] =
      value === null || value === undefined || value === ''
        ? null
        : bankRechargeMoney(value, '套餐收费', 4).toString();
  }
  return {
    receivedCurrencyCode: input.receivedCurrencyCode as ReceiptCurrency,
    shoppingFeePercent: percent(input.shoppingFeePercent, '购物网手续费'),
    usdtFeePercent: percent(input.usdtFeePercent, 'USDT 手续费'),
    planPrices
  };
}

@Injectable()
export class BankRechargePricingService {
  constructor(
    private readonly settings: RechargeSettingsRepository,
    private readonly transactions: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService,
    private readonly fx: IdBusinessV2FinanceFxService
  ) {}

  private requireAdmin(operator: AuthenticatedUser) {
    if (!operator.id || !operator.roles.includes('admin')) {
      throw new ForbiddenException('仅管理员可查看或设置比特订单收费');
    }
  }

  async read(operator: AuthenticatedUser): Promise<BankRechargePricingSettings> {
    this.requireAdmin(operator);
    const row = await this.settings.findOrderPricing();
    return row
      ? { ...normalizeSettings(row.browserOptions), updatedAt: row.updatedAt.toISOString() }
      : {
          receivedCurrencyCode: 'CNY',
          shoppingFeePercent: null,
          usdtFeePercent: null,
          planPrices: emptyPlanPrices(),
          updatedAt: null
        };
  }

  async update(value: unknown, operator: AuthenticatedUser): Promise<BankRechargePricingSettings> {
    this.requireAdmin(operator);
    const input = bankRechargeObject(value);
    const expectedUpdatedAt = normalizeOptionalV2ExpectedUpdatedAt(input.updatedAt, '收费设置');
    const next = normalizeSettings(input);
    return this.transactions.execute(
      async (tx) => {
        const previous = await this.settings.findOrderPricing(tx);
        if (
          (expectedUpdatedAt === null && previous) ||
          (expectedUpdatedAt !== null &&
            previous?.updatedAt.getTime() !== expectedUpdatedAt.getTime())
        ) {
          throw new ConflictException('收费设置已被其他管理员修改，请刷新后重试。');
        }
        const saved = await this.settings.compareAndSetOrderPricing(
          tx,
          expectedUpdatedAt,
          toV2JsonDocument(next)
        );
        if (!saved) throw new ConflictException('收费设置已被其他管理员修改，请刷新后重试。');
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.auto_recharge.order_pricing.settings',
          objectType: 'recharge_browser_settings',
          objectId: BIT_ORDER_PRICING_SETTINGS_OWNER_ID,
          ...(previous
            ? { beforeData: toV2JsonDocument(normalizeSettings(previous.browserOptions)) }
            : {}),
          afterData: toV2JsonDocument(next),
          remark: '设置比特订单套餐收费与手续费比例，历史订单保持原记录'
        });
        return { ...next, updatedAt: saved.updatedAt.toISOString() };
      },
      {
        changedScopes: ['auto-recharge'],
        requestId: randomUUID(),
        operator,
        retryMode: 'none'
      }
    );
  }

  async rates(operator: AuthenticatedUser) {
    this.requireAdmin(operator);
    const latest = await this.fx.listLatest();
    return {
      items: latest.items.map((item) => ({
        currency: item.currency,
        rateToCny: item.rateToCny,
        id: item.id,
        capturedAt: item.capturedAt?.toISOString() ?? null,
        expiresAt: item.expiresAt?.toISOString() ?? null
      })),
      generatedAt: latest.generatedAt
    };
  }
}
