import { describe, expect, it, vi } from 'vitest';
import { RechargeRepository } from './recharge.repository';

describe('同一用户的独立比特连接执行占用', () => {
  const task = (key?: string) => ({
    id: 'other-job',
    ownerId: 'owner',
    action: 'bitbrowser',
    result: key ? { connection_api_key: key } : {}
  });
  it('允许不同连接，阻止同一接口和未绑定的历史任务', async () => {
    const jobs = {
      findMany: vi.fn().mockResolvedValue([task('connection-a')]),
      findFirst: vi.fn()
    };
    const tx = { idBusinessV2RechargeJob: jobs };
    const repository = new RechargeRepository({} as never);
    await expect(
      repository.findRunningJob(tx as never, 'owner', 'connection-b')
    ).resolves.toBeNull();
    await expect(
      repository.findRunningJob(tx as never, 'owner', 'connection-a')
    ).resolves.toMatchObject({ id: 'other-job' });
    jobs.findMany.mockResolvedValue([task()]);
    await expect(
      repository.findRunningJob(tx as never, 'owner', 'connection-b', 'current-job')
    ).resolves.toMatchObject({ id: 'other-job' });
    expect(jobs.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ ownerId: 'owner', id: { not: 'current-job' } }),
        take: 101
      })
    );
  });
  it('不把未查完的占用当作空闲，未指定连接时保留原有用户级保护', async () => {
    const jobs = {
      findMany: vi.fn().mockResolvedValue(Array.from({ length: 101 }, () => task('connection-a'))),
      findFirst: vi.fn().mockResolvedValue(task())
    };
    const repository = new RechargeRepository({} as never);
    await expect(
      repository.findRunningJob({ idBusinessV2RechargeJob: jobs } as never, 'owner', 'connection-b')
    ).rejects.toThrow('连接过多');
    await expect(
      repository.findRunningJob({ idBusinessV2RechargeJob: jobs } as never, 'owner')
    ).resolves.toMatchObject({ id: 'other-job' });
  });
});
