import { describe, expect, it } from 'vitest';
import { AuthLoginEvents, maskLoginEventIp } from './login-events';

describe('登录安全事件公共边界', () => {
  it('只传脱敏地址', () => {
    expect(maskLoginEventIp('192.0.2.23')).toBe('192.0.2.*');
    expect(maskLoginEventIp('::ffff:192.0.2.23')).toBe('192.0.2.*');
    expect(maskLoginEventIp('2001:db8:12::23')).toBe('2001:db8:…');
    expect(maskLoginEventIp('not-an-ip')).toBeUndefined();
  });
  it('订阅异常不影响其他接收者，模块关闭后移除监听', async () => {
    const events = new AuthLoginEvents();
    const received: unknown[] = [];
    events.subscribe(async () => {
      throw new Error('fixture subscriber failed');
    });
    const unsubscribe = events.subscribe(async (event) => {
      received.push(event);
    });
    const event = {
      event: 'admin_login_failed' as const,
      loginAttemptId: 'fixture-attempt',
      maskedIp: '192.0.2.*'
    };
    await expect(events.publish(event)).resolves.toBeUndefined();
    expect(received).toEqual([event]);
    expect(Object.isFrozen(received[0])).toBe(true);
    unsubscribe();
    await events.publish(event);
    expect(received).toHaveLength(1);
  });
});
