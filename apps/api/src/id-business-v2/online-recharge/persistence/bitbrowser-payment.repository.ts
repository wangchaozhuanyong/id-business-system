import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import {
  Prisma,
  type OnlineRechargeBitbrowserDevice,
  type OnlineRechargeTask
} from '@prisma/client';
import { createHash } from 'node:crypto';
import type { AuthenticatedUser } from '../../../auth/auth.types';
import { FieldEncryptionService } from '../../../common/crypto/field-encryption.service';
import type { V2CommandTransaction } from '../../runtime/public-api';
import { assertSharedCardPlan } from '../../bank-card-pool/public-api';
import { OnlineRechargeRepository } from './online-recharge.repository';
import { OnlineRechargeWorkerRepository } from './worker.repository';
import {
  BITBROWSER_PLAN,
  documentDigest,
  validateBitbrowserQuote,
  type BitbrowserPolicy
} from '../bitbrowser-policy';
import type { OnlineRechargeWorkerRpc } from '../contracts';
import { id, integer, object, sessionAccountId, text } from '../validation';

export const bitbrowserAccountKey = (accountId: string) =>
  createHash('sha256').update(accountId).digest('hex');
@Injectable()
export class OnlineBitbrowserPaymentRepository {
  constructor(
    private readonly repository: OnlineRechargeRepository,
    private readonly workers: OnlineRechargeWorkerRepository,
    private readonly encryption: FieldEncryptionService
  ) {}
  async owned(
    tx: V2CommandTransaction,
    row: OnlineRechargeTask,
    device: OnlineRechargeBitbrowserDevice
  ) {
    const policy = object(object(row.payload).bitBrowserPolicy) as unknown as BitbrowserPolicy;
    const current = await tx.onlineRechargeBitbrowserDevice.findUnique({
      where: { id: device.id }
    });
    if (
      row.provider !== 'bitbrowser' ||
      policy.deviceId !== device.id ||
      !current?.enabled ||
      current.tokenHash !== device.tokenHash
    )
      throw new ConflictException('比特任务不属于当前执行电脑或电脑已停用');
    const state = await tx.onlineRechargeBitbrowserState.upsert({
      where: { taskId: row.id },
      create: { taskId: row.id, deviceId: device.id, leaseVersion: row.leaseVersion },
      update: {}
    });
    if (state.leaseVersion !== row.leaseVersion) {
      if (object(row.payload).bitBrowserCheckOnly === true && row.paymentStarted)
        return tx.onlineRechargeBitbrowserState.update({
          where: { taskId: row.id },
          data: { leaseVersion: row.leaseVersion }
        });
      if (row.paymentStarted || state.paymentConsumed)
        throw new ConflictException('付款任务不可重新领取');
      return tx.onlineRechargeBitbrowserState.update({
        where: { taskId: row.id },
        data: {
          leaseVersion: row.leaseVersion,
          quote: Prisma.DbNull,
          quoteDigest: null,
          quoteExpiresAt: null,
          authorizedDigest: null,
          authorizedAt: null,
          authorizedByUserId: null,
          version: { increment: 1 }
        }
      });
    }
    return state;
  }
  async restore(rpc: OnlineRechargeWorkerRpc, device: OnlineRechargeBitbrowserDevice) {
    return this.workers.withLease(rpc, async (tx, row) => {
      const state = await this.owned(tx, row, device);
      const account = sessionAccountId(this.encryption.decrypt(row.sessionEncrypted));
      if (!account || rpc.args?.accountKey !== bitbrowserAccountKey(account))
        throw new ConflictException('会话账号与比特任务不一致');
      await tx.onlineRechargeBitbrowserState.update({
        where: { taskId: row.id },
        data: { accountKey: bitbrowserAccountKey(account) }
      });
      const records = state.ledgerEncrypted
        ? object(JSON.parse(this.encryption.decrypt(state.ledgerEncrypted)!))
        : {};
      return {
        ok: true,
        records: Object.entries(records).map(([fileKey, value]) => ({ fileKey, ...object(value) })),
        staleProfiles: []
      };
    });
  }
  async quote(rpc: OnlineRechargeWorkerRpc, device: OnlineRechargeBitbrowserDevice) {
    return this.workers.withLease(rpc, async (tx, row) => {
      const state = await this.owned(tx, row, device),
        args = rpc.args ?? {};
      if (!state.accountKey || args.accountKey !== state.accountKey || row.paymentStarted)
        throw new ConflictException('当前任务不允许重新核价');
      const policy = object(object(row.payload).bitBrowserPolicy) as unknown as BitbrowserPolicy;
      const checked = validateBitbrowserQuote(args.quote, row.plan, policy);
      if (args.quoteDigest !== checked.digest) throw new BadRequestException('报价摘要不匹配');
      if (
        state.quoteDigest === checked.digest &&
        state.quoteExpiresAt &&
        state.quoteExpiresAt.getTime() > Date.now()
      )
        return {
          ok: true,
          digest: checked.digest,
          approved: state.authorizedDigest === checked.digest,
          expiresAt: state.quoteExpiresAt,
          version: state.version
        };
      const expiresAt = new Date(Date.now() + 5 * 60000);
      const updated = await tx.onlineRechargeBitbrowserState.update({
        where: { taskId: row.id },
        data: {
          quote: checked.quote as Prisma.InputJsonObject,
          quoteDigest: checked.digest,
          quoteExpiresAt: expiresAt,
          authorizedDigest: checked.automatic ? checked.digest : null,
          authorizedByUserId: null,
          authorizedAt: checked.automatic ? new Date() : null,
          paymentConsumed: false,
          version: { increment: 1 }
        }
      });
      await tx.onlineRechargeTask.update({
        where: { id: row.id },
        data: {
          stage: checked.automatic
            ? 'bitbrowser_payment_authorized'
            : 'bitbrowser_awaiting_confirmation',
          message: checked.automatic
            ? '报价符合自动付款规则'
            : policy.mode === 'automatic'
              ? '报价超过自动付款上限，等待管理员核对'
              : '核价完成，等待管理员确认付款',
          result: {
            ...object(row.result ?? {}),
            bitBrowserQuote: {
              ...checked.quote,
              digest: checked.digest,
              version: updated.version,
              expiresAt: expiresAt.toISOString(),
              mode: policy.mode,
              automatic: checked.automatic,
              authorized: checked.automatic
            }
          }
        }
      });
      await this.repository.log(tx, 'bitbrowser.quote', undefined, row.id, {
        automatic: checked.automatic,
        currency: policy.currency,
        version: updated.version
      });
      return {
        ok: true,
        digest: checked.digest,
        approved: checked.automatic,
        expiresAt,
        version: updated.version
      };
    });
  }
  confirm(taskId: string, raw: unknown, operator: AuthenticatedUser) {
    const input = object(raw),
      digest = text(input.quoteDigest, '报价摘要', 64),
      version = integer(input.version, '报价版本', 1, 1000000);
    return this.repository.transaction(`task:${id(taskId)}`, async (tx) => {
      const [row, state] = await Promise.all([
        tx.onlineRechargeTask.findUnique({ where: { id: taskId } }),
        tx.onlineRechargeBitbrowserState.findUnique({ where: { taskId } })
      ]);
      if (
        !row ||
        row.provider !== 'bitbrowser' ||
        row.status !== 'running' ||
        row.paymentStarted ||
        !state ||
        state.leaseVersion !== row.leaseVersion ||
        state.paymentConsumed ||
        state.quoteDigest !== digest ||
        state.version !== version ||
        !state.quoteExpiresAt ||
        state.quoteExpiresAt.getTime() <= Date.now() ||
        !row.leaseExpiresAt ||
        row.leaseExpiresAt.getTime() <= Date.now()
      )
        throw new ConflictException('报价或执行租约已变化，请刷新后重新核对');
      const device = await tx.onlineRechargeBitbrowserDevice.findUnique({
        where: { id: state.deviceId }
      });
      if (!device?.enabled) throw new ConflictException('执行电脑已停用');
      if (state.authorizedDigest === digest) return { ok: true, duplicate: true };
      await tx.onlineRechargeBitbrowserState.update({
        where: { taskId },
        data: {
          authorizedDigest: digest,
          authorizedByUserId: operator.id,
          authorizedAt: new Date()
        }
      });
      await tx.onlineRechargeTask.update({
        where: { id: taskId },
        data: {
          stage: 'bitbrowser_payment_authorized',
          message: '管理员已确认本次报价',
          result: {
            ...object(row.result ?? {}),
            bitBrowserQuote: {
              ...object(object(row.result ?? {}).bitBrowserQuote ?? {}),
              authorized: true
            }
          }
        }
      });
      await this.repository.log(tx, 'bitbrowser.payment.confirm', operator, taskId, { version });
      return { ok: true };
    });
  }
  resume(taskId: string, operator: AuthenticatedUser) {
    return this.repository.transaction(`task:${id(taskId)}`, async (tx) => {
      const row = await tx.onlineRechargeTask.findUnique({ where: { id: taskId } });
      if (
        !row ||
        row.provider !== 'bitbrowser' ||
        row.status !== 'running' ||
        object(row.result ?? {}).bitBrowserUserAction !== true
      )
        throw new ConflictException('当前任务没有等待人工验证');
      const payload = object(row.payload);
      await tx.onlineRechargeTask.update({
        where: { id: taskId },
        data: {
          payload: {
            ...payload,
            bitBrowserResumeVersion: Number(payload.bitBrowserResumeVersion ?? 0) + 1,
            bitBrowserResumeLeaseVersion: row.leaseVersion
          } as Prisma.InputJsonObject
        }
      });
      await this.repository.log(tx, 'bitbrowser.verification.resume', operator, taskId);
      return { ok: true };
    });
  }
  status(rpc: OnlineRechargeWorkerRpc, device: OnlineRechargeBitbrowserDevice) {
    return this.workers.withLease(rpc, async (tx, row) => {
      const state = await this.owned(tx, row, device),
        digest = rpc.args?.quoteDigest;
      return {
        ok: true,
        approved:
          !row.paymentStarted &&
          state.quoteDigest === digest &&
          state.authorizedDigest === digest &&
          Boolean(state.quoteExpiresAt && state.quoteExpiresAt.getTime() > Date.now()),
        expired: !state.quoteExpiresAt || state.quoteExpiresAt.getTime() <= Date.now()
      };
    });
  }
  ledger(rpc: OnlineRechargeWorkerRpc, device: OnlineRechargeBitbrowserDevice) {
    return this.workers.withLease(rpc, async (tx, row) => {
      const state = await this.owned(tx, row, device),
        args = rpc.args ?? {};
      const fileKey = text(args.fileKey, '执行记录', 110),
        document = object(args.document);
      const revision = integer(args.revision, '记录版本', 0, 1000000);
      const pattern = new RegExp(`^(?:payments/)?${state.accountKey}(?:-pro-(?:5x|20x))?\\.json$`);
      const upgradeId = document.upgrade_identifier;
      const checkoutId = document.checkout_identifier;
      const checkoutFile =
        typeof checkoutId === 'string' &&
        /^(?:cs|oaics)_[A-Za-z0-9_]{1,200}$/.test(checkoutId) &&
        fileKey === `payments/${createHash('sha256').update(checkoutId).digest('hex')}.json`;
      const upgradeFile =
        document.operation === 'subscription_upgrade' &&
        typeof upgradeId === 'string' &&
        /^upg_[a-f0-9]{32}$/.test(upgradeId) &&
        fileKey === `payments/${createHash('sha256').update(upgradeId).digest('hex')}.json`;
      if (
        !state.accountKey ||
        args.accountKey !== state.accountKey ||
        (!pattern.test(fileKey) && !upgradeFile && !checkoutFile) ||
        Buffer.byteLength(JSON.stringify(document)) > 65536 ||
        (document.account_key !== undefined && document.account_key !== state.accountKey) ||
        (document.target_plan !== undefined && document.target_plan !== BITBROWSER_PLAN[row.plan])
      )
        throw new BadRequestException('执行记录与当前任务不匹配');
      const records = state.ledgerEncrypted
        ? object(JSON.parse(this.encryption.decrypt(state.ledgerEncrypted)!))
        : {};
      const prior = object(records[fileKey] ?? {});
      const previous = object(prior.document ?? {});
      if (
        object(row.payload).bitBrowserCheckOnly === true &&
        (!prior.document ||
          [
            'account_key',
            'target_plan',
            'checkout_identifier',
            'upgrade_identifier',
            'quote_digest',
            'card_last4'
          ].some((key) => document[key] !== previous[key]) ||
          documentDigest(document.quote ?? null) !== documentDigest(previous.quote ?? null))
      )
        throw new ConflictException('核对任务只能更新原付款记录');
      if (
        previous.payment_status === 'paid' &&
        (document.payment_status !== 'paid' ||
          documentDigest(document.payment_evidence ?? null) !==
            documentDigest(previous.payment_evidence ?? null))
      )
        throw new ConflictException('不能改变已确认的付款事实');
      if (
        prior.revision === revision + 1 &&
        documentDigest(prior.document) === documentDigest(document)
      )
        return { ok: true, revision: prior.revision, replayed: true };
      if ((prior.revision ?? 0) !== revision) throw new ConflictException('执行记录版本已变化');
      const submitted = document.confirmation_requests_sent === 1;
      const previousSubmitted = object(prior.document ?? {}).confirmation_requests_sent === 1;
      if (previousSubmitted && !submitted) throw new ConflictException('不能清除已有付款提交事实');
      if (submitted && !previousSubmitted) {
        if (
          row.paymentStarted ||
          state.paymentConsumed ||
          !state.quoteDigest ||
          document.quote_digest !== state.quoteDigest ||
          state.authorizedDigest !== state.quoteDigest ||
          !state.quoteExpiresAt ||
          state.quoteExpiresAt.getTime() <= Date.now()
        )
          throw new ConflictException('本次付款未获有效许可或已经提交');
        const card = row.cardId
          ? await tx.onlineRechargeCard.findFirst({ where: { id: row.cardId, leaseOwner: row.id } })
          : null;
        if (
          !card ||
          card.status !== 'active' ||
          !card.leaseExpiresAt ||
          card.leaseExpiresAt.getTime() <= Date.now()
        )
          throw new ConflictException('本次银行卡租约已失效');
        assertSharedCardPlan(card.allowedPlans, row.plan);
        await tx.onlineRechargeTask.update({
          where: { id: row.id },
          data: { paymentStarted: true, stage: 'payment_submitted' }
        });
        await this.repository.log(tx, 'bitbrowser.payment.submitted', undefined, row.id, {
          leaseVersion: row.leaseVersion
        });
      }
      records[fileKey] = { revision: revision + 1, document };
      await tx.onlineRechargeBitbrowserState.update({
        where: { taskId: row.id },
        data: {
          ledgerEncrypted: this.encryption.encrypt(JSON.stringify(records)),
          paymentConsumed: state.paymentConsumed || submitted
        }
      });
      return { ok: true, revision: revision + 1, replayed: false };
    });
  }
  release(rpc: OnlineRechargeWorkerRpc, device: OnlineRechargeBitbrowserDevice) {
    return this.workers.withLease(rpc, async (tx, row) => {
      await this.owned(tx, row, device);
      if (row.paymentStarted) throw new ConflictException('已有付款提交，只能核对原任务');
      await tx.onlineRechargeTask.update({
        where: { id: row.id },
        data: {
          status: 'queued',
          leaseOwner: null,
          leaseId: null,
          leaseExpiresAt: null,
          stage: 'queued',
          message: '执行电脑忙碌，等待原任务重新领取'
        }
      });
      await tx.onlineRechargeCard.updateMany({
        where: { leaseOwner: row.id },
        data: { leaseOwner: null, leaseId: null, leaseExpiresAt: null }
      });
      // 上一租约的报价许可不能被下一租约复用。
      await tx.onlineRechargeBitbrowserState.update({
        where: { taskId: row.id },
        data: {
          quote: Prisma.DbNull,
          quoteDigest: null,
          authorizedDigest: null,
          quoteExpiresAt: null,
          version: { increment: 1 }
        }
      });
      return { ok: true };
    });
  }
}
