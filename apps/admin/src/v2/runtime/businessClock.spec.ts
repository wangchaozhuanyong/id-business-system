import { beforeEach, describe, expect, it, vi } from 'vitest';

const getServerTime = vi.hoisted(() => vi.fn());

vi.mock('@/v2/api/businessTime', () => ({
  idBusinessV2TimeApi: {
    get: getServerTime
  }
}));

describe('V2 服务器业务时钟', () => {
  beforeEach(() => {
    vi.resetModules();
    getServerTime.mockReset();
  });

  it('使用服务器时刻和单调计时，不读取电脑当前时间', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2099-01-01T00:00:00.000Z').getTime());
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(140)
      .mockReturnValueOnce(160);
    getServerTime.mockResolvedValue({
      now: '2026-08-12T00:00:01.000Z',
      timezone: 'Asia/Shanghai'
    });
    const { getV2BusinessNowMs, synchronizeV2BusinessClock } = await import('./businessClock');

    await synchronizeV2BusinessClock();

    expect(getV2BusinessNowMs()).toBe(new Date('2026-08-12T00:00:01.040Z').getTime());
  });
});
