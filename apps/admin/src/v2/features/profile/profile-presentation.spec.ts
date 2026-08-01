import { describe, expect, it } from 'vitest';
import {
  formatProfileDate,
  profileClientSummary,
  profileRoleLabel,
  profileSessionStateMeta
} from './profile-presentation';

describe('profile presentation', () => {
  it('formats invalid and missing dates as placeholders', () => {
    expect(formatProfileDate()).toBe('—');
    expect(formatProfileDate('not-a-date')).toBe('—');
  });

  it('marks the current session and expired sessions explicitly', () => {
    const session = {
      id: 'session-id',
      userId: 'user-id',
      user: { id: 'user-id', username: 'admin', displayName: '管理员' },
      lastActiveAt: '2026-07-31T00:00:00.000Z',
      expiresAt: '2026-08-31T00:00:00.000Z',
      createdAt: '2026-07-31T00:00:00.000Z',
      isCurrent: true
    };

    expect(
      profileSessionStateMeta(session, new Date('2026-08-01T00:00:00.000Z').getTime())
    ).toMatchObject({
      label: '当前设备',
      type: 'success'
    });
    expect(
      profileSessionStateMeta(
        { ...session, isCurrent: false },
        new Date('2026-09-01T00:00:00.000Z').getTime()
      )
    ).toMatchObject({
      label: '已过期',
      type: 'warning'
    });
  });

  it('keeps client and role fallbacks readable', () => {
    expect(profileClientSummary('')).toBe('—');
    expect(profileRoleLabel([])).toBe('未分配角色');
    expect(profileRoleLabel([{ name: '管理员' }, { name: '财务' }])).toBe('管理员、财务');
  });
});
