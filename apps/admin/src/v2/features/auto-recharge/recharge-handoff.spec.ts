import { describe, expect, it } from 'vitest';
import { handoffCoordinates, validHandoffAction, validHandoffFrame } from './recharge-handoff';
import type { V2RechargeHandoffFrame } from './contracts';
import { getApiRequestRetryDelay } from '@/api/requestPolicy';

const frame: V2RechargeHandoffFrame = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  frameId: '22222222-2222-4222-8222-222222222222',
  revision: 1,
  kind: 'bank',
  image: 'data:image/jpeg;base64,AAAA',
  width: 1000,
  height: 600,
  expiresAt: new Date(200_000).toISOString()
};
describe('原付款验证画面协议', () => {
  it.each(['handoff', 'confirm'])('%s 写操作不经过全局网络自动重试', (path) => {
    const input = {
      url: `/id-business-v2/auto-recharge/jobs/synthetic/${path}`,
      method: 'post',
      retryCount: 0,
      isNetworkError: true
    };
    expect(getApiRequestRetryDelay(input)).toBeNull();
    expect(getApiRequestRetryDelay({ ...input, isNetworkError: false, status: 503 })).toBeNull();
  });
  it('只接受受控且未过期的原验证画面', () => {
    expect(validHandoffFrame(frame, 100_000)).toBe(true);
    for (const change of [
      { revision: 0 },
      { width: 2049 },
      { image: 'https://example.test/challenge' },
      { image: 'data:image/svg+xml;base64,AAAA' },
      { sessionId: 'other' },
      { expiresAt: new Date(99_999).toISOString() },
      { expiresAt: new Date(402_000).toISOString() }
    ])
      expect(validHandoffFrame({ ...frame, ...change }, 100_000)).toBe(false);
  });
  it('按图片实际显示比例映射坐标，边缘不会越界', () => {
    const bounds = { left: 10, top: 20, width: 500, height: 300 };
    expect(handoffCoordinates(frame, bounds, 260, 170)).toEqual({ x: 500, y: 300 });
    expect(handoffCoordinates(frame, bounds, 510, 320)).toEqual({ x: 999, y: 599 });
    expect(handoffCoordinates(frame, bounds, 9, 20)).toBeNull();
    expect(handoffCoordinates(frame, { ...bounds, width: 0 }, 10, 20)).toBeNull();
  });
  it('只接受画面内点击、受控键、有限滚动与短临时输入', () => {
    expect(validHandoffAction({ type: 'click', x: 999, y: 599 }, frame)).toBe(true);
    expect(validHandoffAction({ type: 'click', x: 1000, y: 0 }, frame)).toBe(false);
    expect(validHandoffAction({ type: 'text', text: '123456' }, frame)).toBe(true);
    for (const text of ['', 'x'.repeat(65), '123\n456', '123\t456', '123\u007f'])
      expect(validHandoffAction({ type: 'text', text }, frame)).toBe(false);
    expect(validHandoffAction({ type: 'scroll', deltaY: 600 }, frame)).toBe(true);
    expect(validHandoffAction({ type: 'scroll', deltaY: 601 }, frame)).toBe(false);
  });
});
