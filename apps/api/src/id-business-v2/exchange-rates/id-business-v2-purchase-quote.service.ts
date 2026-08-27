import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  V2_PURCHASE_RATE_ROUNDING_MODES,
  V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES,
  calculateV2PurchaseRate,
  divideDecimalStrings,
  formatV2PurchaseRate,
  multiplyDecimalStrings,
  v2UnsignedDecimalPattern,
  type V2PurchaseRateRoundingMode
} from '@apple-business/shared';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type { BulkUpdateIdBusinessV2PurchaseQuotesDto } from './dto/bulk-update-id-business-v2-purchase-quotes.dto';
import type { UpdateIdBusinessV2PurchaseQuoteDto } from './dto/update-id-business-v2-purchase-quote.dto';
import {
  Rate8,
  V2CommandTransactionManager,
  V2TransactionalAuditService
} from '../runtime/public-api';
import {
  IdBusinessV2PurchaseQuoteRepository,
  type IdBusinessV2PurchaseCurrencyRecord,
  type IdBusinessV2PurchaseRateSnapshotRecord
} from './persistence/id-business-v2-purchase-quote.repository';
import { IdBusinessV2PurchaseRateSettingsService } from './id-business-v2-purchase-rate-settings.service';
import {
  ID_BUSINESS_V2_PURCHASE_QUOTE_TEXT_FORMATS,
  renderIdBusinessV2PurchaseQuoteText,
  type IdBusinessV2PurchaseQuoteTextFormat
} from './id-business-v2-purchase-quote-text';

const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;
const RATE_PATTERN = v2UnsignedDecimalPattern(V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES);
const MAX_RATE = Rate8.from('9999999999.99999999');
const MAX_QUOTE_UNIT = Rate8.from('1000000');
const MAX_SORT_ORDER = 1_000_000;

@Injectable()
export class IdBusinessV2PurchaseQuoteService {
  constructor(
    private readonly repository: IdBusinessV2PurchaseQuoteRepository,
    private readonly transactionManager: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService,
    private readonly settingsService: IdBusinessV2PurchaseRateSettingsService
  ) {}

  async list() {
    const [currencies, settings] = await Promise.all([
      this.repository.listCurrencies(),
      this.settingsService.getRecord()
    ]);
    return {
      items: currencies.map((currency) => this.toResponse(currency, settings.staleMinutes)),
      calculationRule: '收购价 = 该币种兑人民币市场汇率 × 该币种独立收购比例 × 显示单位',
      marketRateMode: 'automatic_with_manual_fallback' as const,
      marketRateNotice:
        '默认由 ExchangeRate-API 免费开放接口以人民币为基准每日自动采集；自动采集失败或异常时保留上一批有效报价，也可由管理员手工修正。',
      staleMinutes: settings.staleMinutes
    };
  }

  async get(codeValue: string) {
    const code = this.normalizeCode(codeValue);
    const [currency, settings] = await Promise.all([
      this.repository.findCurrency(code),
      this.settingsService.getRecord()
    ]);
    if (!currency) throw new NotFoundException('收购报价币种不存在');
    return this.toResponse(currency, settings.staleMinutes);
  }

  async update(
    codeValue: string,
    dto: UpdateIdBusinessV2PurchaseQuoteDto,
    operator?: AuthenticatedUser,
    requestId = 'purchase-quote-update'
  ) {
    if (!operator?.id) throw new BadRequestException('无法识别当前操作人');

    const code = this.normalizeCode(codeValue);
    const nameCn = this.normalizeRequiredText(dto.nameCn, '币种名称', 50);
    const displayName = this.normalizeOptionalText(dto.displayName, '客户显示名称', 100);
    const purchaseRatio = this.parsePurchaseRatio(dto.purchaseRatioPercent);
    const quoteUnit = this.parsePositiveRate(dto.quoteUnit, '显示单位', MAX_QUOTE_UNIT);
    const decimalPlaces = this.parseDecimalPlaces(dto.decimalPlaces);
    const roundingMode = this.parseRoundingMode(dto.roundingMode);
    const enabled = this.parseBoolean(dto.enabled, '启用状态');
    const sortOrder = this.parseSortOrder(dto.sortOrder);
    const inputMarketRate = this.parseOptionalMarketRate(dto.marketRateCnyPerUnit);
    const inputCapturedAt = inputMarketRate
      ? this.parseCapturedAt(dto.marketRateCapturedAt)
      : undefined;
    const inputSourceReference = this.normalizeOptionalText(
      dto.marketRateSourceReference,
      '汇率来源说明',
      500
    );
    if (inputMarketRate && !inputSourceReference) {
      throw new BadRequestException('手工覆盖汇率必须填写来源说明');
    }

    const result = await this.transactionManager.execute(
      async (tx) => {
        const before = await this.repository.findCurrencyInTransaction(tx, code);
        if (!before) throw new NotFoundException('收购报价币种不存在');

        const updated = await this.repository.updateCurrency(tx, code, {
          nameCn,
          displayName,
          purchaseRatio: purchaseRatio.toString(),
          quoteUnit: quoteUnit.toString(),
          decimalPlaces,
          roundingMode,
          enabled,
          sortOrder,
          updatedBy: { connect: { id: operator.id } }
        });

        const marketRate = inputMarketRate ?? before.latestSnapshot?.marketRateCnyPerUnit ?? null;
        const marketRateCapturedAt =
          inputCapturedAt ?? before.latestSnapshot?.marketRateCapturedAt ?? null;
        const marketRateSourceReference = inputMarketRate
          ? inputSourceReference
          : (before.latestSnapshot?.marketRateSourceReference ?? null);
        const marketRateSource = inputMarketRate
          ? ('manual' as const)
          : (before.latestSnapshot?.marketRateSource ?? 'manual');

        let snapshot: IdBusinessV2PurchaseRateSnapshotRecord | null = null;
        if (marketRate && marketRateCapturedAt) {
          let calculation: ReturnType<typeof calculateV2PurchaseRate>;
          try {
            calculation = calculateV2PurchaseRate({
              marketRateCnyPerUnit: marketRate.toString(),
              purchaseRatio: purchaseRatio.toString(),
              quoteUnit: quoteUnit.toString(),
              decimalPlaces,
              roundingMode
            });
          } catch (error) {
            throw new BadRequestException(
              error instanceof Error ? error.message : '收购价计算参数无效'
            );
          }
          snapshot = await this.repository.createSnapshot(tx, {
            id: randomUUID(),
            currencyCode: code,
            marketRateCnyPerUnit: marketRate.toString(),
            purchaseRatio: purchaseRatio.toString(),
            quoteUnit: quoteUnit.toString(),
            purchaseRateRaw: calculation.purchaseRateRaw,
            purchaseRateDisplay: calculation.purchaseRateDisplay,
            decimalPlaces,
            roundingMode,
            marketRateSource,
            marketRateSourceReference,
            marketRateCapturedAt,
            fetchRunId: null,
            changeRate: null,
            validationStatus: 'normal',
            createdByUserId: operator.id
          });
        }

        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.exchange_rate.purchase_quote.update',
          objectType: 'id_business_v2_purchase_currency',
          objectId: code,
          beforeData: this.auditCurrency(before),
          afterData: {
            code,
            nameCn,
            displayName,
            purchaseRatio: purchaseRatio.toString(),
            quoteUnit: quoteUnit.toString(),
            decimalPlaces,
            roundingMode,
            enabled,
            sortOrder,
            marketRateCnyPerUnit: marketRate?.toString() ?? null,
            marketRateCapturedAt: marketRateCapturedAt?.toISOString() ?? null,
            marketRateSourceReference,
            purchaseRateSnapshotId: snapshot?.id ?? null,
            purchaseRateDisplay: snapshot?.purchaseRateDisplay.toString() ?? null
          },
          remark: 'V2 收购报价设置与重新计算'
        });

        return {
          ...updated,
          latestSnapshot: snapshot ?? updated.latestSnapshot
        };
      },
      { changedScopes: ['exchange-rates'], requestId, operator, retryMode: 'none' }
    );

    const settings = await this.settingsService.getRecord();
    return this.toResponse(result, settings.staleMinutes);
  }

  async bulkUpdate(
    dto: BulkUpdateIdBusinessV2PurchaseQuotesDto,
    operator?: AuthenticatedUser,
    requestId = 'purchase-quote-bulk-update'
  ) {
    if (!operator?.id) throw new BadRequestException('无法识别当前操作人');
    if (!Array.isArray(dto.currencyCodes) || dto.currencyCodes.length === 0) {
      throw new BadRequestException('请至少选择一个币种');
    }
    const codes = [...new Set(dto.currencyCodes.map((code) => this.normalizeCode(code)))];
    if (codes.length > 50) throw new BadRequestException('单次最多批量设置 50 个币种');
    const purchaseRatio = this.parsePurchaseRatio(dto.purchaseRatioPercent);

    await this.transactionManager.execute(
      async (tx) => {
        for (const code of codes) {
          const before = await this.repository.findCurrencyInTransaction(tx, code);
          if (!before) throw new NotFoundException(`收购报价币种 ${code} 不存在`);
          await this.repository.updateCurrency(tx, code, {
            purchaseRatio: purchaseRatio.toString(),
            updatedBy: { connect: { id: operator.id } }
          });
          let snapshotId: string | null = null;
          if (before.latestSnapshot) {
            let calculation: ReturnType<typeof calculateV2PurchaseRate>;
            try {
              calculation = calculateV2PurchaseRate({
                marketRateCnyPerUnit: before.latestSnapshot.marketRateCnyPerUnit.toString(),
                purchaseRatio: purchaseRatio.toString(),
                quoteUnit: before.quoteUnit.toString(),
                decimalPlaces: before.decimalPlaces,
                roundingMode: before.roundingMode
              });
            } catch (error) {
              throw new BadRequestException(
                `${code}：${error instanceof Error ? error.message : '收购价计算参数无效'}`
              );
            }
            const snapshot = await this.repository.createSnapshot(tx, {
              id: randomUUID(),
              currencyCode: code,
              marketRateCnyPerUnit: before.latestSnapshot.marketRateCnyPerUnit.toString(),
              purchaseRatio: purchaseRatio.toString(),
              quoteUnit: before.quoteUnit.toString(),
              purchaseRateRaw: calculation.purchaseRateRaw,
              purchaseRateDisplay: calculation.purchaseRateDisplay,
              decimalPlaces: before.decimalPlaces,
              roundingMode: before.roundingMode,
              marketRateSource: before.latestSnapshot.marketRateSource,
              marketRateSourceReference: before.latestSnapshot.marketRateSourceReference,
              marketRateCapturedAt: before.latestSnapshot.marketRateCapturedAt,
              fetchRunId: null,
              changeRate: null,
              validationStatus: 'normal',
              createdByUserId: operator.id
            });
            snapshotId = snapshot.id;
          }
          await this.audit.append(tx, {
            userId: operator.id,
            module: 'id_business_v2',
            action: 'id_business_v2.exchange_rate.purchase_quote.bulk_update',
            objectType: 'id_business_v2_purchase_currency',
            objectId: code,
            beforeData: { purchaseRatio: before.purchaseRatio.toString() },
            afterData: { purchaseRatio: purchaseRatio.toString(), snapshotId },
            remark: '批量设置收购比例并使用最后有效市场汇率重新计算'
          });
        }
      },
      { changedScopes: ['exchange-rates'], requestId, operator, retryMode: 'none' }
    );

    const result = await this.list();
    return { ...result, items: result.items.filter((item) => codes.includes(item.code)) };
  }

  async generateText(formatValue: string | undefined) {
    const format = this.parseTextFormat(formatValue);
    const [currencies, settings] = await Promise.all([
      this.repository.listCurrencies(),
      this.settingsService.getRecord()
    ]);
    const enabled = currencies.filter((currency) => currency.enabled);
    const missing = enabled.filter((currency) => !currency.latestSnapshot);
    if (missing.length > 0) {
      throw new ConflictException(
        `以下币种尚无有效报价：${missing.map((currency) => currency.code).join('、')}`
      );
    }
    const items = enabled.map((currency) => {
      const snapshot = currency.latestSnapshot!;
      const staleAt = new Date(
        snapshot.marketRateCapturedAt.getTime() + settings.staleMinutes * 60_000
      );
      return {
        code: currency.code,
        name: currency.displayName || currency.nameCn,
        quoteUnit: currency.quoteUnit.toString(),
        purchaseRateFormatted: formatV2PurchaseRate(
          snapshot.purchaseRateDisplay.toString(),
          snapshot.decimalPlaces
        ),
        marketRateCapturedAt: snapshot.marketRateCapturedAt,
        stale: staleAt.getTime() <= Date.now()
      };
    });
    const generatedAt = new Date();
    return {
      format,
      text: renderIdBusinessV2PurchaseQuoteText({ format, items, generatedAt }),
      generatedAt,
      currencyCount: items.length,
      containsStaleQuotes: items.some((item) => item.stale)
    };
  }

  private toResponse(currency: IdBusinessV2PurchaseCurrencyRecord, staleMinutes: number) {
    return {
      code: currency.code,
      nameCn: currency.nameCn,
      displayName: currency.displayName,
      purchaseRatio: currency.purchaseRatio.toString(),
      purchaseRatioPercent: multiplyDecimalStrings(currency.purchaseRatio.toString(), '100', 8),
      quoteUnit: currency.quoteUnit.toString(),
      decimalPlaces: currency.decimalPlaces,
      roundingMode: currency.roundingMode,
      enabled: currency.enabled,
      sortOrder: currency.sortOrder,
      updatedBy: currency.updatedBy,
      createdAt: currency.createdAt.toISOString(),
      updatedAt: currency.updatedAt.toISOString(),
      latestSnapshot: currency.latestSnapshot
        ? this.snapshotResponse(currency.latestSnapshot, staleMinutes)
        : null
    };
  }

  private snapshotResponse(snapshot: IdBusinessV2PurchaseRateSnapshotRecord, staleMinutes: number) {
    const staleAt = new Date(snapshot.marketRateCapturedAt.getTime() + staleMinutes * 60_000);
    return {
      id: snapshot.id,
      currencyCode: snapshot.currencyCode,
      marketRateCnyPerUnit: snapshot.marketRateCnyPerUnit.toString(),
      purchaseRatio: snapshot.purchaseRatio.toString(),
      quoteUnit: snapshot.quoteUnit.toString(),
      purchaseRateRaw: snapshot.purchaseRateRaw.toString(),
      purchaseRateDisplay: snapshot.purchaseRateDisplay.toString(),
      purchaseRateFormatted: formatV2PurchaseRate(
        snapshot.purchaseRateDisplay.toString(),
        snapshot.decimalPlaces
      ),
      decimalPlaces: snapshot.decimalPlaces,
      roundingMode: snapshot.roundingMode,
      marketRateSource: snapshot.marketRateSource,
      marketRateSourceReference: snapshot.marketRateSourceReference,
      marketRateCapturedAt: snapshot.marketRateCapturedAt.toISOString(),
      fetchRunId: snapshot.fetchRunId,
      changeRate: snapshot.changeRate?.toString() ?? null,
      validationStatus: snapshot.validationStatus,
      staleAt: staleAt.toISOString(),
      stale: staleAt.getTime() <= Date.now(),
      createdBy: snapshot.createdBy,
      createdAt: snapshot.createdAt.toISOString()
    };
  }

  private auditCurrency(currency: IdBusinessV2PurchaseCurrencyRecord) {
    return {
      code: currency.code,
      nameCn: currency.nameCn,
      displayName: currency.displayName,
      purchaseRatio: currency.purchaseRatio.toString(),
      quoteUnit: currency.quoteUnit.toString(),
      decimalPlaces: currency.decimalPlaces,
      roundingMode: currency.roundingMode,
      enabled: currency.enabled,
      sortOrder: currency.sortOrder,
      latestSnapshotId: currency.latestSnapshot?.id ?? null
    };
  }

  private normalizeCode(value: unknown) {
    const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
    if (!CURRENCY_CODE_PATTERN.test(code)) throw new BadRequestException('币种代码格式无效');
    return code;
  }

  private parsePurchaseRatio(value: unknown) {
    const percent = this.parsePositiveRate(value, '收购比例', Rate8.from('100'));
    return Rate8.from(divideDecimalStrings(percent.toString(), '100', 8));
  }

  private parsePositiveRate(value: unknown, label: string, maximum = MAX_RATE) {
    const normalized = typeof value === 'number' ? String(value) : String(value ?? '').trim();
    if (!RATE_PATTERN.test(normalized)) {
      throw new BadRequestException(
        `${label}必须是最多 ${V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES} 位小数的正数`
      );
    }
    let parsed: Rate8;
    try {
      parsed = Rate8.from(normalized);
    } catch {
      throw new BadRequestException(`${label}格式无效`);
    }
    if (parsed.lte(0)) throw new BadRequestException(`${label}必须大于 0`);
    if (parsed.gt(maximum)) throw new BadRequestException(`${label}超出允许范围`);
    return parsed;
  }

  private parseOptionalMarketRate(value: unknown) {
    const normalized = String(value ?? '').trim();
    return normalized ? this.parsePositiveRate(normalized, '国际人民币汇率') : null;
  }

  private parseDecimalPlaces(value: unknown) {
    const decimalPlaces = Number(value);
    if (
      !Number.isInteger(decimalPlaces) ||
      decimalPlaces < 0 ||
      decimalPlaces > V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES
    ) {
      throw new BadRequestException(
        `收购价小数位必须是 0 到 ${V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES} 之间的整数`
      );
    }
    return decimalPlaces;
  }

  private parseRoundingMode(value: unknown): V2PurchaseRateRoundingMode {
    if (
      typeof value !== 'string' ||
      !V2_PURCHASE_RATE_ROUNDING_MODES.includes(value as V2PurchaseRateRoundingMode)
    ) {
      throw new BadRequestException('收购价舍入方式无效');
    }
    return value as V2PurchaseRateRoundingMode;
  }

  private parseBoolean(value: unknown, label: string) {
    if (typeof value !== 'boolean') throw new BadRequestException(`${label}格式无效`);
    return value;
  }

  private parseSortOrder(value: unknown) {
    const sortOrder = Number(value);
    if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > MAX_SORT_ORDER) {
      throw new BadRequestException(`排序必须是 0 到 ${MAX_SORT_ORDER} 之间的整数`);
    }
    return sortOrder;
  }

  private parseTextFormat(value: string | undefined): IdBusinessV2PurchaseQuoteTextFormat {
    const format = value?.trim() || 'wechat';
    if (
      !ID_BUSINESS_V2_PURCHASE_QUOTE_TEXT_FORMATS.includes(
        format as IdBusinessV2PurchaseQuoteTextFormat
      )
    ) {
      throw new BadRequestException('报价文本格式无效');
    }
    return format as IdBusinessV2PurchaseQuoteTextFormat;
  }

  private parseCapturedAt(value: unknown) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized) throw new BadRequestException('汇率时间不能为空');
    const capturedAt = new Date(normalized);
    if (Number.isNaN(capturedAt.getTime())) throw new BadRequestException('汇率时间格式无效');
    if (capturedAt.getTime() > Date.now() + 5 * 60 * 1000) {
      throw new BadRequestException('汇率时间不能晚于当前时间 5 分钟以上');
    }
    return capturedAt;
  }

  private normalizeRequiredText(value: unknown, label: string, maxLength: number) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized) throw new BadRequestException(`${label}不能为空`);
    if (normalized.length > maxLength) {
      throw new BadRequestException(`${label}不能超过 ${maxLength} 个字符`);
    }
    return normalized;
  }

  private normalizeOptionalText(value: unknown, label: string, maxLength: number): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') throw new BadRequestException(`${label}格式无效`);
    const normalized = value.trim();
    if (!normalized) return null;
    if (normalized.length > maxLength) {
      throw new BadRequestException(`${label}不能超过 ${maxLength} 个字符`);
    }
    return normalized;
  }
}
