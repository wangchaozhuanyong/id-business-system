import { randomBytes, randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../common/prisma/prisma.service';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { V2CommandTransactionManager, V2TransactionalAuditService } from '../runtime/public-api';
import { RegistrationRepository } from './persistence/registration.repository';
import { RegistrationJobsService, registrationTokenHash } from './registration-jobs.service';
import { RegistrationEventsService } from './registration-events.service';
import { RegistrationNamesService } from './registration-names.service';
const url = process.env.V2_REGISTRATION_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('自动注册 MySQL 事务和恢复', () => {
  let prisma: PrismaService;
  let repository: RegistrationRepository;
  let jobs: RegistrationJobsService;
  let events: RegistrationEventsService;
  let names: RegistrationNamesService;
  const operator = {
    id: randomUUID(),
    username: 'registration-test',
    displayName: '隔离验收',
    roles: ['admin'],
    permissions: []
  };
  const encryption = new FieldEncryptionService(
    new ConfigService({
      FIELD_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      HASH_SECRET: randomBytes(32).toString('hex')
    })
  );
  const email = 'registration@example.test';
  let mailboxCandidate: { mailId: string; code: string } | null = null;
  const mailbox = {
    registrationMailbox: async () => ({ email }),
    registrationCode: async () => mailboxCandidate
  };
  const proxyId = randomUUID();
  const proxies = {
    forCharge: async () => ({
      type: 'http',
      mode: 'dynamic',
      extractionUrl: 'https://proxy.example.test/extract'
    })
  };
  const settings = {
    runtime: async () => ({
      connectorUrl: 'http://127.0.0.1:55321',
      connectorToken: randomBytes(32).toString('hex'),
      localApiUrl: 'http://127.0.0.1:54345',
      localApiToken: randomBytes(32).toString('hex'),
      browserOptions: {}
    })
  };
  function restart() {
    repository = new RegistrationRepository(prisma);
    const transactions = new V2CommandTransactionManager(prisma);
    const audit = new V2TransactionalAuditService();
    jobs = new RegistrationJobsService(
      repository,
      transactions,
      audit,
      encryption,
      mailbox as never,
      settings as never,
      proxies as never
    );
    events = new RegistrationEventsService(repository, transactions, audit, encryption);
    names = new RegistrationNamesService(repository, transactions, audit);
  }
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (parsed.hostname !== '127.0.0.1' || !parsed.pathname.startsWith('/registration_drill_'))
      throw new Error('仅允许一次性本地验收库');
    prisma = new PrismaService({ datasourceUrl: url });
    await prisma.$connect();
    await prisma.user.create({
      data: {
        id: operator.id,
        username: operator.username + operator.id,
        displayName: operator.displayName,
        passwordHash: 'test-only-invalid-hash'
      }
    });
    await prisma.idBusinessV2RechargeProxy.create({
      data: {
        id: proxyId,
        countryCode: 'US',
        kind: 'dynamic_residential',
        connectionMode: 'extraction',
        protocol: 'http',
        urlEncrypted: encryption.encrypt('https://proxy.example.test/extract')!,
        urlHash: encryption.hash('https://proxy.example.test/extract')!
      }
    });
    restart();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });
  it('重复名字导入与过期编辑保护，不改变旧账号默认优惠', async () => {
    const result = await names.import({ names: ['陈明', '陈明', '李华'] }, operator);
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(1);
    const entry = (await names.list({ keyword: '陈明' })).items[0]!;
    await names.write(
      entry.id,
      { displayName: '陈明', active: false, expectedUpdatedAt: entry.updatedAt.toISOString() },
      operator
    );
    await expect(
      names.write(
        entry.id,
        { displayName: '被覆盖', active: true, expectedUpdatedAt: entry.updatedAt.toISOString() },
        operator
      )
    ).rejects.toThrow('已被修改');
    const existing = await prisma.idBusinessV2ChatgptAccount.create({
      data: {
        emailEncrypted: encryption.encrypt('old@example.test')!,
        emailHash: encryption.hash('old@example.test')!,
        emailMasked: 'ol***@example.test',
        createdByUserId: operator.id,
        updatedByUserId: operator.id
      }
    });
    expect(existing.offerStatus).toBe('unknown');
    expect(existing.registrationCountryCode).toBeNull();
  });
  it('并发启动只创建一个任务，回执限定邮箱、原窗口、时效和尝试', async () => {
    const input = {
      mailboxAliasId: 'synthetic-mailbox',
      proxyId,
      birthDate: '1996-01-01',
      confirmIdentity: true
    };
    const starts = await Promise.allSettled([
      jobs.create(input, operator),
      jobs.create(input, operator)
    ]);
    expect(starts.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    const job = (await jobs.list({}, operator)).items[0]!;
    const launch = await jobs.launch(job.id, operator);
    const emit = (type: string, extra: object = {}) =>
      events.event(job.id, launch.agentToken, { type, attempt: launch.attempt, ...extra });
    await expect(jobs.get(job.id, { ...operator, id: randomUUID() })).rejects.toThrow('不存在');
    await expect(
      events.event(job.id, randomBytes(32).toString('hex'), {
        type: 'progress',
        attempt: launch.attempt
      })
    ).rejects.toThrow('授权');
    await expect(emit('registered', { email: 'wrong@example.test' })).rejects.toThrow('不一致');
    await emit('progress', { browserProfileId: 'a'.repeat(32) });
    await expect(emit('progress', { browserProfileId: 'b'.repeat(32) })).rejects.toThrow(
      '原浏览器'
    );
    await expect(
      events.event(job.id, launch.agentToken, { type: 'progress', attempt: 0 })
    ).rejects.toThrow('授权');
    await emit('waiting_email', { step: 'email_code' });
    mailboxCandidate = { code: '123456', mailId: 'current-synthetic-mail' };
    expect(await jobs.code(job.id, operator)).toMatchObject({ mailId: mailboxCandidate.mailId });
    expect(await jobs.code(job.id, operator)).toMatchObject({ mailId: mailboxCandidate.mailId });
    expect((await repository.find(job.id))?.lastMailId).toBeNull();
    await emit('mail_accepted', { mailId: mailboxCandidate.mailId });
    expect((await repository.find(job.id))?.lastMailId).toBe(mailboxCandidate.mailId);
    await expect(emit('registered', { email, registrationCountryCode: 'ZZ' })).rejects.toThrow(
      '国家代码无效'
    );
    await expect(emit('progress', { registrationCountryCode: 'US' })).rejects.toThrow('仅注册完成');
    await emit('registered', { email, registrationCountryCode: 'PH' });
    const registeredJob = (await repository.find(job.id))!;
    expect(registeredJob.registrationCountryCode).toBe('PH');
    const registeredAccount = await prisma.idBusinessV2ChatgptAccount.findUniqueOrThrow({
      where: { id: registeredJob.accountId! }
    });
    expect(registeredAccount.registrationCountryCode).toBe('PH');
    // A replay must not replace the first snapshot or an administrator's edit.
    await prisma.idBusinessV2ChatgptAccount.update({
      where: { id: registeredAccount.id },
      data: { registrationCountryCode: 'MY' }
    });
    await emit('registered', { email, registrationCountryCode: 'US' });
    expect((await repository.find(job.id))!.registrationCountryCode).toBe('PH');
    await expect(emit('complete')).rejects.toThrow('尚未完成');
    await emit('partial', { reason: 'password_unverified' });
    restart();
    const resumed = await jobs.launch(job.id, operator);
    expect(resumed.browserProfileId).toBe('a'.repeat(32));
    expect(resumed.password).toBe(launch.password);
    await expect(emit('password_verified')).rejects.toThrow('授权');
    await events.event(job.id, resumed.agentToken, {
      type: 'password_verified',
      attempt: resumed.attempt
    });
    await events.event(job.id, resumed.agentToken, {
      type: 'totp_pending',
      attempt: resumed.attempt,
      step: 'mfa',
      totpSecret: 'JBSWY3DPEHPK3PXP'
    });
    await events.event(job.id, resumed.agentToken, {
      type: 'mfa_verified',
      attempt: resumed.attempt
    });
    const accountId = (await repository.find(job.id))!.accountId!;
    const manualPassword = encryption.encrypt('synthetic-manually-updated')!;
    await prisma.idBusinessV2ChatgptAccount.update({
      where: { id: accountId },
      data: { offerStatus: 'half_price', offerSource: 'manual', passwordEncrypted: manualPassword }
    });
    await events.event(job.id, resumed.agentToken, {
      type: 'waiting_user',
      attempt: resumed.attempt
    });
    expect((await jobs.resumeCredentials(job.id, operator)).password).toBe(
      'synthetic-manually-updated'
    );
    await events.event(job.id, resumed.agentToken, {
      type: 'offer',
      attempt: resumed.attempt,
      offerStatus: 'free_trial'
    });
    await events.event(job.id, resumed.agentToken, { type: 'complete', attempt: resumed.attempt });
    const account = await prisma.idBusinessV2ChatgptAccount.findUniqueOrThrow({
      where: { id: accountId }
    });
    expect(account.offerStatus).toBe('half_price');
    expect(account.passwordEncrypted).toBe(manualPassword);
    expect(account.registrationCountryCode).toBe('MY');
    const stored = await repository.find(job.id);
    expect(JSON.stringify(stored)).not.toContain(launch.password);
    expect(JSON.stringify(stored)).not.toContain('JBSWY3DPEHPK3PXP');
    await expect(
      events.event(job.id, resumed.agentToken, { type: 'progress', attempt: resumed.attempt })
    ).rejects.toThrow('授权');
  });
  it('已过期回执不能写账号', async () => {
    const token = randomBytes(32).toString('hex');
    const row = await prisma.idBusinessV2RegistrationJob.create({
      data: {
        ownerId: operator.id,
        mailboxAliasId: 'expired',
        proxyId,
        nameId: (await prisma.idBusinessV2RegistrationName.findFirstOrThrow()).id,
        displayName: '测试',
        emailEncrypted: 'encrypted',
        emailHash: randomBytes(32).toString('hex'),
        emailMasked: 'ex***@example.test',
        birthDateEncrypted: 'encrypted',
        passwordEncrypted: 'encrypted',
        nonceHash: registrationTokenHash(token),
        attempt: 1,
        leaseUntil: new Date(Date.now() - 1000)
      }
    });
    await expect(
      events.event(row.id, token, { type: 'registered', attempt: 1, email: 'expired@example.test' })
    ).rejects.toThrow('授权');
    expect((await repository.find(row.id))?.registered).toBe(false);
  });
  it('旧连接器省略国家时留空，重复回执不补写后来的出口国家', async () => {
    const token = randomBytes(32).toString('hex');
    const legacyEmail = 'legacy-worker@example.test';
    const row = await prisma.idBusinessV2RegistrationJob.create({
      data: {
        ownerId: operator.id,
        mailboxAliasId: 'legacy-worker',
        proxyId,
        nameId: (await prisma.idBusinessV2RegistrationName.findFirstOrThrow()).id,
        displayName: '测试',
        emailEncrypted: encryption.encrypt(legacyEmail)!,
        emailHash: encryption.hash(legacyEmail)!,
        emailMasked: 'le***@example.test',
        birthDateEncrypted: 'encrypted',
        passwordEncrypted: 'encrypted',
        nonceHash: registrationTokenHash(token),
        attempt: 1,
        leaseUntil: new Date(Date.now() + 60_000)
      }
    });
    await events.event(row.id, token, { type: 'registered', attempt: 1, email: legacyEmail });
    await events.event(row.id, token, {
      type: 'registered',
      attempt: 1,
      email: legacyEmail,
      registrationCountryCode: 'US'
    });
    const stored = (await repository.find(row.id))!;
    expect(stored.registrationCountryCode).toBeNull();
    expect(
      (
        await prisma.idBusinessV2ChatgptAccount.findUniqueOrThrow({
          where: { id: stored.accountId! }
        })
      ).registrationCountryCode
    ).toBeNull();
  });
});
