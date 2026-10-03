import { randomBytes, randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../../common/prisma/prisma.service';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { V2CommandTransactionManager, V2TransactionalAuditService } from '../runtime/public-api';
import { RegistrationRepository } from './persistence/registration.repository';
import { RegistrationJobsService, registrationTokenHash } from './registration-jobs.service';
import { RegistrationEventsService } from './registration-events.service';
import { RegistrationNamesService } from './registration-names.service';
import { RegistrationMailboxesService } from './registration-mailboxes.service';
const worker = vi.hoisted(() => ({
  payload: {} as Record<string, unknown>,
  command: vi.fn(),
  delivery: 'accepted' as 'accepted' | 'not_received' | 'unknown'
}));
vi.mock('./registration-worker', () => ({
  requireRegistrationWorker: async () => {},
  registrationWorkerCommand: (...args: unknown[]) => {
    if (args[2] === 'launch') worker.payload = args[3] as Record<string, unknown>;
    worker.command(...args);
    return Promise.resolve({ delivery: worker.delivery });
  }
}));
const url = process.env.V2_REGISTRATION_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('自动注册 MySQL 事务和恢复', () => {
  let prisma: PrismaService;
  let repository: RegistrationRepository;
  let jobs: RegistrationJobsService;
  let events: RegistrationEventsService;
  let names: RegistrationNamesService;
  let mailboxes: RegistrationMailboxesService;
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
  const correctionEmail = 'correction@example.test';
  const aliasVersion = '2026-10-03T08:00:00.000Z';
  let mailboxCandidate: { mailId: string; code: string } | null = null;
  const mailbox = {
    registrationMailbox: async (id: string) => ({
      email:
        id === 'correction'
          ? correctionEmail
          : id === 'dispatch-check'
            ? 'dispatch@example.test'
            : id.startsWith('age-cycle-')
              ? `${id}@example.test`
              : email
    }),
    aliasAddress: async () => ({ email: correctionEmail, updatedAt: aliasVersion }),
    registrationCode: async () => mailboxCandidate
  };
  const proxyId = randomUUID();
  const proxies = {
    forCharge: async () => ({
      id: proxyId,
      countryCode: 'US',
      kind: 'dynamic_residential',
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
    mailboxes = new RegistrationMailboxesService(
      repository,
      mailbox as never,
      transactions,
      audit,
      encryption
    );
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
    expect(existing.registered).toBe(true);
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
    expect(job.registrationAge).toBe(20);
    const receipt = await jobs.launch(job.id, operator);
    expect(receipt).not.toHaveProperty('agentToken');
    expect(receipt).not.toHaveProperty('password');
    expect(worker.payload).toMatchObject({
      expectedCountry: 'US',
      proxy: { countryCode: 'US' },
      registrationAge: 20,
      birthDate: '1996-01-01'
    });
    const launch = worker.payload as {
      agentToken: string;
      attempt: number;
      password: string;
      browserProfileId: string;
    };
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
    await emit('progress', { browserProfileId: 'reg_' + 'a'.repeat(64) });
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
    await jobs.launch(job.id, operator);
    const resumed = worker.payload as typeof launch;
    expect(worker.payload.registrationAge).toBe(20);
    expect(resumed.browserProfileId).toBe('reg_' + 'a'.repeat(64));
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
    await jobs.resume(job.id, operator);
    expect(worker.command).toHaveBeenLastCalledWith(
      job.id,
      resumed.attempt,
      'resume',
      expect.objectContaining({ password: 'synthetic-manually-updated' })
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
    await expect(
      jobs.create(
        {
          mailboxAliasId: 'dispatch-check',
          proxyId,
          birthDate: '1996-01-01',
          confirmIdentity: true
        },
        operator
      )
    ).rejects.toThrow('已有注册任务');
    await jobs.cancel(row.id, operator);
    expect((await repository.find(row.id))?.state).toBe('cancelled');
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
    await jobs.cancel(row.id, operator);
  });
  it('未接收时撤销本次授权，取消关闭未确认时不伪装为已关闭', async () => {
    const job = await jobs.create(
      {
        mailboxAliasId: 'dispatch-check',
        proxyId,
        birthDate: '1996-01-01',
        confirmIdentity: true
      },
      operator
    );
    try {
      worker.delivery = 'not_received';
      const receipt = await jobs.launch(job.id, operator);
      const launch = worker.payload as { agentToken: string; attempt: number };
      expect(receipt.delivery).toBe('not_received');
      expect(await repository.find(job.id)).toMatchObject({
        state: 'partial',
        nonceHash: null,
        leaseUntil: null,
        reason: 'builtin_task_not_received'
      });
      await expect(
        events.event(job.id, launch.agentToken, {
          type: 'registered',
          attempt: launch.attempt,
          email
        })
      ).rejects.toThrow('授权');
      worker.delivery = 'unknown';
      expect(await jobs.cancel(job.id, operator)).toMatchObject({ delivery: 'unknown' });
      expect((await repository.find(job.id))?.state).toBe('cancelled');
      await prisma.idBusinessV2RegistrationJob.update({
        where: { id: job.id },
        data: {
          state: 'running',
          reason: null,
          browserProfileId: 'reg_' + 'd'.repeat(64),
          nonceHash: registrationTokenHash('d'.repeat(64)),
          leaseUntil: new Date(Date.now() + 60_000)
        }
      });
      expect(await jobs.cancel(job.id, operator)).toMatchObject({ delivery: 'unknown' });
      expect(await repository.find(job.id)).toMatchObject({
        state: 'partial',
        reason: 'builtin_cancel_unconfirmed',
        nonceHash: null,
        leaseUntil: null
      });
      await expect(jobs.resume(job.id, operator)).rejects.toThrow('重试关闭');
      await expect(jobs.launch(job.id, operator)).rejects.toThrow('重试关闭');
      worker.delivery = 'accepted';
      expect(await jobs.cancel(job.id, operator)).toMatchObject({ delivery: 'accepted' });
      expect(await repository.find(job.id)).toMatchObject({ state: 'cancelled', reason: null });
    } finally {
      worker.delivery = 'accepted';
    }
  });
  it('人工标记可双向修改、资料保持不变；并发旧版本仅成功一次，审计失败回滚', async () => {
    const result = await mailboxes.markRegistered(
      'correction',
      { expectedUpdatedAt: aliasVersion, registered: true, expectedAccountUpdatedAt: null },
      operator
    );
    const accountId = result.accountId!;
    const original = await prisma.idBusinessV2ChatgptAccount.update({
      where: { id: accountId },
      data: {
        passwordEncrypted: encryption.encrypt('synthetic-old-password')!,
        totpSecretEncrypted: encryption.encrypt('JBSWY3DPEHPK3PXP')!,
        remark: '保留账号资料',
        status: 'disabled'
      }
    });
    const change = {
      expectedUpdatedAt: aliasVersion,
      registered: false,
      expectedAccountUpdatedAt: original.updatedAt.toISOString()
    };
    const outcomes = await Promise.allSettled([
      mailboxes.markRegistered('correction', change, operator),
      mailboxes.markRegistered('correction', change, operator)
    ]);
    expect(outcomes.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((value) => value.status === 'rejected')).toHaveLength(1);
    const corrected = await prisma.idBusinessV2ChatgptAccount.findUniqueOrThrow({
      where: { id: accountId }
    });
    expect(corrected).toMatchObject({
      registered: false,
      passwordEncrypted: original.passwordEncrypted,
      totpSecretEncrypted: original.totpSecretEncrypted,
      remark: original.remark,
      status: 'disabled'
    });
    expect(
      await prisma.idBusinessV2ChatgptAccount.count({ where: { emailHash: original.emailHash } })
    ).toBe(1);
    await mailboxes.markRegistered(
      'correction',
      { ...change, registered: true, expectedAccountUpdatedAt: corrected.updatedAt.toISOString() },
      operator
    );
    const restored = await prisma.idBusinessV2ChatgptAccount.findUniqueOrThrow({
      where: { id: accountId }
    });
    expect(restored.registered).toBe(true);
    const failedAudit = new V2TransactionalAuditService();
    vi.spyOn(failedAudit, 'append').mockRejectedValue(new Error('合成审计失败'));
    const failService = new RegistrationMailboxesService(
      repository,
      mailbox as never,
      new V2CommandTransactionManager(prisma),
      failedAudit,
      encryption
    );
    await expect(
      failService.markRegistered(
        'correction',
        { ...change, expectedAccountUpdatedAt: restored.updatedAt.toISOString() },
        operator
      )
    ).rejects.toThrow('合成审计失败');
    expect(
      (await prisma.idBusinessV2ChatgptAccount.findUniqueOrThrow({ where: { id: accountId } }))
        .registered
    ).toBe(true);
    const audits = await prisma.auditLog.findMany({
      where: { objectId: accountId, action: { endsWith: 'mark_unregistered' } }
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.beforeData).toEqual({ registered: true });
    expect(audits[0]!.afterData).toMatchObject({ registered: false });
    expect(JSON.stringify(audits)).not.toContain(correctionEmail);
    expect(JSON.stringify(audits)).not.toContain('synthetic-old-password');
  });

  it('误标后重新注册复用原账号，官方核实后恢复状态；重复回执不覆盖人工密码', async () => {
    const original = await prisma.idBusinessV2ChatgptAccount.findUniqueOrThrow({
      where: { emailHash: encryption.hash(correctionEmail)! }
    });
    await mailboxes.markRegistered(
      'correction',
      {
        expectedUpdatedAt: aliasVersion,
        registered: false,
        expectedAccountUpdatedAt: original.updatedAt.toISOString()
      },
      operator
    );
    const job = await jobs.create(
      { mailboxAliasId: 'correction', proxyId, birthDate: '1996-01-01', confirmIdentity: true },
      operator
    );
    expect(job.accountId).toBe(original.id);
    const token = randomBytes(32).toString('hex');
    await prisma.idBusinessV2RegistrationJob.update({
      where: { id: job.id },
      data: {
        attempt: 1,
        nonceHash: registrationTokenHash(token),
        leaseUntil: new Date(Date.now() + 60_000)
      }
    });
    const emit = (type: string, extra: object = {}) =>
      events.event(job.id, token, { type, attempt: 1, ...extra });
    const during = await prisma.idBusinessV2ChatgptAccount.findUniqueOrThrow({
      where: { id: original.id }
    });
    await expect(
      mailboxes.markRegistered(
        'correction',
        {
          expectedUpdatedAt: aliasVersion,
          registered: true,
          expectedAccountUpdatedAt: during.updatedAt.toISOString()
        },
        operator
      )
    ).rejects.toThrow('结束或取消');
    await emit('registered', { email: correctionEmail, registrationCountryCode: 'PH' });
    const confirmed = await prisma.idBusinessV2ChatgptAccount.findUniqueOrThrow({
      where: { id: original.id }
    });
    expect(confirmed).toMatchObject({
      registered: true,
      passwordEncrypted: original.passwordEncrypted,
      remark: original.remark,
      status: original.status
    });
    await emit('password_verified');
    const verified = (await repository.find(job.id))!;
    expect(
      (await prisma.idBusinessV2ChatgptAccount.findUniqueOrThrow({ where: { id: original.id } }))
        .passwordEncrypted
    ).toBe(verified.passwordEncrypted);
    const manualPassword = encryption.encrypt('synthetic-new-manual-password')!;
    await prisma.idBusinessV2ChatgptAccount.update({
      where: { id: original.id },
      data: { passwordEncrypted: manualPassword }
    });
    await emit('password_verified');
    expect(
      (await prisma.idBusinessV2ChatgptAccount.findUniqueOrThrow({ where: { id: original.id } }))
        .passwordEncrypted
    ).toBe(manualPassword);
    await emit('totp_pending', { totpSecret: 'JBSWY3DPEHPK3PXP', step: 'mfa' });
    await emit('mfa_verified');
    const manualTotp = encryption.encrypt('synthetic-new-manual-totp')!;
    await prisma.idBusinessV2ChatgptAccount.update({
      where: { id: original.id },
      data: { totpSecretEncrypted: manualTotp }
    });
    await emit('mfa_verified');
    expect(
      (await prisma.idBusinessV2ChatgptAccount.findUniqueOrThrow({ where: { id: original.id } }))
        .totpSecretEncrypted
    ).toBe(manualTotp);
    await emit('complete');
    await expect(
      jobs.create(
        { mailboxAliasId: 'correction', proxyId, birthDate: '1996-01-01', confirmIdentity: true },
        operator
      )
    ).rejects.toThrow('已有账号');
    const complete = await prisma.idBusinessV2ChatgptAccount.findUniqueOrThrow({
      where: { id: original.id }
    });
    await mailboxes.markRegistered(
      'correction',
      {
        expectedUpdatedAt: aliasVersion,
        registered: false,
        expectedAccountUpdatedAt: complete.updatedAt.toISOString()
      },
      operator
    );
    await expect(emit('registered', { email: correctionEmail })).rejects.toThrow('授权');
    const newJob = await jobs.create(
      { mailboxAliasId: 'correction', proxyId, birthDate: '1996-01-01', confirmIdentity: true },
      operator
    );
    expect(newJob.accountId).toBe(original.id);
    expect(
      await prisma.idBusinessV2ChatgptAccount.count({ where: { emailHash: original.emailHash } })
    ).toBe(1);
    await jobs.cancel(newJob.id, operator);
  });

  it('完整20至45轮换在重启后继续，事务失败不消耗年龄，历史任务不参与计数', async () => {
    const assignedBefore = await prisma.idBusinessV2RegistrationJob.count({
      where: { registrationAge: { not: null } }
    });
    const ages: number[] = [];
    const input = (index: number) => ({
      mailboxAliasId: `age-cycle-${index}`,
      proxyId,
      birthDate: '1996-01-01',
      confirmIdentity: true
    });
    for (let index = 0; index < 27; index += 1) {
      if (index === 13) restart();
      if (index === 8) {
        const audit = new V2TransactionalAuditService();
        vi.spyOn(audit, 'append').mockRejectedValueOnce(new Error('synthetic audit failure'));
        const failing = new RegistrationJobsService(
          repository,
          new V2CommandTransactionManager(prisma),
          audit,
          encryption,
          mailbox as never,
          settings as never,
          proxies as never
        );
        await expect(failing.create(input(index), operator)).rejects.toThrow(
          'synthetic audit failure'
        );
        expect(
          await prisma.idBusinessV2RegistrationJob.count({
            where: { registrationAge: { not: null } }
          })
        ).toBe(assignedBefore + index);
      }
      const job = await jobs.create(input(index), operator);
      const expectedAge = 20 + ((assignedBefore + index) % 26);
      expect(job.registrationAge).toBe(expectedAge);
      expect((await repository.find(job.id))!.registrationAge).toBe(expectedAge);
      ages.push(job.registrationAge!);
      await expect(jobs.create(input(index), operator)).rejects.toThrow('已有注册任务');
      await jobs.cancel(job.id, operator);
    }
    expect(new Set(ages.slice(0, 26)).size).toBe(26);
    expect(ages[26]).toBe(ages[0]);
    expect(ages).toContain(45);
    const wrap = ages.indexOf(45);
    expect(ages[wrap + 1]).toBe(20);
    const stored = await prisma.idBusinessV2RegistrationJob.findFirstOrThrow({
      where: { mailboxAliasId: 'age-cycle-0' }
    });
    await expect(
      prisma.idBusinessV2RegistrationJob.update({
        where: { id: stored.id },
        data: { registrationAge: 19 }
      })
    ).rejects.toThrow();
    expect((await repository.find(stored.id))!.registrationAge).toBe(ages[0]);
  });
});
