import { BadRequestException } from '@nestjs/common';
import type {
  IdBusinessV2OptionStatus,
  IdBusinessV2TopupSupplierLedgerEntryType
} from '@prisma/client';
import { buildIdBusinessV2DateRange } from '../runtime/public-api';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEDGER_TYPES = new Set<IdBusinessV2TopupSupplierLedgerEntryType>([
  'opening_balance',
  'payment_credit',
  'gift_card_debit',
  'id_purchase_debit',
  'gift_card_withdrawal_reversal',
  'manual_adjustment',
  'payment_reversal'
]);

export abstract class IdBusinessV2TopupSupplierFundsQuerySupport {
  protected normalizeKeyword(value: unknown) {
    if (value === undefined || value === null) return null;
    const normalized = String(value).trim();
    if (!normalized) return null;
    if (normalized.length > 120) {
      throw new BadRequestException('搜索关键词不能超过 120 个字符');
    }
    return normalized;
  }

  protected normalizeOptionalUuid(value: unknown, label: string) {
    if (value === undefined || value === null || value === '') return null;
    return this.normalizeRequiredUuid(value, label);
  }

  protected normalizeRequiredUuid(value: unknown, label: string) {
    const normalized = String(value ?? '').trim();
    if (!UUID_PATTERN.test(normalized)) throw new BadRequestException(`${label}格式无效`);
    return normalized;
  }

  protected parseOptionStatus(value: unknown): IdBusinessV2OptionStatus | null {
    const normalized = this.normalizeNullableString(value);
    if (!normalized) return null;
    if (normalized === 'active' || normalized === 'disabled') return normalized;
    throw new BadRequestException('供应商状态无效');
  }

  protected parseFundingStatus(value: unknown) {
    const normalized = this.normalizeNullableString(value);
    if (!normalized) return null;
    if (
      normalized === 'initialized' ||
      normalized === 'uninitialized' ||
      normalized === 'negative'
    ) {
      return normalized;
    }
    throw new BadRequestException('资金状态无效');
  }

  protected parsePaymentStatus(value: unknown) {
    const normalized = this.normalizeNullableString(value);
    if (!normalized) return null;
    if (normalized === 'active' || normalized === 'reversed') return normalized;
    throw new BadRequestException('付款状态无效');
  }

  protected parseLedgerEntryType(value: unknown): IdBusinessV2TopupSupplierLedgerEntryType | null {
    const normalized = this.normalizeNullableString(value);
    if (!normalized) return null;
    if (LEDGER_TYPES.has(normalized as IdBusinessV2TopupSupplierLedgerEntryType)) {
      return normalized as IdBusinessV2TopupSupplierLedgerEntryType;
    }
    throw new BadRequestException('供应商资金流水类型无效');
  }

  protected parseDateRange(dateFromValue: unknown, dateToValue: unknown) {
    return buildIdBusinessV2DateRange(dateFromValue, dateToValue, {
      from: '开始日期',
      to: '结束日期',
      invalidRange: '开始日期不能晚于结束日期'
    });
  }

  private normalizeNullableString(value: unknown) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new BadRequestException('参数格式无效');
    }
    return String(value).trim() || null;
  }
}
