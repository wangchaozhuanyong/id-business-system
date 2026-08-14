import { describe, expect, it } from 'vitest';
import { IdBusinessV2ActivationStatusService } from './id-business-v2-activation-status.service';

describe('IdBusinessV2ActivationStatusService', () => {
  const service = new IdBusinessV2ActivationStatusService();

  it('returns the nearest future semantic boundary without creating a polling interval', () => {
    const now = new Date('2026-07-29T12:00:00.000Z');
    const dueAt = new Date('2026-08-06T12:00:00.000Z');

    expect(service.getNextRevalidateAt(dueAt, now)).toEqual(new Date('2026-07-30T12:00:00.000Z'));
    expect(service.getNextRevalidateAt(new Date('2026-08-18T12:00:00.000Z'), now, 10)).toEqual(
      new Date('2026-08-08T12:00:00.000Z')
    );
    expect(service.getNextRevalidateAt(null, now)).toBeNull();
  });
  const now = new Date('2026-07-26T12:00:00.000Z');
  const hourMs = 60 * 60 * 1000;

  it('derives expiry from the due time without requiring a stored status update', () => {
    const result = service.resolve('active', new Date('2026-07-26T11:59:59.000Z'), now);

    expect(result).toMatchObject({
      code: 'expired',
      label: '已到期',
      hoursRemaining: 0,
      daysRemaining: 0
    });
  });

  it('uses the shortest matching due window for display', () => {
    expect(service.resolve('active', new Date('2026-07-26T12:30:00.000Z'), now).code).toBe(
      'due_within_1_hour'
    );
    expect(service.resolve('active', new Date('2026-07-27T10:00:00.000Z'), now).code).toBe(
      'due_within_23_hours'
    );
    expect(service.resolve('active', new Date('2026-07-30T12:00:00.000Z'), now).code).toBe(
      'due_within_7_days'
    );
    expect(service.resolve('active', new Date('2026-08-10T12:00:00.000Z'), now).code).toBe(
      'active'
    );
  });

  it('keeps explicit cancelled and abnormal states ahead of due-time calculation', () => {
    const expiredDueAt = new Date('2026-07-20T12:00:00.000Z');

    expect(service.resolve('cancelled', expiredDueAt, now).code).toBe('cancelled');
    expect(service.resolve('abnormal', expiredDueAt, now).code).toBe('abnormal');
  });

  it('treats a replaced activation as a terminal renewal or upgrade state', () => {
    const dueSoon = new Date('2026-07-27T10:00:00.000Z');

    expect(service.resolveDisplay('active', dueSoon, 'service-a', 'service-a', now)).toMatchObject({
      code: 'renewed',
      label: '已续费',
      hoursRemaining: null,
      daysRemaining: null
    });
    expect(service.resolveDisplay('active', dueSoon, 'service-a', 'service-b', now)).toMatchObject({
      code: 'upgraded',
      label: '已升级失效',
      hoursRemaining: null,
      daysRemaining: null
    });
    expect(service.resolveDisplay('abnormal', dueSoon, 'service-a', 'service-b', now).code).toBe(
      'abnormal'
    );
  });

  it('uses exact and non-overlapping boundaries for every calculated due state', () => {
    const dueAt = (offsetMs: number) => new Date(now.getTime() + offsetMs);

    expect(service.resolve('active', dueAt(0), now).code).toBe('expired');
    expect(service.resolve('active', dueAt(1), now).code).toBe('due_within_1_hour');
    expect(service.resolve('active', dueAt(hourMs), now).code).toBe('due_within_1_hour');
    expect(service.resolve('active', dueAt(hourMs + 1), now).code).toBe('due_within_23_hours');
    expect(service.resolve('active', dueAt(23 * hourMs), now).code).toBe('due_within_23_hours');
    expect(service.resolve('active', dueAt(23 * hourMs + 1), now).code).toBe('due_within_7_days');
    expect(service.resolve('active', dueAt(7 * 24 * hourMs), now).code).toBe('due_within_7_days');
    expect(service.resolve('active', dueAt(7 * 24 * hourMs + 1), now).code).toBe('active');
  });

  it('builds query windows that match the calculated status boundaries', () => {
    expect(service.getFilterWindow('due_within_1_hour', now)).toEqual({
      kind: 'due_window',
      after: now,
      atOrBefore: new Date(now.getTime() + hourMs)
    });
    expect(service.getFilterWindow('due_within_23_hours', now)).toEqual({
      kind: 'due_window',
      after: new Date(now.getTime() + hourMs),
      atOrBefore: new Date(now.getTime() + 23 * hourMs)
    });
    expect(service.getFilterWindow('due_within_7_days', now)).toEqual({
      kind: 'due_window',
      after: new Date(now.getTime() + 23 * hourMs),
      atOrBefore: new Date(now.getTime() + 7 * 24 * hourMs)
    });
    expect(service.getFilterWindow('active', now)).toEqual({
      kind: 'active',
      after: new Date(now.getTime() + 7 * 24 * hourMs)
    });
    expect(service.getFilterWindow('expired', now)).toEqual({
      kind: 'expired',
      evaluatedAt: now
    });
    expect(service.getFilterWindow('cancelled', now)).toEqual({
      kind: 'stored_status',
      status: 'cancelled'
    });
  });
});
