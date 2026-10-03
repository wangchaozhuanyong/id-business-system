import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable
} from '@nestjs/common';
import type { IdBusinessV2RechargeJob } from '@prisma/client';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { V2IdentityService } from '../../v2-auth/v2-identity.service';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  toV2JsonDocument,
  type V2CommandTransaction
} from '../runtime/public-api';
import { IdBusinessV2RechargeMailboxService } from '../workspace/public-api';
import { RechargeRepository } from './persistence/recharge.repository';
import { object, uuidPattern } from './recharge-validation';

const MAIL_WINDOW_MS = 10 * 60_000;

@Injectable()
export class RechargeEmailCodeService {
  constructor(
    private readonly repository: RechargeRepository,
    private readonly transactions: V2CommandTransactionManager,
    private readonly identity: V2IdentityService,
    private readonly encryption: FieldEncryptionService,
    private readonly mailboxes: IdBusinessV2RechargeMailboxService,
    private readonly audit: V2TransactionalAuditService
  ) {}

  async request(id: string, value: unknown) {
    if (!uuidPattern.test(id)) throw new BadRequestException('执行记录编号无效');
    const input = object(value);
    if (
      !['prepare', 'read', 'received'].includes(String(input.type)) ||
      Object.keys(input).some((key) => !['type', 'mailId'].includes(key)) ||
      (input.type === 'received'
        ? typeof input.mailId !== 'string' || !input.mailId || input.mailId.length > 191
        : input.mailId !== undefined)
    )
      throw new BadRequestException('邮箱验证码任务请求无效');
    if (input.type === 'prepare') return this.prepare(id);
    if (input.type === 'received') return this.received(id, input.mailId as string);
    return this.read(id);
  }

  private execute<T>(id: string, work: (tx: V2CommandTransaction) => Promise<T>) {
    return this.transactions.execute(
      async (tx) => {
        await this.repository.lock(tx);
        return work(tx);
      },
      { changedScopes: ['auto-recharge'], requestId: id, retryMode: 'none' }
    );
  }

  private async authorized(tx: V2CommandTransaction, id: string, reading = false) {
    const job = await this.repository.active(tx, id);
    const result = object(job.result);
    if (
      job.action !== 'server' ||
      job.state !== 'running' ||
      !job.expectedEmailEncrypted ||
      job.leaseUntil.getTime() <= Date.now() ||
      result.status === 'cancelling' ||
      result.recheck_only === true ||
      result.payment_attempted === true ||
      Number(result.payment_requests_sent ?? 0) !== 0 ||
      ![
        'login_email',
        'login_password',
        'login_email_code_required',
        'login_email_code_submitted'
      ].includes(String(result.stage)) ||
      (reading &&
        !['login_email_code_required', 'login_email_code_submitted'].includes(String(result.stage)))
    )
      throw new ConflictException('当前任务不能读取登录邮箱验证码');
    const operator = await this.identity.getAuthenticatedUser(job.ownerId);
    if (!operator.roles.includes('admin') || operator.mustResetPassword)
      throw new ForbiddenException('管理员授权已失效');
    const email = this.encryption.decrypt(job.expectedEmailEncrypted)?.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new ConflictException('任务目标邮箱不可用');
    return { job, result, operator, email };
  }

  private metadata(result: Record<string, unknown>) {
    const requestedAt = Date.parse(String(result.login_mail_requested_at ?? ''));
    if (
      !Number.isFinite(requestedAt) ||
      requestedAt > Date.now() ||
      Date.now() - requestedAt > MAIL_WINDOW_MS ||
      typeof result.login_mail_alias_id !== 'string' ||
      !result.login_mail_alias_id
    )
      throw new ConflictException('登录邮箱验证码读取窗口已失效');
    return { since: new Date(requestedAt), aliasId: result.login_mail_alias_id };
  }

  private async save(
    tx: V2CommandTransaction,
    job: IdBusinessV2RechargeJob,
    result: Record<string, unknown>,
    patch: Record<string, string>,
    action: string
  ) {
    await this.repository.updateJob(tx, job.id, {
      result: toV2JsonDocument({ ...result, ...patch })
    });
    await this.audit.append(tx, {
      userId: job.ownerId,
      module: 'id_business_v2',
      action: `id_business_v2.auto_recharge.email_code.${action}`,
      objectType: 'recharge_job',
      objectId: job.id
    });
  }

  private prepare(id: string) {
    return this.execute(id, async (tx) => {
      const { job, result, operator, email } = await this.authorized(tx, id);
      const mailbox = await this.mailboxes.rechargeMailbox(email, operator);
      if (result.login_mail_requested_at !== undefined) {
        const metadata = this.metadata(result);
        if (metadata.aliasId !== mailbox.aliasId)
          throw new ConflictException('原邮箱关联已变化，请核对任务');
        return { ok: true };
      }
      await this.save(
        tx,
        job,
        result,
        {
          login_mail_requested_at: new Date().toISOString(),
          login_mail_alias_id: mailbox.aliasId
        },
        'prepare'
      );
      return { ok: true };
    });
  }

  private async read(id: string) {
    const snapshot = await this.execute(id, async (tx) => {
      const authorized = await this.authorized(tx, id, true);
      if (authorized.result.stage !== 'login_email_code_required')
        throw new ConflictException('当前官网页面未请求邮箱验证码');
      return { ...authorized, ...this.metadata(authorized.result) };
    });
    if (snapshot.result.login_mail_received_id) return { mail: null };
    const mail = await this.mailboxes.rechargeCode(
      snapshot.aliasId,
      snapshot.email,
      snapshot.since,
      typeof snapshot.result.login_mail_received_id === 'string'
        ? snapshot.result.login_mail_received_id
        : null,
      snapshot.operator
    );
    return this.execute(id, async (tx) => {
      const { job, result, email, operator } = await this.authorized(tx, id, true);
      const metadata = this.metadata(result);
      const mailbox = await this.mailboxes.rechargeMailbox(email, operator);
      if (
        email !== snapshot.email ||
        metadata.aliasId !== snapshot.aliasId ||
        metadata.since.getTime() !== snapshot.since.getTime() ||
        mailbox.aliasId !== metadata.aliasId
      )
        throw new ConflictException('登录邮箱任务已变化');
      if (!mail || result.login_mail_received_id) return { mail: null };
      await this.save(tx, job, result, { login_mail_offered_id: mail.mailId }, 'read');
      return { mail };
    });
  }

  private received(id: string, mailId: string) {
    return this.execute(id, async (tx) => {
      const { job, result, email, operator } = await this.authorized(tx, id, true);
      const metadata = this.metadata(result);
      const mailbox = await this.mailboxes.rechargeMailbox(email, operator);
      if (metadata.aliasId !== mailbox.aliasId)
        throw new ConflictException('原邮箱关联已变化，请核对任务');
      if (result.stage !== 'login_email_code_submitted')
        throw new ConflictException('当前官网尚未提交邮箱验证码');
      if (result.login_mail_received_id === mailId) return { ok: true };
      if (result.login_mail_offered_id !== mailId)
        throw new ConflictException('邮件接收确认不匹配');
      await this.save(tx, job, result, { login_mail_received_id: mailId }, 'received');
      return { ok: true };
    });
  }
}
