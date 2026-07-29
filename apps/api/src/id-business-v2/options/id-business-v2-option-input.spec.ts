import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  buildOptionOrderBy,
  buildOptionUniqueKey,
  normalizeOptionCurrencyCode,
  normalizeOptionDecimal,
  normalizeOptionFees,
  normalizeOptionName,
  normalizeOptionSortOrder,
  parseOptionStatus,
  parseOptionType,
  rethrowOptionUniqueConstraint
} from './id-business-v2-option-input';

describe('IdBusinessV2 option input', () => {
  it('normalizes supported option values', () => {
    expect(normalizeOptionName('  美国   区  ')).toBe('美国 区');
    expect(normalizeOptionCurrencyCode(' usd ')).toBe('USD');
    expect(normalizeOptionDecimal('12.3400', '金额', 4)).toBe('12.34');
    expect(normalizeOptionSortOrder('42')).toBe(42);
    expect(parseOptionType('country', true)).toBe('country');
    expect(parseOptionStatus('active', true)).toBe('active');
  });

  it('keeps option identity and sorting deterministic', () => {
    expect(buildOptionUniqueKey('service', 'category-1', 'country-1', 'ChatGPT')).toBe(
      'service:country-1:category-1:chatgpt'
    );
    expect(buildOptionOrderBy('updatedAt', 'desc')).toEqual([{ updatedAt: 'desc' }, { id: 'asc' }]);
  });

  it('rejects invalid money, fee, currency and sort input', () => {
    expect(() => normalizeOptionDecimal('-1', '金额', 4)).toThrow(BadRequestException);
    expect(() => normalizeOptionCurrencyCode('US')).toThrow(BadRequestException);
    expect(() => normalizeOptionSortOrder(100_000)).toThrow(BadRequestException);
    expect(() => normalizeOptionFees('country', '1', '0')).toThrow(BadRequestException);
  });

  it('maps Prisma uniqueness conflicts to the domain error', () => {
    const error = new Prisma.PrismaClientKnownRequestError('duplicate', {
      code: 'P2002',
      clientVersion: 'test'
    });
    expect(() => rethrowOptionUniqueConstraint(error)).toThrow(ConflictException);
  });
});
