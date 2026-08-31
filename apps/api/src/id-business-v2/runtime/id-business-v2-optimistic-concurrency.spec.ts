import { BadRequestException, ConflictException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  assertV2ExpectedUpdatedAt,
  normalizeOptionalV2ExpectedUpdatedAt,
  normalizeV2ExpectedUpdatedAt,
  runV2OptimisticUpdate
} from './id-business-v2-optimistic-concurrency';

describe('V2 optimistic concurrency helpers', () => {
  const version = new Date('2026-08-31T10:00:00.000Z');

  it('normalizes required and explicitly empty singleton versions', () => {
    expect(normalizeV2ExpectedUpdatedAt(version.toISOString(), '资料')).toEqual(version);
    expect(normalizeOptionalV2ExpectedUpdatedAt(null, '设置')).toBeNull();
    expect(() => normalizeV2ExpectedUpdatedAt(undefined, '资料')).toThrow(BadRequestException);
  });

  it('rejects a stale version before a write is attempted', () => {
    expect(() =>
      assertV2ExpectedUpdatedAt(new Date('2026-08-31T10:01:00.000Z'), version, '客户资料')
    ).toThrow(ConflictException);
  });

  it('maps a lost conditional update to a conflict and preserves unrelated errors', async () => {
    await expect(
      runV2OptimisticUpdate('客户资料', async () => {
        throw { code: 'P2025' };
      })
    ).rejects.toBeInstanceOf(ConflictException);

    const failure = new Error('database unavailable');
    await expect(
      runV2OptimisticUpdate('客户资料', async () => {
        throw failure;
      })
    ).rejects.toBe(failure);
  });
});
