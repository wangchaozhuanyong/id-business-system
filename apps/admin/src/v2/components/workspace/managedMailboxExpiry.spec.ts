import { describe, expect, it } from 'vitest';
import { resolveV2ManagedMailboxQueryCodeExpiry } from './managedMailboxExpiry';

const now = Date.parse('2026-08-29T12:00:00.000Z');

describe('managed mailbox query-code expiry presentation', () => {
  it('starts the hourly countdown at the 72-hour boundary', () => {
    expect(
      resolveV2ManagedMailboxQueryCodeExpiry('2026-09-01T12:00:00.000Z', now, '2026/09/01 20:00')
    ).toMatchObject({ label: '剩余 72小时', state: 'warning' });
  });

  it('shows hours and minutes during the final 72 hours', () => {
    expect(
      resolveV2ManagedMailboxQueryCodeExpiry('2026-08-30T14:35:00.000Z', now, '2026/08/30 22:35')
    ).toMatchObject({ label: '剩余 26小时35分钟', state: 'warning' });
  });

  it('marks an elapsed query code as expired', () => {
    expect(
      resolveV2ManagedMailboxQueryCodeExpiry('2026-08-29T11:59:59.000Z', now, '2026/08/29 19:59')
    ).toMatchObject({ label: '已到期', state: 'expired' });
  });
});
