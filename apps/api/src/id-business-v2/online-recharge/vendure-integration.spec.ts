import { BadRequestException, ConflictException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OnlineRechargeVendureIntegration,
  VENDURE_RECHARGE_SOURCE
} from './vendure-integration.service';
import { OnlineRechargeVendureController } from './vendure-integration.controller';
import { OnlineRechargeTaskNotAccepted } from './task-acceptance';
import { OnlineRechargeTasksRepository } from './persistence/tasks.repository';
const session = JSON.stringify({
  user: { id: 'demo', email: 'demo@example.test' },
  accessToken: 'synthetic-access-token-for-test-only'
});
const key = 'synthetic-vendure-service-credential-only';
const task = {
  id: '11111111-1111-4111-8111-111111111111',
  plan: 'plus',
  status: 'queued',
  updatedAt: new Date(),
  taskToken: 'synthetic-task-token',
  provider: 'private',
  result: { url: 'https://private.example.test' },
  session: 'hidden'
};
function fixture() {
  const tasks = {
    verify: vi.fn().mockResolvedValue({ plan: 'plus', status: 'available' }),
    query: vi
      .fn()
      .mockResolvedValue({ plan: 'plus', status: 'reserved', task, taskToken: task.taskToken }),
    start: vi.fn().mockResolvedValue(task),
    publicConfig: vi.fn().mockResolvedValue({ maintenance: false, provider: 'private' }),
    publicTask: vi.fn().mockResolvedValue(task)
  };
  const limits = { check: vi.fn() },
    tx = { onlineRechargeTask: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) } };
  const repository = { transaction: vi.fn(async (_scope, work) => work(tx)), log: vi.fn() };
  const service = new OnlineRechargeVendureIntegration(
    tasks as never,
    limits as never,
    repository as never
  );
  return {
    tasks,
    limits,
    tx,
    repository,
    service,
    controller: new OnlineRechargeVendureController(service)
  };
}
afterEach(() => vi.unstubAllEnvs());
describe('Vendure dedicated service boundary', () => {
  it('requires an independent credential and allowed trusted source IP', () => {
    vi.stubEnv('ONLINE_RECHARGE_VENDURE_KEY', key);
    vi.stubEnv('ONLINE_RECHARGE_VENDURE_SOURCE_IPS', '203.0.113.10');
    const { service } = fixture();
    expect(() => service.authorize(key, '::ffff:203.0.113.10')).not.toThrow();
    for (const [supplied, ip] of [
      ['bad', '203.0.113.10'],
      [key, '203.0.113.11'],
      [key, undefined]
    ])
      expect(() => service.authorize(supplied, ip)).toThrow();
    vi.stubEnv('ONLINE_RECHARGE_VENDURE_KEY', '');
    expect(() => service.authorize('', '203.0.113.10')).toThrow();
  });
  it('rejects caller plans, source markers and unexpected fields', async () => {
    const { service, tasks } = fixture();
    for (const extra of [
      { plan: 'pro_20x' },
      { integrationSource: VENDURE_RECHARGE_SOURCE },
      { recheckTaskId: task.id }
    ])
      await expect(
        service.execute('submit', { code: 'demo', session, ...extra }, '198.51.100.20')
      ).rejects.toThrow();
    expect(tasks.start).not.toHaveBeenCalled();
  });
  it('stamps a trusted source, validates full Session and returns only safe fields', async () => {
    const { service, tasks, limits } = fixture();
    const result = await service.execute('submit', { code: 'demo', session }, '198.51.100.20');
    expect(tasks.start).toHaveBeenCalledWith(
      { code: 'demo', session },
      undefined,
      'recharge',
      true,
      VENDURE_RECHARGE_SOURCE
    );
    expect(limits.check).toHaveBeenCalledWith('vendure:submit:198.51.100.20');
    expect(result).not.toHaveProperty('result');
    expect(result).not.toHaveProperty('session');
    expect(result).not.toHaveProperty('provider');
  });
  it('keeps provider data out of config and code queries', async () => {
    const { service } = fixture();
    expect(await service.execute('config', {}, '198.51.100.20')).toEqual({ maintenance: false });
    const result = await service.execute('query', { code: 'demo' }, '198.51.100.20');
    expect(JSON.stringify(result)).not.toContain('private');
    expect(JSON.stringify(result)).not.toContain('hidden');
  });
  it('never classifies an unknown acceptance outcome as rejected', async () => {
    vi.stubEnv('ONLINE_RECHARGE_VENDURE_KEY', key);
    vi.stubEnv('ONLINE_RECHARGE_VENDURE_SOURCE_IPS', '203.0.113.10');
    const { controller, tasks } = fixture();
    tasks.start.mockRejectedValueOnce(new OnlineRechargeTaskNotAccepted());
    expect(
      await controller.execute(
        'submit',
        key,
        '198.51.100.20',
        { code: 'demo', session },
        { ip: '203.0.113.10' }
      )
    ).toEqual({ rejected: true });
    tasks.start.mockRejectedValueOnce(new Error('commit response lost'));
    await expect(
      controller.execute(
        'submit',
        key,
        '198.51.100.20',
        { code: 'demo', session },
        { ip: '203.0.113.10' }
      )
    ).rejects.toThrow('commit response lost');
  });
  it('pre-dispatch invalid JSON is rejected without calling start', async () => {
    vi.stubEnv('ONLINE_RECHARGE_VENDURE_KEY', key);
    vi.stubEnv('ONLINE_RECHARGE_VENDURE_SOURCE_IPS', '203.0.113.10');
    const { controller, tasks } = fixture();
    expect(
      await controller.execute(
        'submit',
        key,
        '198.51.100.20',
        { code: 'demo', session: '{}' },
        { ip: '203.0.113.10' }
      )
    ).toEqual({ rejected: true });
    expect(tasks.start).not.toHaveBeenCalled();
  });
  it('bad accepted responses and ordinary exceptions remain unknown', async () => {
    vi.stubEnv('ONLINE_RECHARGE_VENDURE_KEY', key);
    vi.stubEnv('ONLINE_RECHARGE_VENDURE_SOURCE_IPS', '203.0.113.10');
    const { controller, tasks } = fixture();
    tasks.start.mockResolvedValueOnce({ ...task, plan: 'unsupported' });
    await expect(
      controller.execute(
        'submit',
        key,
        '198.51.100.20',
        { code: 'demo', session },
        { ip: '203.0.113.10' }
      )
    ).rejects.toThrow('Accepted recharge response');
    tasks.start.mockRejectedValueOnce(new BadRequestException('unproven failure'));
    await expect(
      controller.execute(
        'submit',
        key,
        '198.51.100.20',
        { code: 'demo', session },
        { ip: '203.0.113.10' }
      )
    ).rejects.toThrow('unproven failure');
  });
  it('only transaction rollback yields a typed non-acceptance', async () => {
    const repo = { transaction: vi.fn().mockRejectedValue(new ConflictException('capacity')) };
    const tasks = new OnlineRechargeTasksRepository(
      repo as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );
    await expect(
      tasks.start({ code: 'demo', session }, undefined, 'recharge', true, VENDURE_RECHARGE_SOURCE)
    ).rejects.toBeInstanceOf(OnlineRechargeTaskNotAccepted);
    await expect(
      tasks.start({ code: 'demo', session }, undefined, 'recharge', true)
    ).rejects.toBeInstanceOf(ConflictException);
    repo.transaction.mockRejectedValueOnce(new Error('response lost'));
    await expect(
      tasks.start({ code: 'demo', session }, undefined, 'recharge', true, VENDURE_RECHARGE_SOURCE)
    ).rejects.toThrow('response lost');
  });
  it('retains task locks/evidence and clears only website-source expired sessions', async () => {
    const { service, tx, repository } = fixture();
    await service.purgeExpiredSessions(new Date('2026-10-16T10:00:00Z'));
    expect(tx.onlineRechargeTask.updateMany).toHaveBeenCalledWith({
      where: {
        sessionEncrypted: { not: null },
        payload: { path: '$.integrationSource', equals: VENDURE_RECHARGE_SOURCE },
        OR: [
          {
            status: { in: ['succeeded', 'failed'] },
            updatedAt: { lte: new Date('2026-10-15T10:00:00Z') }
          },
          { status: 'awaiting_review', createdAt: { lte: new Date('2026-10-09T10:00:00Z') } }
        ]
      },
      data: { sessionEncrypted: null }
    });
    expect(repository.log).toHaveBeenCalledWith(
      tx,
      'vendure.session_retention',
      undefined,
      undefined,
      { clearedSessions: 2 }
    );
  });
});
