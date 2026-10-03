import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable
} from '@nestjs/common';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { V2_REGISTRATION_STEPS } from '@apple-business/shared';
import type { IdBusinessV2RegistrationJob } from '@prisma/client';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { V2CommandTransactionManager, V2TransactionalAuditService } from '../runtime/public-api';
import { parseIdBusinessV2TotpSecret } from '../workspace/public-api';
import { bankRechargeCountryCode } from '../auto-recharge/public-api';
import { RegistrationRepository } from './persistence/registration.repository';
import { registrationSummary, registrationTokenHash } from './registration-jobs.service';
import { id, offer, record, step, text } from './registration-validation';

@Injectable()
export class RegistrationEventsService {
  constructor(
    private readonly repository: RegistrationRepository,
    private readonly transactions: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService,
    private readonly encryption: FieldEncryptionService
  ) {}
  async event(jobId: string, token: unknown, value: unknown) {
    id(jobId);
    if (typeof token !== 'string' || !/^[a-f\d]{64}$/.test(token))
      throw new ForbiddenException('任务授权无效');
    const input = record(value);
    if (
      Object.keys(input).some(
        (key) =>
          ![
            'type',
            'attempt',
            'step',
            'email',
            'registrationCountryCode',
            'browserProfileId',
            'totpSecret',
            'offerStatus',
            'offerSummary',
            'reason',
            'mailId'
          ].includes(key)
      )
    )
      throw new BadRequestException('任务回执包含未知字段');
    const type = text(input.type, '回执类型', 40);
    if (
      ![
        'progress',
        'mail_accepted',
        'waiting_email',
        'waiting_user',
        'registered',
        'password_verified',
        'totp_pending',
        'mfa_verified',
        'offer',
        'complete',
        'partial',
        'cancelled'
      ].includes(type)
    )
      throw new BadRequestException('任务回执类型无效');
    if (input.registrationCountryCode !== undefined && type !== 'registered')
      throw new BadRequestException('仅注册完成回执可记录注册国家');
    const registrationCountryCode = bankRechargeCountryCode(input.registrationCountryCode);
    return this.transactions.execute(
      async (tx) => {
        await this.repository.lock(tx);
        let row = await this.repository.findInTransaction(tx, jobId);
        if (
          !row ||
          !row.nonceHash ||
          !row.leaseUntil ||
          row.leaseUntil <= new Date() ||
          !timingSafeEqual(
            Buffer.from(row.nonceHash, 'hex'),
            Buffer.from(registrationTokenHash(token), 'hex')
          ) ||
          row.attempt !== input.attempt ||
          ['completed', 'cancelled'].includes(row.state)
        )
          throw new ForbiddenException('任务授权已失效');
        const eventSteps: Record<string, typeof row.step> = {
          registered: 'registered',
          password_verified: 'password_verified',
          mfa_verified: 'mfa_verified',
          offer: 'offer',
          complete: 'completed'
        };
        const nextStep =
          eventSteps[type] ?? (input.step === undefined ? row.step : step(input.step));
        if (
          V2_REGISTRATION_STEPS.indexOf(nextStep) < V2_REGISTRATION_STEPS.indexOf(row.step) &&
          !['partial', 'waiting_user'].includes(type)
        )
          throw new ConflictException('回执步骤已过期');
        if (
          V2_REGISTRATION_STEPS.indexOf(nextStep) >= V2_REGISTRATION_STEPS.indexOf('registered') &&
          !row.registered &&
          type !== 'registered'
        )
          throw new ConflictException('尚未核实官网注册完成');
        if (
          V2_REGISTRATION_STEPS.indexOf(nextStep) >=
            V2_REGISTRATION_STEPS.indexOf('password_verified') &&
          !row.passwordVerified &&
          type !== 'password_verified'
        )
          throw new ConflictException('密码配置尚未完成');
        if (
          V2_REGISTRATION_STEPS.indexOf(nextStep) >=
            V2_REGISTRATION_STEPS.indexOf('mfa_verified') &&
          !row.mfaVerified &&
          type !== 'mfa_verified'
        )
          throw new ConflictException('双重验证尚未完成');
        const profileId =
          input.browserProfileId === undefined
            ? row.browserProfileId
            : text(input.browserProfileId, '浏览器窗口编号', 100);
        if (profileId && !/^[A-Za-z0-9_-]{8,100}$/.test(profileId))
          throw new BadRequestException('浏览器窗口编号无效');
        if (row.browserProfileId && profileId !== row.browserProfileId)
          throw new ConflictException('必须继续原浏览器窗口');
        if (
          !row.browserProfileId &&
          profileId?.startsWith('reg_') &&
          (await this.repository.fingerprintExists(tx, profileId, row.id))
        )
          throw new ConflictException('浏览器指纹与已有任务重复，请重新生成');
        const replaceVerifiedCredentials =
          (type === 'password_verified' && !row.passwordVerified) ||
          (type === 'mfa_verified' && !row.mfaVerified);
        const patch: Parameters<RegistrationRepository['update']>[2] = {
          step: ['partial', 'waiting_user'].includes(type) ? row.step : nextStep,
          browserProfileId: profileId,
          state: 'running',
          reason: null
        };
        if (type === 'waiting_email') {
          if (!['email_code', 'password', 'mfa'].includes(nextStep))
            throw new BadRequestException('当前步骤不能读取邮件');
          patch.state = 'awaiting_email';
          patch.codeRequestedAt = new Date();
        }
        if (type === 'waiting_user') patch.state = 'awaiting_user';
        if (type === 'mail_accepted') {
          if (row.state !== 'awaiting_email') throw new ConflictException('当前步骤未等待邮件');
          patch.lastMailId = text(input.mailId, '邮件编号', 191);
        }
        if (type === 'registered') {
          if (
            this.encryption.hash(text(input.email, '官网邮箱', 255).toLowerCase()) !== row.emailHash
          )
            throw new ConflictException('官网登录邮箱与任务不一致');
          patch.registered = true;
          patch.step = 'registered';
          // Freeze the first confirmed registration snapshot, including unknown countries.
          if (!row.registered) patch.registrationCountryCode = registrationCountryCode;
        }
        if (type === 'password_verified') {
          this.registered(row);
          patch.passwordVerified = true;
          patch.step = 'password_verified';
        }
        if (type === 'totp_pending') {
          this.registered(row);
          const totp = parseIdBusinessV2TotpSecret(text(input.totpSecret, '验证器密钥', 2048));
          if (totp.algorithm !== 'sha1' || totp.digits !== 6 || totp.period !== 30)
            throw new BadRequestException('当前注册只支持标准验证器配置');
          patch.pendingTotpEncrypted = this.encryption.encrypt(totp.secret);
        }
        if (type === 'mfa_verified') {
          this.registered(row);
          if (!row.pendingTotpEncrypted) throw new ConflictException('尚未安全保存验证器配置');
          patch.mfaVerified = true;
          patch.step = 'mfa_verified';
        }
        if (type === 'offer') {
          this.registered(row);
          patch.offerStatus = offer(input.offerStatus);
          patch.offerSummary = input.offerSummary
            ? text(input.offerSummary, '优惠摘要', 500)
            : null;
          patch.step = 'offer';
        }
        if (['partial', 'cancelled'].includes(type)) {
          patch.state = type as 'partial' | 'cancelled';
          patch.nonceHash = null;
          patch.leaseUntil = null;
        }
        if (input.reason !== undefined) {
          const reason = text(input.reason, '任务原因', 80);
          if (!/^[a-z_]+$/.test(reason)) throw new BadRequestException('任务原因无效');
          patch.reason = reason;
        }
        if (type === 'complete') {
          if (!row.registered || !row.passwordVerified || !row.mfaVerified)
            throw new ConflictException('注册和安全配置尚未完成');
          patch.state = 'completed';
          patch.step = 'completed';
          patch.nonceHash = null;
          patch.leaseUntil = null;
        }
        row = await this.repository.update(tx, jobId, patch);
        if (row.registered) {
          const account = await this.repository.saveAccount(
            tx,
            row,
            type,
            replaceVerifiedCredentials
          );
          if (row.accountId !== account.id)
            row = await this.repository.update(tx, jobId, { accountId: account.id });
          if (type === 'offer') await this.repository.saveOffer(tx, row);
        }
        await this.audit.append(tx, {
          userId: row.ownerId,
          module: 'id_business_v2',
          action: 'id_business_v2.auto_registration.progress',
          objectType: 'registration_job',
          objectId: jobId,
          afterData: {
            state: row.state,
            step: row.step,
            registered: row.registered,
            registrationCountryCode: row.registrationCountryCode,
            passwordVerified: row.passwordVerified,
            mfaVerified: row.mfaVerified,
            offerStatus: row.offerStatus
          }
        });
        return registrationSummary(row);
      },
      { changedScopes: ['auto-recharge'], requestId: randomUUID(), retryMode: 'none' }
    );
  }
  private registered(row: IdBusinessV2RegistrationJob) {
    if (!row.registered) throw new ConflictException('尚未核实官网注册完成');
  }
}
