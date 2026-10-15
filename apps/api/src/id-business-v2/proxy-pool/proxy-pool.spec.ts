import { describe, expect, it, vi } from 'vitest';
import { RechargeProxyService } from './proxy-pool.service';
import { OnlineProxyPoolRepository } from './persistence/online-proxy.repository';
import { parseRechargeProxy, rechargeProxyConnection } from './proxy-pool-validation';
const id = '123e4567-e89b-42d3-a456-426614174000';
const oldId = '123e4567-e89b-42d3-a456-426614174001';
const operator = { id: 'operator', roles: ['admin'] } as never;
function fixture() {
  const repository = {
    list: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    byHash: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({ id }),
    update: vi.fn(),
    delete: vi.fn(),
    hasJobs: vi.fn().mockResolvedValue(null),
    resolveOnlineId: vi.fn().mockResolvedValue({ proxyId: id }),
    findInTransaction: vi.fn().mockResolvedValue({ id, active: true }),
    active: vi.fn()
  };
  const transactions = {
    execute: vi.fn((work: (tx: object) => unknown, _options: unknown) => {
      void _options;
      return work({});
    })
  };
  const audit = { append: vi.fn() };
  const encryption = {
    hash: vi.fn((value) => `hash:${value}`),
    encrypt: vi.fn((value) => `encrypted:${value}`),
    decrypt: vi.fn((value) => value.slice(10))
  };
  const service = new RechargeProxyService(
    repository as never,
    transactions as never,
    audit as never,
    encryption as never
  );
  const online = new OnlineProxyPoolRepository(service, repository as never, encryption as never);
  return { repository, service, online, transactions, audit };
}
describe('shared proxy pool', () => {
  it('keeps connection mode independent of mobile attribute, preserving literal sessions', () => {
    expect(
      parseRechargeProxy({
        countryCode: 'PH',
        kind: 'mobile',
        url: 'https://user-{session}:pass@gateway.example.test',
        connectionMode: 'direct',
        protocol: 'https'
      })
    ).toMatchObject({
      connectionMode: 'direct',
      kind: 'mobile',
      url: expect.stringContaining('{session}')
    });
    expect(
      parseRechargeProxy({
        countryCode: 'PH',
        kind: 'static_residential',
        url: 'https://gateway.example.test:8443/extract',
        connectionMode: 'extraction',
        protocol: 'socks5'
      })
    ).toMatchObject({ connectionMode: 'extraction', protocol: 'socks5' });
    const connection = rechargeProxyConnection(
      'http://user-{session}:pass-{session}@gateway.example.test:8080',
      'direct',
      'http'
    );
    expect(connection.mode).toBe('static');
    if (connection.mode === 'static')
      expect(connection.username.slice(5)).toBe(connection.password.slice(5));
  });
  it('validates all bulk rows before writes and deduplicates without reactivating entries', async () => {
    const f = fixture();
    await expect(
      f.service.importMany(
        {
          proxies: [
            {
              url: 'https://localhost/x',
              countryCode: 'US',
              kind: 'mobile',
              connectionMode: 'extraction'
            }
          ]
        },
        operator,
        true
      )
    ).rejects.toThrow('第 1 行');
    expect(f.transactions.execute).not.toHaveBeenCalled();
    f.repository.byHash.mockResolvedValueOnce({ id, active: false });
    const result = await f.service.importMany(
      {
        proxies: [
          {
            url: 'http://gateway.example.test:8080',
            countryCode: 'PH',
            kind: 'mobile',
            connectionMode: 'direct'
          },
          {
            url: 'http://other.example.test:8080',
            countryCode: 'PH',
            kind: 'mobile',
            connectionMode: 'direct'
          }
        ]
      },
      operator,
      true
    );
    expect(result).toEqual({ imported: 1, inserted: 1, duplicates: 1 });
    expect(f.repository.update).not.toHaveBeenCalled();
    expect(JSON.stringify(f.audit.append.mock.calls)).not.toContain('gateway.example');
    expect(f.transactions.execute.mock.calls.at(-1)?.[1]).toMatchObject({
      changedScopes: ['auto-recharge', 'online-recharge']
    });
  });
  it('routes legacy online imports into the same pool with incomplete metadata', async () => {
    const f = fixture();
    await f.online.action(
      'import',
      { proxies: ['https://user-{session}:pass@gateway.example.test'] },
      operator
    );
    expect(f.repository.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ countryCode: null, kind: null, connectionMode: 'direct' })
    );
    f.repository.findInTransaction.mockResolvedValue({
      id,
      active: true,
      countryCode: null,
      kind: null
    });
    await expect(f.service.forCharge(id, operator)).rejects.toThrow('待补充');
  });
  it('resolves old online IDs and shares detection results without revealing credentials', async () => {
    const f = fixture();
    f.repository.active.mockResolvedValue([
      {
        id,
        urlEncrypted: 'encrypted:http://user:pass@gateway.example.test:8080',
        protocol: 'http',
        connectionMode: 'direct'
      }
    ]);
    expect(await f.online.active({} as never, oldId)).toMatchObject({
      id,
      proxy_url: expect.any(String)
    });
    expect(f.repository.active).toHaveBeenCalledWith({}, id);
    await f.online.result({} as never, oldId, { ip: '8.8.8.8', latencyMs: 0, ok: true });
    expect(f.repository.update).toHaveBeenCalledWith(
      {},
      id,
      expect.objectContaining({ exitIp: '8.8.8.8', latencyMs: 0, testMessage: '检测成功' })
    );
    f.repository.active.mockResolvedValue([]);
    await expect(f.online.active({} as never, id)).rejects.toThrow('已停用');
  });
  it('preserves used resources and rejects stale editor versions', async () => {
    const f = fixture();
    f.repository.hasJobs.mockResolvedValue({ id: 'historical-task' });
    await expect(f.service.delete(id, operator)).rejects.toThrow('请改为停用');
    f.repository.findInTransaction.mockResolvedValue({
      id,
      updatedAt: new Date('2026-10-15T00:00:00Z')
    });
    await expect(
      f.service.update(
        id,
        { remark: 'changed', expectedUpdatedAt: '2026-10-14T00:00:00Z' },
        operator
      )
    ).rejects.toThrow('已被修改');
    expect(f.repository.delete).not.toHaveBeenCalled();
  });
});
