import {
  ConflictException,
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IdBusinessV2RegistrationJob } from '@prisma/client';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { getPagination } from '../../common/pagination';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  type V2CommandTransaction
} from '../runtime/public-api';
import { RechargeProxyService, RechargeSettingsService } from '../auto-recharge/public-api';
import { IdBusinessV2VendureMailboxService } from '../workspace/public-api';
import { RegistrationRepository } from './persistence/registration.repository';
import { registrationWorkerCommand, requireRegistrationWorker } from './registration-worker';
import { id, record, startInput, text } from './registration-validation';

export function registrationSummary(row: IdBusinessV2RegistrationJob) {
  return {
    id: row.id,
    emailMasked: row.emailMasked,
    displayName: row.displayName,
    registrationAge: row.registrationAge ?? null,
    state:
      row.nonceHash &&
      row.leaseUntil &&
      row.leaseUntil <= new Date() &&
      !['completed', 'cancelled'].includes(row.state)
        ? ('partial' as const)
        : row.state,
    step: row.step,
    registered: row.registered,
    passwordVerified: row.passwordVerified,
    mfaVerified: row.mfaVerified,
    offerStatus: row.offerStatus,
    reason: row.reason,
    browserProfileId: row.browserProfileId,
    accountId: row.accountId,
    attempt: row.attempt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}
export const registrationTokenHash = (token: string) =>
  createHash('sha256').update(token).digest('hex');

@Injectable()
export class RegistrationJobsService {
  constructor(
    private readonly repository: RegistrationRepository,
    private readonly transactions: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService,
    private readonly encryption: FieldEncryptionService,
    private readonly mailboxes: IdBusinessV2VendureMailboxService,
    private readonly settings: RechargeSettingsService,
    private readonly proxies: RechargeProxyService
  ) {}
  async list(
    query: { page?: string; pageSize?: string; keyword?: string },
    operator: AuthenticatedUser
  ) {
    const p = getPagination(query);
    const where = {
      ownerId: operator.id,
      ...(query.keyword ? { emailMasked: { contains: text(query.keyword, '搜索内容', 250) } } : {})
    };
    const [items, total] = await Promise.all([
      this.repository.jobs(where, p.skip, p.take),
      this.repository.countJobs(where)
    ]);
    return { items: items.map(registrationSummary), total, page: p.page, pageSize: p.pageSize };
  }
  async pending(mailboxAliasId: unknown, operator: AuthenticatedUser) {
    const mailbox = await this.mailboxes.aliasAddress(
      text(mailboxAliasId, '邮箱编号', 191),
      operator
    );
    const emailHash = this.encryption.hash(mailbox.email.toLowerCase())!;
    const [job] = await this.repository.jobs(
      { ownerId: operator.id, emailHash, state: { notIn: ['completed', 'cancelled'] } },
      0,
      1
    );
    return job ? registrationSummary(job) : null;
  }
  async options(
    query: {
      q?: string;
      page?: string;
      proxySearch?: string;
      proxyPage?: string;
      nameSearch?: string;
      namePage?: string;
    },
    operator: AuthenticatedUser
  ) {
    const mailboxPage = getPagination({ page: query.page, pageSize: '100' });
    const proxyPage = getPagination({ page: query.proxyPage ?? query.page, pageSize: '100' });
    const namePage = getPagination({ page: query.namePage ?? query.page, pageSize: '100' });
    const proxySearch = query.proxySearch ?? query.q;
    const nameSearch = query.nameSearch ?? query.q;
    const nameWhere = {
      active: true,
      ...(nameSearch ? { displayName: { contains: text(nameSearch, '名字搜索', 120) } } : {})
    };
    const [mailboxes, proxies, names, nameTotal, defaults] = await Promise.all([
      this.mailboxes.registrationMailboxSummaries(operator),
      this.proxies.list({
        page: String(proxyPage.page),
        pageSize: String(proxyPage.pageSize),
        keyword: proxySearch,
        status: 'active'
      }),
      this.repository.names(nameWhere, namePage.skip, namePage.take),
      this.repository.countNames(nameWhere),
      this.settings.getServerProxySettings(operator)
    ]);
    const hashes = mailboxes.map((item) => this.encryption.hash(item.email.toLowerCase())!);
    const [accounts, pendingJobs] = await Promise.all([
      this.repository.accountsByEmailHashes(hashes),
      this.repository.unfinishedJobsByEmailHashes(hashes)
    ]);
    const registered = new Set(
      accounts.filter((item) => item.registered).map((item) => item.emailHash)
    );
    const pendingEmails = new Set(pendingJobs.map((item) => item.emailHash));
    const mailboxSearch = query.q ? text(query.q, '邮箱搜索', 250).toLowerCase() : '';
    const candidates = mailboxes.filter(
      (item, index) =>
        item.status === 'ACTIVE' &&
        item.authorizationValid &&
        item.primaryAvailable &&
        !registered.has(hashes[index]!) &&
        !pendingEmails.has(hashes[index]!) &&
        (!mailboxSearch || item.email.toLowerCase().includes(mailboxSearch))
    );
    return {
      mailboxes: candidates
        .slice(mailboxPage.skip, mailboxPage.skip + mailboxPage.take)
        .map((item) => ({ id: item.id, email: item.email })),
      proxies: proxies.items.map((item) => ({
        id: item.id,
        countryCode: item.countryCode,
        label: `${item.countryCode} · ${item.linkMask}`
      })),
      names: names.map((item) => ({ id: item.id, displayName: item.displayName })),
      defaultProxyId: defaults.proxy?.status === 'active' ? defaults.proxyId : null,
      mailboxTotal: candidates.length,
      proxyTotal: proxies.total,
      nameTotal
    };
  }
  async execution(operator: AuthenticatedUser) {
    const defaults = await this.settings.getServerProxySettings(operator);
    return {
      engine: 'camoufox' as const,
      proxyId: defaults.proxy?.status === 'active' ? defaults.proxyId : null
    };
  }
  async authorized(jobId: string, token: unknown, attempt: unknown) {
    id(jobId);
    if (typeof token !== 'string' || !/^[a-f\d]{64}$/.test(token))
      throw new ForbiddenException('任务授权无效');
    const row = await this.repository.find(jobId);
    if (
      !row?.nonceHash ||
      !row.leaseUntil ||
      row.leaseUntil <= new Date() ||
      row.attempt !== attempt ||
      ['completed', 'cancelled'].includes(row.state) ||
      !timingSafeEqual(
        Buffer.from(row.nonceHash, 'hex'),
        Buffer.from(registrationTokenHash(token), 'hex')
      )
    )
      throw new ForbiddenException('任务授权已失效');
    return row;
  }
  async owned(jobId: string, operator: AuthenticatedUser) {
    id(jobId);
    const job = await this.repository.find(jobId);
    if (!job || job.ownerId !== operator.id) throw new NotFoundException('注册任务不存在');
    return job;
  }
  async get(jobId: string, operator: AuthenticatedUser) {
    return registrationSummary(await this.owned(jobId, operator));
  }
  async create(value: unknown, operator: AuthenticatedUser) {
    const input = startInput(value);
    const mailbox = await this.mailboxes.registrationMailbox(input.mailboxAliasId, operator);
    await this.proxies.forCharge(input.proxyId, operator);
    await requireRegistrationWorker(true);
    const emailHash = this.encryption.hash(mailbox.email.toLowerCase())!;
    return this.transactions.execute(
      async (tx) => {
        await this.repository.lock(tx);
        if (await this.repository.active(tx))
          throw new ConflictException('已有注册任务执行中，请处理原任务');
        const account = await this.repository.account(tx, emailHash);
        if (account?.registered)
          throw new ConflictException('该邮箱已经保存为 ChatGPT 账号，请使用已有账号');
        if (await this.repository.pendingEmail(tx, emailHash))
          throw new ConflictException('该邮箱已有注册记录，请继续原任务');
        const name = await this.repository.name(tx, input.nameId);
        if (!name) throw new ConflictException('请先录入并启用可用名字');
        const registrationAge = input.age;
        const email = mailbox.email.toLowerCase();
        const [local, domain] = email.split('@');
        const job = await this.repository.create(tx, {
          ownerId: operator.id,
          mailboxAliasId: input.mailboxAliasId,
          proxyId: input.proxyId,
          nameId: name.id,
          displayName: name.displayName,
          emailHash,
          accountId: account?.id ?? null,
          emailEncrypted: this.encryption.encrypt(email)!,
          emailMasked: `${local.slice(0, 2)}***@${domain}`,
          birthDateEncrypted: this.encryption.encrypt(input.birthDate)!,
          registrationAge,
          passwordEncrypted: this.encryption.encrypt(
            `G!${randomBytes(24).toString('base64url')}a9`
          )!,
          leaseUntil: new Date(Date.now() + 45 * 60_000)
        });
        await this.repository.useName(tx, name.id);
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.auto_registration.create',
          objectType: 'registration_job',
          objectId: job.id,
          afterData: {
            emailMasked: job.emailMasked,
            nameId: name.id,
            proxyId: input.proxyId,
            registrationAge
          }
        });
        return registrationSummary(job);
      },
      { changedScopes: ['auto-recharge'], operator, requestId: randomUUID(), retryMode: 'none' }
    );
  }
  async launch(jobId: string, operator: AuthenticatedUser) {
    const original = await this.owned(jobId, operator);
    if (original.reason === 'builtin_cancel_unconfirmed')
      throw new ConflictException('原窗口关闭尚未确认，请重试关闭后再启动任务');
    if (['completed', 'cancelled'].includes(original.state))
      throw new ConflictException('该任务已经结束');
    const mailboxHash = await this.currentMailboxHash(original.mailboxAliasId, operator);
    const proxy = await this.proxies.forCharge(original.proxyId, operator);
    if (original.browserProfileId && !original.browserProfileId.startsWith('reg_'))
      throw new ConflictException(
        '旧任务使用比特窗口，不能转成新窗口重复注册；请核对账号并结束旧任务'
      );
    await requireRegistrationWorker();
    const agentToken = randomBytes(32).toString('hex');
    const job = await this.transactions.execute(
      async (tx) => {
        await this.repository.lock(tx);
        const row = await this.repository.findInTransaction(tx, jobId);
        if (!row || row.ownerId !== operator.id) throw new ForbiddenException('注册任务不可用');
        if (row.reason === 'builtin_cancel_unconfirmed')
          throw new ConflictException('原窗口关闭尚未确认，请重试关闭后再启动任务');
        if (['completed', 'cancelled'].includes(row.state))
          throw new ConflictException('该任务已经结束');
        if (
          row.nonceHash &&
          row.leaseUntil &&
          row.leaseUntil > new Date() &&
          row.state !== 'partial'
        )
          throw new ConflictException('原任务仍有效，请在原窗口继续或取消');
        if (await this.repository.active(tx, row.id))
          throw new ConflictException('已有其他注册任务执行中');
        this.checkMailboxHash(row, mailboxHash);
        await this.checkAccountRegistration(tx, row);
        const next = await this.repository.update(tx, row.id, {
          state: 'running',
          attempt: { increment: 1 },
          nonceHash: registrationTokenHash(agentToken),
          leaseUntil: new Date(Date.now() + 45 * 60_000),
          reason: null
        });
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.auto_registration.launch',
          objectType: 'registration_job',
          objectId: row.id,
          afterData: { attempt: next.attempt }
        });
        return next;
      },
      { changedScopes: ['auto-recharge'], operator, requestId: randomUUID(), retryMode: 'none' }
    );
    const dispatch = await registrationWorkerCommand(job.id, job.attempt, 'launch', {
      id: job.id,
      mode: 'registration',
      attempt: job.attempt,
      agentToken,
      email: this.encryption.decrypt(job.emailEncrypted),
      password: this.encryption.decrypt(job.passwordEncrypted),
      displayName: job.displayName,
      birthDate: this.encryption.decrypt(job.birthDateEncrypted),
      ...(job.registrationAge != null ? { registrationAge: job.registrationAge } : {}),
      totpSecret: this.encryption.decrypt(job.pendingTotpEncrypted),
      browserProfileId: job.browserProfileId,
      step: job.step,
      registered: job.registered,
      passwordVerified: job.passwordVerified,
      mfaVerified: job.mfaVerified,
      proxy,
      expectedCountry: proxy.countryCode
    });
    if (['not_received', 'rejected'].includes(dispatch.delivery)) {
      await this.transactions.execute(
        async (tx) => {
          await this.repository.lock(tx);
          const current = await this.repository.findInTransaction(tx, job.id);
          if (
            current?.nonceHash === registrationTokenHash(agentToken) &&
            current.attempt === job.attempt
          ) {
            await this.repository.update(tx, job.id, {
              state: 'partial',
              nonceHash: null,
              leaseUntil: null,
              reason: dispatch.reason ?? 'builtin_task_not_received'
            });
            await this.audit.append(tx, {
              userId: operator.id,
              module: 'id_business_v2',
              action:
                dispatch.delivery === 'rejected'
                  ? 'id_business_v2.auto_registration.launch_rejected'
                  : 'id_business_v2.auto_registration.launch_not_received',
              objectType: 'registration_job',
              objectId: job.id,
              afterData: {
                attempt: job.attempt,
                ...(dispatch.reason ? { reason: dispatch.reason } : {})
              }
            });
          }
        },
        { changedScopes: ['auto-recharge'], operator, requestId: randomUUID(), retryMode: 'none' }
      );
    }
    return { id: job.id, attempt: job.attempt, ...dispatch };
  }
  async code(jobId: string, operator: AuthenticatedUser) {
    const row = await this.owned(jobId, operator);
    if (
      row.state !== 'awaiting_email' ||
      !row.codeRequestedAt ||
      !row.leaseUntil ||
      row.leaseUntil <= new Date()
    )
      throw new ConflictException('任务当前未等待邮件验证码');
    this.checkMailboxHash(row, await this.currentMailboxHash(row.mailboxAliasId, operator));
    const code = await this.mailboxes.registrationCode(
      row.mailboxAliasId,
      row.codeRequestedAt,
      row.lastMailId,
      operator,
      this.encryption.decrypt(row.emailEncrypted)!
    );
    if (!code) return { code: null };
    return this.transactions.execute(
      async (tx) => {
        await this.repository.lock(tx);
        const current = await this.repository.findInTransaction(tx, row.id);
        if (
          !current ||
          current.ownerId !== operator.id ||
          current.nonceHash !== row.nonceHash ||
          current.attempt !== row.attempt ||
          !current.leaseUntil ||
          current.leaseUntil <= new Date() ||
          current.state !== 'awaiting_email' ||
          current.codeRequestedAt?.getTime() !== row.codeRequestedAt?.getTime() ||
          current.lastMailId === code.mailId
        )
          throw new ConflictException('验证码步骤已变化，请重新核对');
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.auto_registration.code_read',
          objectType: 'registration_job',
          objectId: row.id,
          afterData: { step: row.step }
        });
        return { code: code.code, mailId: code.mailId, attempt: row.attempt, step: row.step };
      },
      { changedScopes: ['audit-logs'], operator, requestId: randomUUID(), retryMode: 'none' }
    );
  }
  async cancel(jobId: string, operator: AuthenticatedUser) {
    await this.owned(jobId, operator);
    const result = await this.transactions.execute(
      async (tx) => {
        await this.repository.lock(tx);
        const job = await this.repository.findInTransaction(tx, jobId);
        if (!job || job.ownerId !== operator.id || job.state === 'completed')
          throw new ConflictException('该任务不能取消');
        const windowMayExist =
          job.attempt > 0 &&
          job.reason !== 'builtin_task_not_received' &&
          (!job.browserProfileId || job.browserProfileId.startsWith('reg_'));
        const updated = await this.repository.update(tx, jobId, {
          state: windowMayExist ? 'partial' : 'cancelled',
          nonceHash: null,
          leaseUntil: null,
          ...(windowMayExist ? { reason: 'builtin_cancel_unconfirmed' } : {}),
          updatedAt: new Date(Math.max(Date.now(), job.updatedAt.getTime() + 1))
        });
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.auto_registration.cancel',
          objectType: 'registration_job',
          objectId: jobId,
          afterData: { registered: job.registered, closeConfirmed: !windowMayExist }
        });
        return { windowMayExist, version: updated.updatedAt, attempt: job.attempt };
      },
      { changedScopes: ['auto-recharge'], operator, requestId: randomUUID(), retryMode: 'none' }
    );
    const dispatch = await registrationWorkerCommand(jobId, result.attempt, 'cancel', {
      attempt: result.attempt
    });
    if (result.windowMayExist && ['accepted', 'not_received'].includes(dispatch.delivery)) {
      await this.transactions.execute(
        async (tx) => {
          await this.repository.lock(tx);
          const current = await this.repository.findInTransaction(tx, jobId);
          if (
            !current ||
            current.ownerId !== operator.id ||
            current.attempt !== result.attempt ||
            current.state !== 'partial' ||
            current.reason !== 'builtin_cancel_unconfirmed' ||
            current.updatedAt.getTime() !== result.version.getTime()
          )
            return;
          await this.repository.update(tx, jobId, { state: 'cancelled', reason: null });
          await this.audit.append(tx, {
            userId: operator.id,
            module: 'id_business_v2',
            action: 'id_business_v2.auto_registration.cancel',
            objectType: 'registration_job',
            objectId: jobId,
            afterData: { closeConfirmed: true }
          });
        },
        { changedScopes: ['auto-recharge'], operator, requestId: randomUUID(), retryMode: 'none' }
      );
    }
    return { id: jobId, attempt: result.attempt, ...dispatch };
  }

  private async checkAccountRegistration(
    tx: V2CommandTransaction,
    job: IdBusinessV2RegistrationJob
  ) {
    const account = await this.repository.account(tx, job.emailHash);
    if (
      (account?.id ?? null) !== job.accountId ||
      (account?.registered ?? false) !== job.registered
    )
      throw new ConflictException('邮箱注册状态或关联账号已变化，请核对并取消原任务');
    return account;
  }

  private async currentMailboxHash(aliasId: string, operator: AuthenticatedUser) {
    const mailbox = await this.mailboxes.registrationMailbox(aliasId, operator);
    return this.encryption.hash(mailbox.email.toLowerCase())!;
  }

  private checkMailboxHash(job: IdBusinessV2RegistrationJob, mailboxHash: string) {
    if (job.emailHash !== mailboxHash)
      throw new ConflictException('原邮箱地址已变化，请核对并取消原任务');
  }

  private async resumeCredentials(jobId: string, operator: AuthenticatedUser, mailboxHash: string) {
    await this.owned(jobId, operator);
    return this.transactions.execute(
      async (tx) => {
        await this.repository.lock(tx);
        const job = await this.repository.findInTransaction(tx, jobId);
        if (
          !job ||
          job.ownerId !== operator.id ||
          ['completed', 'cancelled'].includes(job.state) ||
          job.reason === 'builtin_cancel_unconfirmed' ||
          (!['awaiting_user', 'partial'].includes(job.state) &&
            !(job.leaseUntil && job.leaseUntil <= new Date()))
        )
          throw new ConflictException('当前任务不能补录安全资料');
        this.checkMailboxHash(job, mailboxHash);
        const account = await this.checkAccountRegistration(tx, job);
        if (
          account?.totpSecretEncrypted &&
          (account.totpAlgorithm !== 'sha1' ||
            account.totpDigits !== 6 ||
            account.totpPeriod !== 30)
        )
          throw new ConflictException('请使用标准六位验证器配置');
        const passwordEncrypted = account?.passwordEncrypted ?? job.passwordEncrypted;
        const pendingTotpEncrypted =
          !job.mfaVerified && account?.totpSecretEncrypted
            ? account.totpSecretEncrypted
            : job.pendingTotpEncrypted;
        await this.repository.update(tx, jobId, { passwordEncrypted, pendingTotpEncrypted });
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.auto_registration.resume_credentials',
          objectType: 'registration_job',
          objectId: jobId
        });
        return {
          attempt: job.attempt,
          password: this.encryption.decrypt(passwordEncrypted),
          totpSecret: this.encryption.decrypt(pendingTotpEncrypted)
        };
      },
      { changedScopes: ['audit-logs'], operator, requestId: randomUUID(), retryMode: 'none' }
    );
  }
  async resume(jobId: string, operator: AuthenticatedUser) {
    const row = await this.owned(jobId, operator);
    if (row.reason === 'builtin_cancel_unconfirmed')
      throw new ConflictException('原窗口关闭尚未确认，请重试关闭后再启动任务');
    const mailboxHash = await this.currentMailboxHash(row.mailboxAliasId, operator);
    const credentials = await this.resumeCredentials(jobId, operator, mailboxHash);
    if (row.state === 'partial' || (row.leaseUntil && row.leaseUntil <= new Date()))
      return this.launch(jobId, operator);
    const dispatch = await registrationWorkerCommand(
      jobId,
      credentials.attempt,
      'resume',
      credentials
    );
    return { id: jobId, attempt: credentials.attempt, ...dispatch };
  }
  async submitCode(jobId: string, value: unknown, operator: AuthenticatedUser) {
    const input = record(value);
    if (Object.keys(input).some((key) => !['code', 'attempt', 'step'].includes(key)))
      throw new BadRequestException('验证码包含未知字段');
    const row = await this.owned(jobId, operator);
    const code = text(input.code, '验证码', 8);
    if (
      !/^\d{6,8}$/.test(code) ||
      row.state !== 'awaiting_email' ||
      row.attempt !== input.attempt ||
      row.step !== input.step ||
      !row.leaseUntil ||
      row.leaseUntil <= new Date()
    )
      throw new ConflictException('验证码或任务步骤已变化');
    this.checkMailboxHash(row, await this.currentMailboxHash(row.mailboxAliasId, operator));
    const dispatch = await registrationWorkerCommand(jobId, row.attempt, 'code', {
      code,
      attempt: row.attempt,
      step: row.step
    });
    return { id: jobId, attempt: row.attempt, ...dispatch };
  }
}
