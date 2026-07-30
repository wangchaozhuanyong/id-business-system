import { describe, expect, it } from 'vitest';
import { V2_DATA_SCOPES, type V2DataScope } from '@apple-business/shared';
import { shouldEnableV2RealtimeChanges } from './changeSyncConfig';
import { getChangedV2Scopes, parseV2ChangeEvent } from './changeSyncPayload';

describe('V2 change sync runtime configuration', () => {
  it('enables Realtime only when explicitly requested and Supabase is configured', () => {
    expect(shouldEnableV2RealtimeChanges('true', true)).toBe(true);
    expect(shouldEnableV2RealtimeChanges(undefined, true)).toBe(false);
    expect(shouldEnableV2RealtimeChanges('false', true)).toBe(false);
    expect(shouldEnableV2RealtimeChanges('true', false)).toBe(false);
  });
});

describe('V2 change sync payload validation', () => {
  it('accepts only the versioned scope-only broadcast contract', () => {
    expect(
      parseV2ChangeEvent({
        schemaVersion: 1,
        eventId: 'event-1',
        occurredAt: '2026-07-29T00:00:00.000Z',
        scopes: [{ scope: 'orders', version: '9007199254740993' }]
      })
    ).toEqual({
      schemaVersion: 1,
      eventId: 'event-1',
      occurredAt: '2026-07-29T00:00:00.000Z',
      scopes: [{ scope: 'orders', version: '9007199254740993' }]
    });
  });

  it('rejects unknown scopes, invalid versions and business row fields', () => {
    expect(
      parseV2ChangeEvent({
        schemaVersion: 1,
        eventId: 'event-1',
        occurredAt: '2026-07-29T00:00:00.000Z',
        scopes: [{ scope: 'unknown', version: '1' }]
      })
    ).toBeNull();
    expect(
      parseV2ChangeEvent({
        schemaVersion: 1,
        eventId: 'event-1',
        occurredAt: '2026-07-29T00:00:00.000Z',
        scopes: [{ scope: 'orders', version: '1.5' }]
      })
    ).toBeNull();
    expect(
      parseV2ChangeEvent({
        schemaVersion: 1,
        eventId: 'event-1',
        occurredAt: '2026-07-29T00:00:00.000Z',
        scopes: [{ scope: 'orders', version: '2', phone: 'sensitive' }]
      })
    ).toBeNull();
  });

  it('compares bigint versions without JavaScript number precision loss', () => {
    const versions = new Map<V2DataScope, bigint>([['orders', 9007199254740992n]]);
    expect(
      getChangedV2Scopes(
        {
          generatedAt: '2026-07-29T00:00:00.000Z',
          versions: {
            ...Object.fromEntries(V2_DATA_SCOPES.map((scope) => [scope, '0'])),
            orders: '9007199254740993'
          } as Record<V2DataScope, string>
        },
        versions
      )
    ).toEqual(['orders']);
  });
});
