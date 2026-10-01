import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IdBusinessV2TotpAccountService } from './id-business-v2-totp-account.service';

const operator = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'member',
  displayName: '成员',
  roles: ['member'],
  permissions: []
};
const accountId = '22222222-2222-4222-8222-222222222222';
const now = new Date('2026-08-28T20:00:00.000Z');
const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

function account(overrides: Record<string, unknown> = {}) {
  return {
    id: accountId,
    userId: operator.id,
    name: '工作账号',
    issuer: 'Example',
    secretEncrypted: 'v1:encrypted-secret',
    secretHash: 'hashed-secret',
    algorithm: 'sha1' as const,
    digits: 6,
    period: 30,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

describe('IdBusinessV2TotpAccountService', () => {
  const tx = {};
  const repository = {
    listByUser: vi.fn(),
    countByUser: vi.fn(),
    findByIdAndUser: vi.fn(),
    findByUserAndName: vi.fn(),
    findByUserAndSecretHash: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn()
  };
  const transactionManager = {
    execute: vi.fn(async (work: (client: unknown) => Promise<unknown>) => work(tx))
  };
  const audit = { append: vi.fn() };
  const encryption = {
    encrypt: vi.fn(() => 'v1:encrypted-secret'),
    decrypt: vi.fn(() => secret),
    hash: vi.fn(() => 'hashed-secret')
  };
  const service = new IdBusinessV2TotpAccountService(
    repository as never,
    transactionManager as never,
    audit as never,
    encryption as never
  );

  beforeEach(() => {
    vi.clearAllMocks();
    repository.listByUser.mockResolvedValue([account()]);
    repository.countByUser.mockResolvedValue(0);
    repository.findByIdAndUser.mockResolvedValue(account());
    repository.findByUserAndName.mockResolvedValue(null);
    repository.findByUserAndSecretHash.mockResolvedValue(null);
    repository.create.mockImplementation(async (_tx, input) => account(input));
    repository.update.mockImplementation(async (_tx, id, input) => account({ id, ...input }));
    repository.remove.mockResolvedValue(account());
    audit.append.mockResolvedValue({ id: 'audit-1' });
    encryption.encrypt.mockReturnValue('v1:encrypted-secret');
    encryption.decrypt.mockReturnValue(secret);
    encryption.hash.mockReturnValue('hashed-secret');
  });

  it('lists only current-user accounts and never returns encrypted fields', async () => {
    const result = await service.list(operator);

    expect(repository.listByUser).toHaveBeenCalledWith(operator.id);
    expect(result.items[0]).toMatchObject({
      id: accountId,
      name: '工作账号',
      issuer: 'Example',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      token: expect.stringMatching(/^\d{6}$/)
    });
    expect(JSON.stringify(result)).not.toContain('encrypted-secret');
    expect(JSON.stringify(result)).not.toContain('hashed-secret');
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('为执行器读取当前用户账号，保留参数且审计不包含密钥或验证码', async () => {
    repository.findByIdAndUser.mockResolvedValueOnce(
      account({ algorithm: 'sha256', digits: 8, period: 60 })
    );
    const configuration = await service.forExecution(tx as never, accountId, operator);
    expect(repository.findByIdAndUser).toHaveBeenCalledWith(accountId, operator.id, tx);
    expect(configuration).toEqual({ algorithm: 'sha256', digits: 8, period: 60, secret });
    expect(audit.append).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'id_business_v2.workspace_totp_account.use',
        objectId: accountId,
        afterData: { algorithm: 'sha256', digits: 8, period: 60 }
      })
    );
    expect(JSON.stringify(audit.append.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(audit.append.mock.calls)).not.toContain('token');
  });

  it('执行器不能读取不存在或属于其他用户的账号', async () => {
    repository.findByIdAndUser.mockResolvedValueOnce(null);
    await expect(service.forExecution(tx as never, accountId, operator)).rejects.toBeInstanceOf(
      NotFoundException
    );
    expect(repository.findByIdAndUser).toHaveBeenCalledWith(accountId, operator.id, tx);
    expect(encryption.decrypt).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
    await expect(service.forExecution(tx as never, 'invalid-id', operator)).rejects.toThrow(
      '2FA 账号标识无效'
    );
  });

  it('执行器解密失败时不暴露底层错误，不写使用成功审计', async () => {
    encryption.decrypt.mockImplementationOnce(() => {
      throw new Error('synthetic-secret-decryption-failure');
    });
    await expect(service.forExecution(tx as never, accountId, operator)).rejects.toThrow(
      '保存的 2FA 账号暂时无法解密'
    );
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('encrypts a new secret and audits metadata without secret material', async () => {
    await service.create(
      {
        name: ' 工作 账号 ',
        secret: `otpauth://totp/Example:user?secret=${secret}&issuer=Example`
      },
      operator
    );

    expect(encryption.encrypt).toHaveBeenCalledWith(secret);
    expect(repository.create).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        userId: operator.id,
        name: '工作 账号',
        issuer: 'Example',
        secretEncrypted: 'v1:encrypted-secret',
        secretHash: 'hashed-secret',
        algorithm: 'sha1',
        digits: 6,
        period: 30
      })
    );
    expect(audit.append).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'id_business_v2.workspace_totp_account.create',
        afterData: {
          name: '工作 账号',
          issuer: 'Example',
          algorithm: 'SHA1',
          digits: 6,
          period: 30
        }
      })
    );
    expect(JSON.stringify(audit.append.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(audit.append.mock.calls)).not.toContain('encrypted-secret');
    expect(JSON.stringify(audit.append.mock.calls)).not.toContain('hashed-secret');
  });

  it('rejects duplicate names, duplicate secrets and the per-user limit', async () => {
    repository.findByUserAndName.mockResolvedValueOnce(account());
    await expect(service.create({ name: '工作账号', secret }, operator)).rejects.toBeInstanceOf(
      ConflictException
    );

    repository.findByUserAndSecretHash.mockResolvedValueOnce(account());
    await expect(service.create({ name: '第二个账号', secret }, operator)).rejects.toThrow(
      '该 2FA 密钥已经保存'
    );

    repository.countByUser.mockResolvedValueOnce(100);
    await expect(service.create({ name: '超额账号', secret }, operator)).rejects.toThrow(
      '每位用户最多保存 100 个 2FA 账号'
    );
  });

  it('updates an owned account without requiring the existing secret to be returned', async () => {
    await service.update(accountId, { name: '新名称' }, operator);
    expect(repository.update).toHaveBeenCalledWith(tx, accountId, { name: '新名称' });
    expect(encryption.encrypt).not.toHaveBeenCalled();
    expect(audit.append).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'id_business_v2.workspace_totp_account.update',
        afterData: expect.objectContaining({ secretUpdated: false })
      })
    );
  });

  it('deletes only an owned account and records a secret-free audit', async () => {
    await expect(service.remove(accountId, operator)).resolves.toEqual({
      id: accountId,
      deleted: true
    });
    expect(repository.remove).toHaveBeenCalledWith(tx, accountId);
    expect(audit.append).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: 'id_business_v2.workspace_totp_account.delete' })
    );

    repository.findByIdAndUser.mockResolvedValueOnce(null);
    await expect(service.remove(accountId, operator)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects anonymous users and malformed ids or secrets', async () => {
    await expect(service.list(undefined)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.remove('bad-id', operator)).rejects.toThrow('2FA 账号标识无效');
    await expect(
      service.create({ name: '弱密钥', secret: 'AAAAAAAAAAAAAAAA' }, operator)
    ).rejects.toThrow('2FA 密钥内容过于简单');
  });
});
