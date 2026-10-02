import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { V2CommandTransactionManager, V2TransactionalAuditService } from '../runtime/public-api';
import { BankRechargeAccountService } from './bank-recharge-account.service';
import { BankRechargeRepository } from './persistence/bank-recharge.repository';
import { RechargeAddressRepository } from './persistence/recharge-address.repository';
import { RechargeRepository } from './persistence/recharge.repository';
import { RechargeService } from './recharge.service';

const url = process.env.V2_RECHARGE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('服务器登录出口审计 MySQL 回归', () => {
  let prisma: PrismaService;
  let service: RechargeService;
  let audit: V2TransactionalAuditService;
  const ownerId = randomUUID();
  const encryption = new FieldEncryptionService({
    get: (key: string) =>
      key === 'FIELD_ENCRYPTION_KEY'
        ? 'isolated-login-network-field-key'
        : 'isolated-login-network-hash'
  } as never);

  beforeAll(async () => {
    const parsed = new URL(url!);
    if (parsed.hostname !== '127.0.0.1' || !parsed.pathname.includes('financial_integrity_'))
      throw new Error('仅允许本机隔离验收库');
    prisma = new PrismaService({ datasourceUrl: url });
    await prisma.$connect();
    await prisma.user.create({
      data: {
        id: ownerId,
        username: `login-network-${ownerId}`,
        displayName: '登录审计隔离验收',
        passwordHash: 'test-only-not-valid-password'
      }
    });
    const transactions = new V2CommandTransactionManager(prisma);
    audit = new V2TransactionalAuditService();
    service = new RechargeService(
      new RechargeRepository(prisma),
      new RechargeAddressRepository(prisma),
      transactions,
      audit,
      new BankRechargeAccountService(
        new BankRechargeRepository(prisma),
        transactions,
        audit,
        encryption
      )
    );
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await prisma?.$disconnect();
  });

  const createJob = (email: string, accountKey: string) =>
    prisma.idBusinessV2RechargeJob.create({
      data: {
        id: randomUUID(),
        ownerId,
        accountKey,
        expectedEmailEncrypted: encryption.encrypt(email),
        action: 'server',
        plan: 'plus',
        state: 'running',
        result: { expected_proxy_country: 'PH' },
        leaseUntil: new Date(Date.now() + 60000)
      }
    });

  const progress = (ip: string) => ({
    type: 'progress',
    result: { stage: 'login_verified', account_matched: true, network: { ip, country: 'PH' } }
  });

  it('首次与后续核验真实落库，重复回传幂等，审计不超出 CHAR(36)', async () => {
    const email = `login-network-${randomUUID()}@example.invalid`;
    const emailHash = encryption.hash(email)!;
    const accountKey = 'd'.repeat(64);
    const first = await createJob(email, accountKey);
    expect(emailHash).toHaveLength(64);

    await expect(service.callback(first.id, progress('203.0.113.10'))).resolves.toEqual({
      ok: true
    });
    await service.callback(first.id, progress('203.0.113.10'));
    const second = await createJob(email, accountKey);
    await service.callback(second.id, progress('203.0.113.20'));

    const network = await prisma.idBusinessV2RechargeLoginNetwork.findUniqueOrThrow({
      where: { emailHash }
    });
    expect(network).toMatchObject({
      firstCountryCode: 'PH',
      lastCountryCode: 'PH',
      lastJobId: second.id,
      loginCount: 2
    });
    expect(encryption.decrypt(network.firstIpEncrypted)).toBe('203.0.113.10');
    expect(encryption.decrypt(network.lastIpEncrypted)).toBe('203.0.113.20');
    const storedJob = await prisma.idBusinessV2RechargeJob.findUniqueOrThrow({
      where: { id: second.id }
    });
    expect(storedJob.result).toMatchObject({ stage: 'login_verified', account_matched: true });
    expect(storedJob.result).not.toHaveProperty('network');

    const audits = await prisma.auditLog.findMany({
      where: { userId: ownerId, objectType: 'recharge_login_network' },
      orderBy: { createdAt: 'asc' }
    });
    expect(audits.map((entry) => entry.objectId)).toEqual([first.id, second.id]);
    expect(audits.map((entry) => entry.action)).toEqual([
      'id_business_v2.auto_recharge.login_network.create',
      'id_business_v2.auto_recharge.login_network.update'
    ]);
    expect(audits[1]?.afterData).toEqual({ countryCode: 'PH', jobId: second.id });
    const serializedAudits = JSON.stringify(audits);
    expect(serializedAudits).not.toContain(email);
    expect(serializedAudits).not.toContain(emailHash);
    expect(serializedAudits).not.toContain('203.0.113.');
    expect(await prisma.idBusinessV2RechargeRecord.count({ where: { accountKey } })).toBe(0);
  });

  it('审计写入失败时仍回滚登录出口与进度，不绕过持久化保护', async () => {
    const email = `audit-failure-${randomUUID()}@example.invalid`;
    const job = await createJob(email, 'e'.repeat(64));
    vi.spyOn(audit, 'append').mockRejectedValueOnce(new Error('synthetic audit failure'));

    await expect(service.callback(job.id, progress('203.0.113.30'))).rejects.toThrow(
      'synthetic audit failure'
    );
    expect(
      await prisma.idBusinessV2RechargeLoginNetwork.findUnique({
        where: { emailHash: encryption.hash(email)! }
      })
    ).toBeNull();
    const storedJob = await prisma.idBusinessV2RechargeJob.findUniqueOrThrow({
      where: { id: job.id }
    });
    expect(storedJob.result).toEqual({ expected_proxy_country: 'PH' });
    expect(await prisma.auditLog.count({ where: { objectId: job.id } })).toBe(0);
  });
});
