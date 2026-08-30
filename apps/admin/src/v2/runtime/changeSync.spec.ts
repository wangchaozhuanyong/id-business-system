import { describe, expect, it } from 'vitest';
import { V2_DATA_SCOPES, type V2DataScope } from '@apple-business/shared';
import {
  establishV2VersionBaseline,
  getChangedV2Scopes,
  parseV2ChangeEvent
} from './changeSyncPayload';
import {
  getV2StreamReconnectDelay,
  shouldReconcileV2OnForeground,
  V2_DEGRADED_RECONCILE_INTERVAL_MS,
  V2_STREAM_STALE_TIMEOUT_MS
} from './changeSyncPolicy';

describe('V2 change sync runtime configuration', () => {
  it('uses a short fallback interval and reconciles when a stale page returns to foreground', () => {
    expect(V2_DEGRADED_RECONCILE_INTERVAL_MS).toBe(15_000);
    expect(shouldReconcileV2OnForeground(null, 10_000)).toBe(true);
    expect(shouldReconcileV2OnForeground(6_000, 10_000)).toBe(false);
    expect(shouldReconcileV2OnForeground(5_000, 10_000)).toBe(true);
    expect(V2_STREAM_STALE_TIMEOUT_MS).toBe(60_000);
    expect([0, 1, 2, 3, 4, 99].map(getV2StreamReconnectDelay)).toEqual([
      1_000, 2_000, 5_000, 10_000, 30_000, 30_000
    ]);
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

  it('accepts and strips an optional transport id', () => {
    expect(
      parseV2ChangeEvent({
        id: '11111111-1111-4111-8111-111111111111',
        schemaVersion: 1,
        eventId: 'event-1',
        occurredAt: '2026-07-29T00:00:00.000Z',
        scopes: [{ scope: 'orders', version: '2' }]
      })
    ).toEqual({
      schemaVersion: 1,
      eventId: 'event-1',
      occurredAt: '2026-07-29T00:00:00.000Z',
      scopes: [{ scope: 'orders', version: '2' }]
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
    expect(
      parseV2ChangeEvent({
        id: { unexpected: true },
        schemaVersion: 1,
        eventId: 'event-1',
        occurredAt: '2026-07-29T00:00:00.000Z',
        scopes: [{ scope: 'orders', version: '2' }]
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

  it('establishes the first server snapshot as a baseline without reporting every scope as changed', () => {
    const versions = new Map<V2DataScope, bigint>(V2_DATA_SCOPES.map((scope) => [scope, 0n]));
    const result = {
      generatedAt: '2026-08-27T00:00:00.000Z',
      versions: {
        ...Object.fromEntries(V2_DATA_SCOPES.map((scope) => [scope, '7'])),
        orders: '12'
      } as Record<V2DataScope, string>
    };

    establishV2VersionBaseline(result, versions);

    expect(getChangedV2Scopes(result, versions)).toEqual([]);
    expect(versions.get('orders')).toBe(12n);
  });

  it('does not lower a version received from realtime while the initial snapshot is in flight', () => {
    const versions = new Map<V2DataScope, bigint>([['orders', 13n]]);
    const result = {
      generatedAt: '2026-08-27T00:00:00.000Z',
      versions: {
        ...Object.fromEntries(V2_DATA_SCOPES.map((scope) => [scope, '0'])),
        orders: '12'
      } as Record<V2DataScope, string>
    };

    establishV2VersionBaseline(result, versions);

    expect(versions.get('orders')).toBe(13n);
  });
});
