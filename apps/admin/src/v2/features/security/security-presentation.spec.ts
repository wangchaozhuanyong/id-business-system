import { describe, expect, it } from 'vitest';
import {
  clientSummary,
  loginStatusMeta,
  securityUserLabel,
  sessionStateMeta
} from './security-presentation';

describe('security presentation', () => {
  it('maps controlled login states to Chinese labels', () => {
    expect(loginStatusMeta('success')).toMatchObject({ label: '成功', type: 'success' });
    expect(loginStatusMeta('blocked')).toMatchObject({ label: '已拦截', type: 'danger' });
  });

  it('marks the current active session without exposing a token', () => {
    expect(
      sessionStateMeta(
        {
          id: 'session-id',
          userId: 'user-id',
          user: { id: 'user-id', username: 'admin', displayName: '管理员' },
          lastActiveAt: '2026-07-31T00:00:00.000Z',
          expiresAt: '2026-08-31T00:00:00.000Z',
          createdAt: '2026-07-31T00:00:00.000Z',
          isCurrent: true
        },
        new Date('2026-08-01T00:00:00.000Z').getTime()
      )
    ).toMatchObject({ label: '当前会话', type: 'success' });
  });

  it('formats user and client fallbacks', () => {
    expect(securityUserLabel(null, 'admin')).toBe('admin');
    expect(clientSummary('')).toBe('—');
  });
});
