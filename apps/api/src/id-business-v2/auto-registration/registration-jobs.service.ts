import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { IdBusinessV2RegistrationJob } from '@prisma/client';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { getPagination } from '../../common/pagination';
import { V2CommandTransactionManager, V2TransactionalAuditService } from '../runtime/public-api';
import { RechargeProxyService, RechargeSettingsService } from '../auto-recharge/public-api';
import { IdBusinessV2VendureMailboxService } from '../workspace/public-api';
import { RegistrationRepository } from './persistence/registration.repository';
import { id, startInput, text } from './registration-validation';

export function registrationSummary(row: IdBusinessV2RegistrationJob) {
  return {
    id: row.id,
    emailMasked: row.emailMasked,
    displayName: row.displayName,
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
  async options(query: { q?: string; page?: string }, operator: AuthenticatedUser) {
    const p = getPagination({ page: query.page, pageSize: '100' });
    const [mailboxes, proxies, names] = await Promise.all([
      this.mailboxes.listAliases(
        { page: p.page, pageSize: p.pageSize, q: query.q, status: 'ACTIVE' },
        operator
      ),
      this.proxies.list({
        page: String(p.page),
        pageSize: String(p.pageSize),
        keyword: query.q,
        status: 'active'
      }),
      this.repository.names(
        { active: true, ...(query.q ? { displayName: { contains: query.q } } : {}) },
        p.skip,
        p.take
      )
    ]);
    return {
      mailboxes: mailboxes.items.map((item) => ({ id: item.id, email: item.aliasEmail })),
      proxies: proxies.items.map((item) => ({
        id: item.id,
        countryCode: item.countryCode,
        label: `${item.countryCode} · ${item.linkMask}`
      })),
      names: names.map((item) => ({ id: item.id, displayName: item.displayName })),
      mailboxTotal: mailboxes.total,
      proxyTotal: proxies.total
    };
  }
  async connection(operator: AuthenticatedUser) {
    const runtime = await this.settings.runtime(operator.id, true);
    await this.transactions.execute(
      async (tx) => {
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.auto_registration.connector_access',
          objectType: 'registration_connector'
        });
      },
      { changedScopes: ['audit-logs'], operator, requestId: randomUUID(), retryMode: 'none' }
    );
    return { connectorUrl: runtime.connectorUrl, connectorToken: runtime.connectorToken };
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
    await this.settings.runtime(operator.id, true);
    const emailHash = this.encryption.hash(mailbox.email.toLowerCase())!;
    return this.transactions.execute(
      async (tx) => {
        await this.repository.lock(tx);
        if (await this.repository.active(tx))
          throw new ConflictException('已有注册任务执行中，请处理原任务');
        if (await this.repository.account(tx, emailHash))
          throw new ConflictException('该邮箱已经保存为 ChatGPT 账号，请使用已有账号');
        if (await this.repository.pendingEmail(tx, emailHash))
          throw new ConflictException('该邮箱已有注册记录，请继续原任务');
        const name = await this.repository.name(tx, input.nameId);
        if (!name) throw new ConflictException('请先录入并启用可用名字');
        const email = mailbox.email.toLowerCase();
        const [local, domain] = email.split('@');
        const job = await this.repository.create(tx, {
          ownerId: operator.id,
          mailboxAliasId: input.mailboxAliasId,
          proxyId: input.proxyId,
          nameId: name.id,
          displayName: name.displayName,
          emailHash,
          emailEncrypted: this.encryption.encrypt(email)!,
          emailMasked: `${local.slice(0, 2)}***@${domain}`,
          birthDateEncrypted: this.encryption.encrypt(input.birthDate)!,
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
          afterData: { emailMasked: job.emailMasked, nameId: name.id, proxyId: input.proxyId }
        });
        return registrationSummary(job);
      },
      { changedScopes: ['auto-recharge'], operator, requestId: randomUUID(), retryMode: 'none' }
    );
  }
  async launch(jobId: string, operator: AuthenticatedUser) {
    const original = await this.owned(jobId, operator);
    if (['completed', 'cancelled'].includes(original.state))
      throw new ConflictException('该任务已经结束');
    await this.mailboxes.registrationMailbox(original.mailboxAliasId, operator);
    const proxy = await this.proxies.forCharge(original.proxyId, operator);
    const runtime = await this.settings.runtime(operator.id, true);
    const agentToken = randomBytes(32).toString('hex');
    const job = await this.transactions.execute(
      async (tx) => {
        await this.repository.lock(tx);
        const row = await this.repository.findInTransaction(tx, jobId);
        if (!row || row.ownerId !== operator.id) throw new ForbiddenException('注册任务不可用');
        if (
          ['completed', 'cancelled'].includes(row.state) ||
          (row.nonceHash &&
            row.leaseUntil &&
            row.leaseUntil > new Date() &&
            row.state !== 'partial')
        )
          throw new ConflictException('原任务仍有效，请在原窗口继续或取消');
        if (await this.repository.active(tx, row.id))
          throw new ConflictException('已有其他注册任务执行中');
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
    return {
      id: job.id,
      mode: 'registration',
      attempt: job.attempt,
      agentToken,
      connectorUrl: runtime.connectorUrl,
      connectorToken: runtime.connectorToken,
      email: this.encryption.decrypt(job.emailEncrypted),
      password: this.encryption.decrypt(job.passwordEncrypted),
      displayName: job.displayName,
      birthDate: this.encryption.decrypt(job.birthDateEncrypted),
      totpSecret: this.encryption.decrypt(job.pendingTotpEncrypted),
      browserProfileId: job.browserProfileId,
      step: job.step,
      registered: job.registered,
      passwordVerified: job.passwordVerified,
      mfaVerified: job.mfaVerified,
      bitBrowser: {
        localApiUrl: runtime.localApiUrl,
        localApiToken: runtime.localApiToken,
        groupName: runtime.groupName,
        tagName: runtime.tagName,
        proxyType: proxy.type,
        dynamicProxyUrl: proxy.mode === 'dynamic' ? proxy.extractionUrl : '',
        browserOptions: {
          ...runtime.browserOptions,
          proxyMode: proxy.mode,
          staticHost: proxy.mode === 'static' ? proxy.host : '',
          staticPort: proxy.mode === 'static' ? proxy.port : 8080,
          dynamicProvider: 'common',
          refreshIp: true
        },
        staticProxyCredentials:
          proxy.mode === 'static' && proxy.username
            ? { username: proxy.username, password: proxy.password }
            : undefined
      }
    };
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
    const code = await this.mailboxes.registrationCode(
      row.mailboxAliasId,
      row.codeRequestedAt,
      row.lastMailId,
      operator
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
    return this.transactions.execute(
      async (tx) => {
        await this.repository.lock(tx);
        const job = await this.repository.findInTransaction(tx, jobId);
        if (!job || job.ownerId !== operator.id || job.state === 'completed')
          throw new ConflictException('该任务不能取消');
        await this.repository.update(tx, jobId, {
          state: 'cancelled',
          nonceHash: null,
          leaseUntil: null
        });
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.auto_registration.cancel',
          objectType: 'registration_job',
          objectId: jobId,
          afterData: { registered: job.registered }
        });
        return { id: jobId };
      },
      { changedScopes: ['auto-recharge'], operator, requestId: randomUUID(), retryMode: 'none' }
    );
  }

  async resumeCredentials(jobId: string, operator: AuthenticatedUser) {
    await this.owned(jobId, operator);
    return this.transactions.execute(
      async (tx) => {
        await this.repository.lock(tx);
        const job = await this.repository.findInTransaction(tx, jobId);
        if (
          !job ||
          job.ownerId !== operator.id ||
          (!['awaiting_user', 'partial'].includes(job.state) &&
            !(job.leaseUntil && job.leaseUntil <= new Date()))
        )
          throw new ConflictException('当前任务不能补录安全资料');
        const account = job.accountId ? await this.repository.account(tx, job.emailHash) : null;
        if (account && account.id !== job.accountId) throw new ConflictException('关联账号已变化');
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
}
