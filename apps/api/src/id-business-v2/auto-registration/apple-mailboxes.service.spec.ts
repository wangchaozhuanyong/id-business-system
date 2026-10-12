import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type { IdBusinessV2VendureMailboxService } from '../workspace/public-api';
import { AppleMailboxesService } from './apple-mailboxes.service';
import { AppleMailboxTaskBridgeService } from './apple-mailboxes-task-bridge.service';
import type { AutoRegistrationService } from './auto-registration.service';
import type {
  AppleMailboxCodeRequest,
  AppleMailboxRecord,
  AppleMailboxSummary
} from './apple-mailboxes.types';

const taskId = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';
const actor: AuthenticatedUser = {
  id: '33333333-3333-4333-8333-333333333333',
  username: 'fixture',
  displayName: '测试管理员',
  roles: ['admin'],
  permissions: []
};
const alias: AppleMailboxSummary = {
  id: 'alias-one',
  email: 'alias@example.test',
  primaryEmail: 'primary@example.test',
  status: 'ACTIVE',
  note: null,
  updatedAt: '2026-10-09T00:00:00Z',
  authorizationValid: true,
  primaryAvailable: true
};
const baseRecord = (): AppleMailboxRecord => ({
  email: alias.email,
  aliasId: alias.id,
  registrationStatus: 'unregistered',
  revision: 1,
  registrationIp: null,
  registrationIpSource: null,
  source: 'manual',
  markedAt: '2026-10-09T00:00:00Z',
  operatorId: actor.id,
  note: '',
  activeTaskUuid: null,
  attemptIp: null,
  attemptCountry: null,
  registrationCountry: null,
  lastTaskUuid: null,
  lastResultKind: null,
  taskStatus: null
});

describe('苹果隐藏邮箱：权限、登记与私有取码桥', () => {
  let service: AppleMailboxesService;
  let records: AppleMailboxRecord[];
  let aliases: AppleMailboxSummary[];
  let requests: AppleMailboxCodeRequest[];
  let state: string;
  const revalidate = vi.fn();
  const audit = { create: vi.fn() };
  const mailboxes = {
    registrationMailboxSummaries: vi.fn(),
    registrationMailbox: vi.fn(),
    registrationCode: vi.fn()
  };
  const worker = { appleMailboxRequest: vi.fn() };
  const accounts = { registeredEmailHashes: vi.fn(), mirrorRegistration: vi.fn() };
  const proxies = { list: vi.fn(), forRegistration: vi.fn() };
  const encryption = { hash: vi.fn((email: string) => `hash:${email}`) };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-09T01:00:00Z'));
    vi.resetAllMocks();
    records = [baseRecord()];
    aliases = [alias];
    requests = [];
    state = 'running';
    revalidate.mockResolvedValue(true);
    audit.create.mockResolvedValue({});
    accounts.registeredEmailHashes.mockResolvedValue(new Set());
    accounts.mirrorRegistration.mockResolvedValue({ accountId: requestId, replayed: false });
    proxies.list.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 });
    proxies.forRegistration.mockResolvedValue({
      mode: 'static',
      type: 'http',
      host: 'proxy.example.test',
      port: 8080,
      username: 'fixture-user',
      password: 'fixture-password'
    });
    encryption.hash.mockImplementation((email: string) => `hash:${email}`);
    mailboxes.registrationMailboxSummaries.mockImplementation(async () => aliases);
    mailboxes.registrationMailbox.mockResolvedValue({
      email: 'ALIAS@example.test',
      queryCode: 'synthetic-fixture-query-code'
    });
    mailboxes.registrationCode.mockResolvedValue({ mailId: 'mail-one', code: '123456' });
    worker.appleMailboxRequest.mockImplementation(
      async (path: string, _method?: string, _body?: unknown) => {
        void _method;
        void _body;
        if (path.endsWith('/records')) return { records };
        if (path.endsWith('/start')) {
          records[0] = { ...records[0]!, activeTaskUuid: taskId, taskStatus: 'running' };
          return { taskUuid: taskId, record: records[0] };
        }
        if (path.endsWith('/requests')) return { requests };
        if (path.endsWith(`/tasks/${taskId}`))
          return {
            taskUuid: taskId,
            status: state,
            logs: [],
            record: records[0],
            resultKind: null
          };
        return { records };
      }
    );
    service = new AppleMailboxesService(
      worker as unknown as AutoRegistrationService,
      mailboxes as unknown as IdBusinessV2VendureMailboxService,
      audit as unknown as AuditLogsService,
      accounts as never,
      proxies as never,
      encryption as never,
      new AppleMailboxTaskBridgeService(worker as never, mailboxes as never, audit as never)
    );
  });

  afterEach(() => {
    service.onModuleDestroy();
    vi.useRealTimers();
  });

  async function start() {
    await service.start({ aliasId: alias.id, revision: 1 }, actor, revalidate);
    requests = [
      {
        id: requestId,
        taskUuid: taskId,
        aliasId: alias.id,
        email: alias.email,
        since: new Date().toISOString(),
        previousId: null
      }
    ];
  }

  function delivered() {
    return worker.appleMailboxRequest.mock.calls.find((call) =>
      call[0].endsWith(`/requests/${requestId}`)
    )?.[2];
  }

  it('新邮箱没有登记时默认未注册并自动进入候选，已有历史unknown保留', async () => {
    records = [];
    const result = await service.list({}, actor);
    expect(result.items[0]).toMatchObject({
      registrationStatus: 'unregistered',
      canRegister: true,
      registrationIp: null
    });
    records = [{ ...baseRecord(), registrationStatus: 'unknown' }];
    expect((await service.list({}, actor)).items[0]?.blockedReason).toContain('先确认');
  });

  it('注册IP只来自专用记录，不从邮箱列表的其他网络字段推断', async () => {
    records[0] = {
      ...baseRecord(),
      registrationStatus: 'registered',
      registrationIp: '2001:db8::10',
      registrationIpSource: 'manual'
    };
    const result = await service.list({}, actor);
    expect(result.items[0]).toMatchObject({
      registrationIp: '2001:db8::10',
      registrationIpSource: 'manual',
      canRegister: false
    });
  });

  it('主系统已有账号即使自动登记缺失也排除候选，保留软删除注册事实', async () => {
    records = [];
    accounts.registeredEmailHashes.mockResolvedValue(new Set([`hash:${alias.email}`]));
    expect((await service.list({}, actor)).items[0]).toMatchObject({
      registrationStatus: 'registered',
      canRegister: false
    });
    await expect(service.start({}, actor, revalidate)).rejects.toThrow('没有可注册');
    expect(worker.appleMailboxRequest.mock.calls.some((call) => call[0].endsWith('/start'))).toBe(
      false
    );
  });

  it('自动选择固定服务器邮箱；零候选或旧版本不会改用临时邮箱', async () => {
    await service.start({}, actor, revalidate);
    expect(worker.appleMailboxRequest).toHaveBeenCalledWith(
      '/internal/apple-mailboxes/start',
      'POST',
      expect.objectContaining({
        aliasId: alias.id,
        email: alias.email,
        revision: 1,
        options: expect.objectContaining({
          mailboxSelection: 'automatic',
          proxySource: 'default',
          proxyId: null
        })
      })
    );
    await expect(
      service.start({ aliasId: alias.id, revision: 0 }, actor, revalidate)
    ).rejects.toThrow('占用');
    records = [];
    aliases = [];
    await expect(service.start({}, actor, revalidate)).rejects.toThrow('没有可注册');
  });

  it('系统代理与原上传参数完整交给私网，不接受浏览器proxy凭据或任意options', async () => {
    await service.start(
      {
        aliasId: alias.id,
        revision: 1,
        proxyId: requestId,
        auto_upload_cpa: true,
        cpa_service_ids: [1, 2],
        auto_upload_sub2api: true,
        sub2api_service_ids: [3],
        auto_upload_tm: true,
        tm_service_ids: [4]
      },
      actor,
      revalidate
    );
    expect(proxies.forRegistration).toHaveBeenCalledWith(requestId, actor);
    const payload = worker.appleMailboxRequest.mock.calls.find((call) =>
      call[0].endsWith('/start')
    )?.[2];
    expect(payload).toMatchObject({
      options: {
        proxySource: 'system',
        proxyId: requestId,
        mailboxSelection: 'specified',
        auto_upload_cpa: true,
        cpa_service_ids: [1, 2],
        auto_upload_sub2api: true,
        sub2api_service_ids: [3],
        auto_upload_tm: true,
        tm_service_ids: [4],
        system_proxy: { host: 'proxy.example.test', port: 8080 }
      }
    });
    expect(JSON.stringify(audit.create.mock.calls)).not.toContain('fixture-password');
    await expect(
      service.start({ proxy: 'http://user:secret@proxy.test' }, actor, revalidate)
    ).rejects.toThrow('参数无效');
    await expect(service.start({ options: {} }, actor, revalidate)).rejects.toThrow('参数无效');
    await expect(
      service.start({ proxySource: 'system', proxyId: requestId }, actor, revalidate)
    ).rejects.toThrow('参数无效');
  });

  it('批量只绑定不同可用邮箱并返回不足数量，不重复邮箱凑数', async () => {
    aliases = [
      alias,
      { ...alias, id: 'alias-two', email: 'other@example.test' },
      { ...alias, id: 'alias-three', email: alias.email }
    ];
    mailboxes.registrationMailbox.mockImplementation(async (id: string) => ({
      email: aliases.find((item) => item.id === id)!.email
    }));
    const second = {
      ...baseRecord(),
      email: 'other@example.test',
      aliasId: 'alias-two',
      activeTaskUuid: requestId
    };
    worker.appleMailboxRequest.mockImplementation(
      async (path: string, _method?: string, body?: unknown) => {
        if (path.endsWith('/records')) return { records: [baseRecord()] };
        if (path.endsWith('/batch')) {
          expect(body).toMatchObject({
            items: [
              { aliasId: alias.id, email: alias.email, revision: 1 },
              { aliasId: 'alias-two', email: second.email, revision: 0 }
            ],
            concurrency: 2,
            mode: 'parallel',
            interval_min: 0,
            interval_max: 0
          });
          return {
            batchId: actor.id,
            taskUuids: [taskId, requestId],
            records: [{ ...baseRecord(), activeTaskUuid: taskId }, second],
            skipped: []
          };
        }
        return { requests: [] };
      }
    );
    const result = await service.batch(
      { count: 10, concurrency: 2, mode: 'parallel', interval_min: 0, interval_max: 0 },
      actor,
      revalidate
    );
    expect(result).toMatchObject({ accepted: 2, requested: 10 });
    expect(result.skipped).toHaveLength(1);
    expect(result.taskUuids).toEqual([taskId, requestId]);
    await expect(
      service.batch(
        {
          count: 1,
          targets: [
            { aliasId: alias.id, revision: 1 },
            { aliasId: alias.id, revision: 1 }
          ]
        },
        actor,
        revalidate
      )
    ).rejects.toThrow('重复');
    await expect(
      service.batch({ count: 1, interval_min: 5, interval_max: 4 }, actor, revalidate)
    ).rejects.toThrow('参数无效');
  });

  it('候选在批次占用时全部失效则拒绝启动，不登记空任务', async () => {
    worker.appleMailboxRequest.mockImplementation(async (path: string) => {
      if (path.endsWith('/records')) return { records: [baseRecord()] };
      if (path.endsWith('/batch'))
        return {
          batchId: null,
          taskUuids: [],
          records: [],
          skipped: [{ aliasId: alias.id, reason: 'mailbox_unavailable' }]
        };
      return { requests: [] };
    });
    await expect(service.batch({ count: 1 }, actor, revalidate)).rejects.toThrow('批次未启动');
    await service.pump();
    expect(worker.appleMailboxRequest.mock.calls.some(([path]) => path.endsWith('/requests'))).toBe(
      false
    );
    expect(accounts.mirrorRegistration).not.toHaveBeenCalled();
  });

  it.each(['saved', 'failed', 'conflict'] as const)(
    '只补同步 %s，不调用注册或上传，错误正文不外泄',
    async (status) => {
      const payload = {
        accountId: requestId,
        sourceTaskUuid: taskId,
        upstreamAccountId: '7',
        operatorId: actor.id,
        aliasId: alias.id,
        email: alias.email,
        password: 'synthetic-password',
        registrationCountry: 'US',
        source: 'register',
        fingerprint: 'a'.repeat(64)
      };
      worker.appleMailboxRequest.mockImplementation(async (path: string) =>
        path.endsWith('/sync-payload') ? payload : {}
      );
      if (status !== 'saved')
        accounts.mirrorRegistration.mockRejectedValue(
          status === 'conflict'
            ? new ConflictException('sensitive conflict')
            : new Error('sensitive token text')
        );
      expect(await service.sync(taskId, actor)).toMatchObject({ syncStatus: status });
      expect(accounts.mirrorRegistration).toHaveBeenCalledWith(
        expect.objectContaining({ registrationCountryCode: 'US', sourceTaskUuid: taskId }),
        actor
      );
      expect(worker.appleMailboxRequest.mock.calls.map((call) => call[0])).toEqual([
        `/internal/apple-mailboxes/tasks/${taskId}/sync-retry`,
        `/internal/apple-mailboxes/tasks/${taskId}/sync-payload`,
        `/internal/apple-mailboxes/tasks/${taskId}/sync-ack`
      ]);
      expect(JSON.stringify(audit.create.mock.calls)).not.toContain('synthetic-password');
      expect(JSON.stringify(worker.appleMailboxRequest.mock.calls)).not.toContain('sensitive');
    }
  );

  it('主账号提交后SQLite回执丢失，重试仍使用同一登记编号并由主服务核对来源', async () => {
    const payload = {
      accountId: requestId,
      sourceTaskUuid: taskId,
      upstreamAccountId: '7',
      operatorId: actor.id,
      aliasId: alias.id,
      email: alias.email,
      registrationCountry: null,
      source: 'login',
      fingerprint: 'b'.repeat(64)
    };
    let acknowledgements = 0;
    worker.appleMailboxRequest.mockImplementation(async (path: string) => {
      if (path.endsWith('/sync-payload')) return payload;
      if (path.endsWith('/sync-ack') && ++acknowledgements === 1) throw new Error('lost ack');
      return {};
    });
    await expect(service.sync(taskId, actor)).rejects.toThrow('lost ack');
    expect(await service.sync(taskId, actor)).toEqual({
      accountId: requestId,
      syncStatus: 'saved'
    });
    expect(accounts.mirrorRegistration.mock.calls.map((call) => call[0].accountId)).toEqual([
      requestId,
      requestId
    ]);
    expect(accounts.mirrorRegistration.mock.calls[0]?.[0]).not.toHaveProperty('password');
  });

  it('重新连接从已登记任务恢复取码边界及待同步队列，不重新选择邮箱或发起注册', async () => {
    const payload = {
      accountId: requestId,
      sourceTaskUuid: taskId,
      upstreamAccountId: '8',
      operatorId: actor.id,
      aliasId: alias.id,
      email: alias.email,
      registrationCountry: null,
      source: 'login',
      fingerprint: 'c'.repeat(64)
    };
    worker.appleMailboxRequest.mockImplementation(async (path: string) => {
      if (path.endsWith('/tasks-active'))
        return {
          tasks: [
            {
              taskUuid: taskId,
              aliasId: alias.id,
              email: alias.email,
              operatorId: actor.id,
              startedAt: new Date(Date.now() - 60_000).toISOString(),
              previousId: 'consumed-mail'
            }
          ]
        };
      if (path.endsWith('/sync-pending')) return { tasks: [{ taskUuid: taskId }] };
      if (path.endsWith('/sync-payload')) return payload;
      return {};
    });
    expect(await service.resume(actor, revalidate)).toEqual({ resumed: 1, synchronized: 1 });
    expect(
      worker.appleMailboxRequest.mock.calls.some((call) => /\/(start|batch)$/.test(call[0]))
    ).toBe(false);
    expect(mailboxes.registrationCode).not.toHaveBeenCalled();
    revalidate.mockResolvedValue(false);
    await expect(service.resume(actor, revalidate)).rejects.toThrow('重新登录');
  });

  it('补存本地账号只调用保存恢复，不请求官网注册、验证码或上传', async () => {
    worker.appleMailboxRequest.mockResolvedValue({
      task: { record: { localSaveStatus: 'saved', syncStatus: 'pending' } }
    });
    expect(await service.localSave(taskId, actor)).toEqual({ localSaveStatus: 'saved' });
    expect(worker.appleMailboxRequest).toHaveBeenCalledExactlyOnceWith(
      `/internal/apple-mailboxes/tasks/${taskId}/local-save-retry`,
      'POST',
      {}
    );
    expect(mailboxes.registrationCode).not.toHaveBeenCalled();
    expect(accounts.mirrorRegistration).not.toHaveBeenCalled();
    expect(JSON.stringify(audit.create.mock.calls)).not.toContain(alias.email);
  });

  it.each([{ status: 'DISABLED' }, { authorizationValid: false }, { primaryAvailable: false }])(
    '停用或没有有效查询授权的邮箱禁止启动：%j',
    async (change) => {
      aliases = [{ ...alias, ...change }];
      expect((await service.list({}, actor)).items[0]?.canRegister).toBe(false);
    }
  );

  it('有活动或中断占用的记录不能再次发起任务', async () => {
    records[0] = { ...baseRecord(), activeTaskUuid: taskId, taskStatus: 'interrupted' };
    expect((await service.list({}, actor)).items[0]).toMatchObject({
      canRegister: false,
      taskStatus: 'interrupted'
    });
  });

  it('解除中断占用将私有服务的记录解包为公开接口约定并保留历史注册事实', async () => {
    const recovered = {
      ...baseRecord(),
      revision: 2,
      registrationStatus: 'registered' as const,
      registrationIp: '203.0.113.10',
      registrationIpSource: 'observed' as const,
      taskStatus: 'interrupted' as const
    };
    worker.appleMailboxRequest.mockResolvedValueOnce({ record: recovered });
    expect(await service.recover({ aliasId: alias.id, revision: 1 }, actor)).toEqual(recovered);
    expect(worker.appleMailboxRequest).toHaveBeenCalledWith(
      '/internal/apple-mailboxes/recover',
      'POST',
      {
        aliasId: alias.id,
        email: alias.email,
        revision: 1,
        operatorId: actor.id
      }
    );
  });

  it('列表的搜索、筛选与分页使用真实邮箱概要和登记记录', async () => {
    aliases = [alias, { ...alias, id: 'alias-two', email: 'other@example.test' }];
    const result = await service.list(
      { q: 'alias@', registrationStatus: 'unregistered', page: '1', pageSize: '1' },
      actor
    );
    expect(result.total).toBe(1);
    expect(result.items[0]?.aliasId).toBe(alias.id);
  });

  it.each([taskId, null])(
    '公开列表区分实际占用 %s 和已解除后的历史任务',
    async (activeTaskUuid) => {
      records = [
        {
          ...baseRecord(),
          registrationStatus: 'unknown',
          activeTaskUuid,
          lastTaskUuid: taskId,
          taskStatus: 'interrupted'
        }
      ];
      const result = await service.list({}, actor);
      expect(result.items[0]).toMatchObject({
        activeTaskUuid,
        taskUuid: taskId,
        taskStatus: 'interrupted',
        registrationStatus: 'unknown',
        canRegister: false
      });
    }
  );

  it('员工不能读取IP登记或变更邮箱标记', async () => {
    const employee = { ...actor, roles: ['employee'] };
    await expect(service.list({}, employee)).rejects.toThrow('管理员');
    await expect(service.mark({}, employee)).rejects.toThrow('管理员');
    expect(worker.appleMailboxRequest.mock.calls.some((call) => call[0].endsWith('/start'))).toBe(
      false
    );
  });

  it.each(['10.1.1', 'http://127.0.0.1', 'user:password@proxy.test', ''])(
    '拒绝非法IP %s',
    async (registrationIp) => {
      await expect(
        service.mark(
          {
            items: [{ aliasId: alias.id, revision: 1 }],
            registrationStatus: 'registered',
            registrationIp
          },
          actor
        )
      ).rejects.toThrow('IPv4');
      expect(worker.appleMailboxRequest).not.toHaveBeenCalled();
    }
  );

  it('服务器指定邮箱与操作人；输入不能伪造操作者、查询码或版本', async () => {
    await expect(
      service.mark(
        {
          items: [{ aliasId: alias.id, revision: 1 }],
          registrationStatus: 'registered',
          operatorId: 'forged'
        },
        actor
      )
    ).rejects.toThrow('参数无效');
    await service.mark(
      {
        items: [{ aliasId: alias.id, revision: 1 }],
        registrationStatus: 'registered',
        registrationIp: null,
        note: '历史注册，IP 未记录'
      },
      actor
    );
    expect(worker.appleMailboxRequest).toHaveBeenCalledWith(
      '/internal/apple-mailboxes/mark',
      'POST',
      expect.objectContaining({
        operatorId: actor.id,
        registrationIp: null,
        items: [{ aliasId: alias.id, email: alias.email, revision: 1 }]
      })
    );
    expect(JSON.stringify(audit.create.mock.calls)).not.toContain(alias.email);
  });

  it('批量重复邮箱或旧版本类型在写入前拒绝', async () => {
    const items = [
      { aliasId: alias.id, revision: 1 },
      { aliasId: alias.id, revision: 1 }
    ];
    await expect(service.mark({ items, registrationStatus: 'registered' }, actor)).rejects.toThrow(
      '重复标记'
    );
    await expect(
      service.start({ aliasId: alias.id, revision: '1' }, actor, revalidate)
    ).rejects.toThrow('参数无效');
    expect(worker.appleMailboxRequest).not.toHaveBeenCalled();
  });

  it('审计失败或会话失效时，不发起注册', async () => {
    revalidate.mockResolvedValue(false);
    await expect(
      service.start({ aliasId: alias.id, revision: 1 }, actor, revalidate)
    ).rejects.toThrow('重新登录');
    revalidate.mockResolvedValue(true);
    audit.create.mockRejectedValue(new Error('synthetic audit unavailable'));
    await expect(
      service.start({ aliasId: alias.id, revision: 1 }, actor, revalidate)
    ).rejects.toThrow('audit');
    expect(worker.appleMailboxRequest).not.toHaveBeenCalled();
  });

  it.each(['start', 'batch'] as const)('等待候选或审计期间撤销会话时禁止 %s 提交', async (mode) => {
    audit.create.mockImplementation(async ({ action }: { action: string }) => {
      if (action.startsWith('发起隐藏邮箱')) revalidate.mockResolvedValue(false);
      return {};
    });
    await expect(
      mode === 'start'
        ? service.start({ aliasId: alias.id, revision: 1 }, actor, revalidate)
        : service.batch({ count: 1 }, actor, revalidate)
    ).rejects.toThrow('重新登录');
    expect(
      worker.appleMailboxRequest.mock.calls.some(
        ([path]) => path.endsWith('/start') || path.endsWith('/batch')
      )
    ).toBe(false);
  });

  it('启动只交给Python指定邮箱与任务，JWT和查询码不会透传', async () => {
    await start();
    expect(JSON.stringify(worker.appleMailboxRequest.mock.calls)).not.toContain(
      'synthetic-fixture-query-code'
    );
    expect(worker.appleMailboxRequest).toHaveBeenCalledWith(
      '/internal/apple-mailboxes/start',
      'POST',
      {
        aliasId: alias.id,
        email: alias.email,
        revision: 1,
        operatorId: actor.id,
        options: {
          proxySource: 'default',
          proxyId: null,
          mailboxSelection: 'specified',
          auto_upload_cpa: false,
          cpa_service_ids: [],
          auto_upload_sub2api: false,
          sub2api_service_ids: [],
          auto_upload_tm: false,
          tm_service_ids: []
        }
      }
    );
  });

  it('每次取码重验会话、活动任务、邮箱与收件时间，只返回6位数字', async () => {
    await start();
    await service.pump();
    expect(revalidate).toHaveBeenCalledTimes(4);
    expect(mailboxes.registrationCode).toHaveBeenCalledWith(
      alias.id,
      new Date(),
      null,
      actor,
      alias.email
    );
    expect(delivered()).toEqual({ mailId: 'mail-one', code: '123456' });
    expect(JSON.stringify(audit.create.mock.calls)).not.toContain('123456');
  });

  it('读取邮件期间会话撤销时丢弃验证码并保留未消费边界', async () => {
    await start();
    mailboxes.registrationCode.mockImplementation(async () => {
      revalidate.mockResolvedValue(false);
      return { mailId: 'mail-one', code: '123456' };
    });
    await service.pump();
    expect(delivered()).toEqual({ mailId: null, code: null, error: 'session_invalid' });
  });

  it('读取邮件期间原任务结束时不交付验证码', async () => {
    await start();
    mailboxes.registrationCode.mockImplementation(async () => {
      state = 'failed';
      return { mailId: 'mail-one', code: '123456' };
    });
    await service.pump();
    expect(delivered()).toEqual({ mailId: null, code: null, error: 'mailbox_unavailable' });
  });

  it('任务结束时认证复验抛错也释放内存上下文，保留持久化待同步结果', async () => {
    await start();
    requests = [];
    state = 'completed';
    records[0] = { ...records[0]!, syncStatus: 'pending' };
    revalidate.mockRejectedValue(new ForbiddenException('synthetic revoked session'));
    await service.pump();
    const calls = worker.appleMailboxRequest.mock.calls.length;
    vi.advanceTimersByTime(5000);
    await service.pump();
    expect(worker.appleMailboxRequest).toHaveBeenCalledTimes(calls);
    expect(accounts.mirrorRegistration).not.toHaveBeenCalled();
    expect(records[0]!.syncStatus).toBe('pending');
  });

  it.each(['12345678', 'https://auth.openai.com/verify?code=fixture'])(
    '不把8位码或验证链接填入6位OTP接口',
    async (code) => {
      await start();
      mailboxes.registrationCode.mockResolvedValue({ mailId: 'mail-one', code });
      await service.pump();
      expect(delivered()).toEqual({ mailId: null, code: null });
    }
  );

  it.each(['aliasId', 'email', 'since', 'previousId'] as const)(
    '拒绝不匹配的取码请求 %s',
    async (field) => {
      await start();
      requests[0]![field] = field === 'since' ? '2020-01-01T00:00:00Z' : 'mismatch';
      await service.pump();
      expect(mailboxes.registrationCode).not.toHaveBeenCalled();
      expect(delivered()).toMatchObject({ code: null, error: 'session_invalid' });
    }
  );

  it('会话被撤销、任务终止或登记占用不匹配时停止取码', async () => {
    await start();
    revalidate.mockResolvedValue(false);
    await service.pump();
    expect(mailboxes.registrationCode).not.toHaveBeenCalled();
    revalidate.mockResolvedValue(true);
    worker.appleMailboxRequest.mockClear();
    records[0]!.activeTaskUuid = null;
    await service.pump();
    expect(mailboxes.registrationCode).not.toHaveBeenCalled();
    expect(delivered()).toMatchObject({ error: 'mailbox_unavailable' });
  });

  it('已送达的邮件不能再次被消费，邮箱服务原始错误不泄露给worker', async () => {
    await start();
    await service.pump();
    requests[0]!.previousId = 'mail-one';
    worker.appleMailboxRequest.mockClear();
    mailboxes.registrationCode.mockResolvedValue({ mailId: 'mail-one', code: '123456' });
    await service.pump();
    expect(delivered()).toEqual({ code: null, mailId: null });
    worker.appleMailboxRequest.mockClear();
    mailboxes.registrationCode.mockRejectedValue(new Error('sensitive upstream details'));
    await service.pump();
    expect(delivered()).toEqual({ code: null, mailId: null, error: 'mail_query_failed' });
  });
});
