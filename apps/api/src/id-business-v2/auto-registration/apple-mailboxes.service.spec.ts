import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type { IdBusinessV2VendureMailboxService } from '../workspace/public-api';
import { AppleMailboxesService } from './apple-mailboxes.service';
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
      audit as unknown as AuditLogsService
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

  it('旧邮箱没有登记时为待确认，不能默认作为未注册候选', async () => {
    records = [];
    const result = await service.list({}, actor);
    expect(result.items[0]).toMatchObject({
      registrationStatus: 'unknown',
      canRegister: false,
      registrationIp: null
    });
    expect(result.items[0]?.blockedReason).toContain('先确认');
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

  it('员工不能读取IP登记或变更邮箱标记', async () => {
    const employee = { ...actor, roles: ['employee'] };
    await expect(service.list({}, employee)).rejects.toThrow('管理员');
    await expect(service.mark({}, employee)).rejects.toThrow('管理员');
    expect(worker.appleMailboxRequest).not.toHaveBeenCalled();
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

  it('启动只交给Python指定邮箱与任务，JWT和查询码不会透传', async () => {
    await start();
    expect(JSON.stringify(worker.appleMailboxRequest.mock.calls)).not.toContain(
      'synthetic-fixture-query-code'
    );
    expect(worker.appleMailboxRequest).toHaveBeenCalledWith(
      '/internal/apple-mailboxes/start',
      'POST',
      { aliasId: alias.id, email: alias.email, revision: 1, operatorId: actor.id }
    );
  });

  it('每次取码重验会话、活动任务、邮箱与收件时间，只返回6位数字', async () => {
    await start();
    await service.pump();
    expect(revalidate).toHaveBeenCalledTimes(2);
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
