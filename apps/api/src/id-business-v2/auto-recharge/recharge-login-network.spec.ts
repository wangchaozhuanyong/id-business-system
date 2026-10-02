import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { BankRechargeAccountService } from './bank-recharge-account.service';
import { recordServerLoginNetwork } from './recharge-bank-callback';

function setup() {
  const repository = {
    loginNetwork: vi.fn().mockResolvedValue(null),
    createLoginNetwork: vi.fn().mockResolvedValue(undefined),
    updateLoginNetwork: vi.fn().mockResolvedValue(undefined)
  };
  const audit = { append: vi.fn().mockResolvedValue(undefined) };
  const encryption = {
    encrypt: vi.fn((value: string) => `encrypted:${value}`),
    decrypt: vi.fn((value: string) => value.replace(/^encrypted:/, '')),
    hash: vi.fn((value: string) => createHash('sha256').update(value).digest('hex'))
  };
  const service = new BankRechargeAccountService(
    repository as never,
    {} as never,
    audit as never,
    encryption as never
  );
  return { service, repository, audit, encryption };
}

const login = {
  email: 'Test@example.com',
  accountKey: 'a'.repeat(64),
  ip: '8.8.8.8',
  countryCode: 'US',
  expectedCountryCode: 'US',
  jobId: '11111111-1111-4111-8111-111111111111',
  ownerId: 'operator-id'
};

describe('服务器代理首次登录国家锁定', () => {
  it('首次核验后加密记录出口，后续仅更新最近出口，并拒绝跨国家', async () => {
    const { service, repository, audit, encryption } = setup();
    await service.recordVerifiedLoginNetwork({} as never, login);
    expect(repository.createLoginNetwork).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        data: expect.objectContaining({
          emailHash: encryption.hash('test@example.com'),
          firstIpEncrypted: 'encrypted:8.8.8.8',
          firstCountryCode: 'US'
        })
      })
    );
    expect(JSON.stringify(audit.append.mock.calls)).not.toContain('8.8.8.8');

    repository.loginNetwork.mockResolvedValue({
      firstCountryCode: 'US',
      lastIpEncrypted: 'encrypted:8.8.8.8',
      officialAccountKey: login.accountKey,
      lastJobId: login.jobId
    });
    expect(await service.loginNetworkGuard({} as never, login.email, 'US')).toBe('8.8.8.8');
    await expect(service.loginNetworkGuard({} as never, login.email, 'CA')).rejects.toThrow(
      '已限制登录'
    );
    await service.recordVerifiedLoginNetwork({} as never, login);
    expect(repository.updateLoginNetwork).not.toHaveBeenCalled();
    await service.recordVerifiedLoginNetwork({} as never, {
      ...login,
      ip: '1.1.1.1',
      jobId: '22222222-2222-4222-8222-222222222222'
    });
    expect(repository.updateLoginNetwork).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        data: expect.objectContaining({ lastIpEncrypted: 'encrypted:1.1.1.1' })
      })
    );
    await expect(
      service.recordVerifiedLoginNetwork({} as never, {
        ...login,
        countryCode: 'CA',
        expectedCountryCode: 'CA',
        jobId: '33333333-3333-4333-8333-333333333333'
      })
    ).rejects.toThrow('已限制登录');
  });

  it.each(['create', 'update'] as const)(
    '%s 审计使用本次任务编号，不把 64 位邮箱哈希写入 36 位对象编号',
    async (operation) => {
      const { service, repository, audit, encryption } = setup();
      const emailHash = encryption.hash('test@example.com');
      expect(emailHash).toHaveLength(64);
      if (operation === 'update') {
        repository.loginNetwork.mockResolvedValue({
          firstCountryCode: 'US',
          officialAccountKey: login.accountKey,
          lastJobId: '22222222-2222-4222-8222-222222222222'
        });
      }

      await service.recordVerifiedLoginNetwork({} as never, login);

      expect(audit.append).toHaveBeenCalledOnce();
      expect(audit.append).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: `id_business_v2.auto_recharge.login_network.${operation}`,
          objectId: login.jobId,
          afterData: { countryCode: 'US', jobId: login.jobId }
        })
      );
      const serializedAudit = JSON.stringify(audit.append.mock.calls);
      expect(serializedAudit).not.toContain(emailHash);
      expect(serializedAudit).not.toContain(login.email);
      expect(serializedAudit).not.toContain(login.ip);
    }
  );

  it('官网身份核验回执缺少真实出口时不建立登录记录', async () => {
    const account = {
      decryptExpectedEmail: vi.fn().mockReturnValue('test@example.com'),
      recordVerifiedLoginNetwork: vi.fn().mockResolvedValue(undefined)
    };
    const job = {
      id: login.jobId,
      ownerId: login.ownerId,
      action: 'server',
      accountKey: login.accountKey,
      expectedEmailEncrypted: 'encrypted-email',
      result: { expected_proxy_country: 'US' }
    };
    await expect(
      recordServerLoginNetwork(
        {} as never,
        job as never,
        { stage: 'login_verified', account_matched: true },
        account as never
      )
    ).rejects.toThrow('已限制登录');
    expect(account.recordVerifiedLoginNetwork).not.toHaveBeenCalled();
    await recordServerLoginNetwork(
      {} as never,
      job as never,
      {
        stage: 'login_verified',
        account_matched: true,
        network: { ip: '8.8.8.8', country: 'US' }
      },
      account as never
    );
    expect(account.recordVerifiedLoginNetwork).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ countryCode: 'US', expectedCountryCode: 'US' })
    );
  });
});
