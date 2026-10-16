import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable
} from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { V2IdentityService } from '../../v2-auth/v2-identity.service';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  toV2JsonDocument,
  type V2CommandTransaction
} from '../runtime/public-api';
import { IdBusinessV2RechargeMailboxService } from '../workspace/public-api';
import { BankRechargeAccountService } from './bank-recharge-account.service';
import { RechargeRepository } from './persistence/recharge.repository';
import { object, uuidPattern } from './recharge-validation';

type Challenge = { accountId: string; kind: 'email' | 'totp'; challengeId: string };
type Code = { token: string; expiresAt: string };

/** Only task-scoped short-lived codes leave this service. Keys never leave account storage. */
@Injectable()
export class RechargeLoginCodeService {
  private readonly waiting = new Map<string, Promise<Code>>();
  constructor(
    private readonly repository: RechargeRepository,
    private readonly transactions: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService,
    private readonly accounts: BankRechargeAccountService,
    private readonly encryption: FieldEncryptionService,
    private readonly identity: V2IdentityService,
    private readonly mailboxes: IdBusinessV2RechargeMailboxService
  ) {}

  private execute<T>(id: string, work: (tx: V2CommandTransaction) => Promise<T>) {
    return this.transactions.execute(
      async (tx) => {
        await this.repository.lock(tx);
        return work(tx);
      },
      { changedScopes: ['auto-recharge'], requestId: id, retryMode: 'none' }
    );
  }

  private async authorized(
    tx: V2CommandTransaction,
    id: string,
    input: Challenge,
    operator: AuthenticatedUser
  ) {
    const job = await this.repository.active(tx, id);
    const result = object(job.result);
    if (job.ownerId !== operator.id) throw new ForbiddenException('无权读取此任务验证码');
    const current = await this.identity.getAuthenticatedUser(operator.id);
    if (!current.roles.includes('admin') || current.mustResetPassword)
      throw new ForbiddenException('管理员授权已失效');
    if (
      job.action !== 'bitbrowser' ||
      !['running', 'awaiting_human_verification'].includes(job.state) ||
      job.leaseUntil.getTime() <= Date.now() ||
      result.status === 'cancelling' ||
      job.chatgptAccountId !== input.accountId ||
      result.login_code_type !== input.kind ||
      result.login_challenge_id !== input.challengeId ||
      !['login_code_required', 'login_email_code_required'].includes(String(result.stage)) ||
      result.payment_attempted === true ||
      Number(result.payment_requests_sent ?? 0) !== 0 ||
      result.recheck_only === true
    )
      throw new ConflictException('原登录任务或验证码类型已变化，请在原窗口核对');
    const account = await this.accounts.requireActive(tx, input.accountId);
    if (
      !job.expectedEmailEncrypted ||
      this.encryption.decrypt(job.expectedEmailEncrypted) !==
        this.encryption.decrypt(account.emailEncrypted)
    )
      throw new ConflictException('任务邮箱与账号资料不一致');
    return { job, result, current, account };
  }

  async request(id: string, value: unknown, operator: AuthenticatedUser) {
    const raw = object(value);
    if (
      !uuidPattern.test(id) ||
      Object.keys(raw).some((key) => !['accountId', 'kind', 'challengeId'].includes(key)) ||
      typeof raw.accountId !== 'string' ||
      !uuidPattern.test(raw.accountId) ||
      typeof raw.challengeId !== 'string' ||
      !uuidPattern.test(raw.challengeId) ||
      !['email', 'totp'].includes(String(raw.kind))
    )
      throw new BadRequestException('登录验证码请求无效');
    const input = raw as Challenge;
    const key = `${id}:${input.kind}:${input.challengeId}`;
    // The first request claims this kind once, before any external read. Reconnection can
    // join the same wait, but process restart or a second challenge cannot replay a code.
    let pending = this.waiting.get(key);
    if (!pending) {
      const snapshot = await this.execute(id, async (tx) => {
        const snapshot = await this.authorized(tx, id, input, operator);
        if (snapshot.result[`login_code_claim_${input.kind}`])
          throw new ConflictException('本次验证码已领取或等待已结束，请在原窗口继续');
        await this.repository.updateJob(tx, id, {
          result: toV2JsonDocument({
            ...snapshot.result,
            [`login_code_claim_${input.kind}`]: input.challengeId
          })
        });
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.auto_recharge.login_code.request',
          objectType: 'recharge_job',
          objectId: id,
          afterData: {
            accountId: input.accountId,
            kind: input.kind,
            challengeId: input.challengeId
          }
        });
        return snapshot;
      });
      pending = (async () => {
        if (input.kind === 'email') {
          const email = this.encryption.decrypt(snapshot.account.emailEncrypted)!;
          const mailbox = await this.mailboxes.rechargeMailbox(email, snapshot.current);
          const mail = await this.mailboxes.waitForRechargeCode(
            mailbox.aliasId,
            email,
            new Date(
              String(
                snapshot.result.login_mail_requested_at ?? snapshot.job.createdAt.toISOString()
              )
            ),
            snapshot.current
          );
          if (!mail) throw new ConflictException('120 秒内未收到可用邮件，请在原窗口继续');
          return { token: mail.code, expiresAt: new Date(Date.now() + 30_000).toISOString() };
        }
        let code = await this.accounts.totpCode(input.accountId, snapshot.current);
        if (code.expiresAt.getTime() - Date.now() < 8000) {
          const delay = Math.max(1, code.expiresAt.getTime() - Date.now() + 50);
          code.token = '';
          await new Promise((resolve) => setTimeout(resolve, delay));
          code = await this.accounts.totpCode(input.accountId, snapshot.current);
        }
        if (code.expiresAt.getTime() - Date.now() < 8000)
          throw new ConflictException('2FA 验证码有效时间不足');
        return { token: code.token, expiresAt: code.expiresAt.toISOString() };
      })();
      this.waiting.set(key, pending);
      // Cleanup even when a browser closes or a network response is lost.
      const expire = setTimeout(() => this.waiting.delete(key), 125_000);
      expire.unref();
      void pending.catch(() => undefined);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Heartbeats wait locally. They never poll the external mailbox.
      const code = await Promise.race([
        pending,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), 10_000);
        })
      ]);
      if (!code) return { pending: true as const };
      return await this.execute(id, async (tx) => {
        const { result } = await this.authorized(tx, id, input, operator);
        if (
          result[`login_code_issued_${input.kind}`] ||
          Date.parse(code.expiresAt) <= Date.now() + (input.kind === 'totp' ? 8000 : 3000)
        )
          throw new ConflictException('验证码已领取或已过期，请在原窗口继续');
        await this.repository.updateJob(tx, id, {
          result: toV2JsonDocument({
            ...result,
            [`login_code_issued_${input.kind}`]: input.challengeId
          })
        });
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.auto_recharge.login_code.issue',
          objectType: 'recharge_job',
          objectId: id,
          afterData: { kind: input.kind, challengeId: input.challengeId }
        });
        this.waiting.delete(key);
        return { pending: false as const, ...input, ...code };
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
