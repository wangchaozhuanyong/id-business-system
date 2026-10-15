import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { AuditLogsService } from '../../audit-logs/audit-logs.service';
import { AutoRegistrationService } from './auto-registration.service';
import type { AuthenticatedUser } from '../../auth/auth.types';

const runtime = vi.hoisted(() => ({
  spawn: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn()
}));
vi.mock('node:child_process', () => ({ spawn: runtime.spawn }));
vi.mock('node:fs', () => ({ existsSync: runtime.existsSync, mkdirSync: runtime.mkdirSync }));

describe('自动注册运行环境与健康状态', () => {
  let service: AutoRegistrationService;
  const healthy = () =>
    new Response(
      JSON.stringify({ status: 'ready', database: 'isolated-sqlite', upstream: '93ab984' })
    );

  beforeEach(() => {
    runtime.existsSync.mockReturnValue(true);
    runtime.mkdirSync.mockReset();
    runtime.spawn.mockReturnValue({ once: vi.fn(), stdin: { end: vi.fn() }, kill: vi.fn() });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => healthy());
  });

  afterEach(() => {
    service?.onModuleDestroy();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  function create(environment: string) {
    const config = {
      get: (key: string) => (key === 'NODE_ENV' ? environment : 'offline-fixture-key'.repeat(3))
    } as unknown as ConfigService;
    service = new AutoRegistrationService(config, {} as AuditLogsService);
    return service;
  }

  it('生产使用镜像内解释器，数据目录仍独立保留', async () => {
    await create('production').status();
    const [python, args, options] = runtime.spawn.mock.calls[0]!;
    expect(python).toBe('/opt/id-registration/venv/bin/python');
    expect(args[0]).toBe('-B');
    expect(args[1]).toMatch(
      /apps\/api\/src\/id-business-v2\/auto-registration\/worker\/workspace\.py$/
    );
    expect(options.cwd).toMatch(/\.runtime\/auto-registration$/);
    expect(args).toHaveLength(2);
    expect(options.env).not.toHaveProperty('FIELD_ENCRYPTION_KEY');
  });

  it('本地继续使用项目内虚拟环境', async () => {
    await create('development').status();
    expect(runtime.spawn.mock.calls[0]![0]).toMatch(
      /\.runtime\/auto-registration\/venv\/bin\/python$/
    );
  });

  it('启动后每次查询状态都重新检查SQLite与资源健康', async () => {
    await create('production').status();
    vi.mocked(fetch).mockResolvedValue(new Response('{"detail":"未就绪"}', { status: 503 }));
    await expect(service.status()).rejects.toThrow('自动注册服务尚未就绪');
  });

  it('HTTP 200但返回内容并非本模块健康证明时不宣称就绪', async () => {
    await create('production').status();
    vi.mocked(fetch).mockResolvedValue(new Response('{"status":"ready"}'));
    await expect(service.status()).rejects.toThrow('自动注册服务尚未就绪');
  });

  it('通用任务只透传当前已认证操作者，忽略浏览器伪造的私有身份', async () => {
    await create('production').status();
    const response = { setHeader: vi.fn(), end: vi.fn(), statusCode: 0 };
    const actor = { id: 'trusted-actor', roles: ['admin'] } as AuthenticatedUser;
    const observer = vi.fn();
    service.onWorkspaceOperator = observer;
    const revalidate = async () => true;
    await service.proxy(
      {
        originalUrl: '/api/id-business-v2/auto-registration/workspace/accounts',
        method: 'GET',
        headers: { 'x-id-workspace-operator-id': 'forged-actor' }
      } as never,
      response as never,
      actor,
      revalidate
    );
    expect(vi.mocked(fetch).mock.calls.at(-1)?.[1]?.headers).toMatchObject({
      'X-ID-Workspace-Operator-Id': 'trusted-actor'
    });
    expect(observer).toHaveBeenCalledWith(actor, revalidate);
    expect(response.end).toHaveBeenCalledTimes(1);
  });
});
