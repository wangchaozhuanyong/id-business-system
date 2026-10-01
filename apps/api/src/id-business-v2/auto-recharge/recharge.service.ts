import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Optional,
  ServiceUnavailableException
} from '@nestjs/common';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  toV2JsonDocument
} from '../runtime/public-api';
import { RechargeRepository } from './persistence/recharge.repository';
import { completeCancellation, canReplaceCheckout } from './recharge-cancellation';
import { RechargeAddressRepository } from './persistence/recharge-address.repository';
import { consumeRechargeAddress } from './recharge-address-consumption';
import {
  RECHARGE_ADDRESS_LOCATION,
  validateRechargeAddressImport,
  validateRechargeAddressListQuery,
  validateRechargeAddressStatus
} from './recharge-address-validation';
import {
  hash,
  object,
  safeDocument,
  uuidPattern,
  validateDetailsSubmission,
  validateWorkerConfirmation
} from './recharge-validation';
import { completeUnknownPaymentResolution } from './recharge-resolution';
import {
  clearRechargeDetails,
  isBrowserProfileId,
  rechargeDetailsWithAddress,
  staleProfile
} from './recharge-job-helpers';
import { sendRechargeWorkerRequest } from './recharge-worker-client';
import { BankRechargeAccountService } from './bank-recharge-account.service';
import { BankRechargeCardService } from './bank-recharge-card.service';
import { BankRechargeOrderService } from './bank-recharge-order.service';
import {
  bindSavedChatgptAccount,
  recordServerLoginNetwork,
  recordVerifiedBankRecharge
} from './recharge-bank-callback';
import { mergeRechargeCallbackResult } from './recharge-bank-callback';
import { RechargeSettingsService } from './recharge-settings.service';
import { RechargeProxyService } from './recharge-proxy.service';
import { startRechargeJob } from './recharge-start';
import { startServerRecheck } from './recharge-server-recheck';
import { listRechargeJobs } from './recharge-job-list';
import { IdBusinessV2TotpAccountService } from '../workspace/public-api';
@Injectable()
export class RechargeService {
  constructor(
    private readonly repository: RechargeRepository,
    private readonly addressRepository: RechargeAddressRepository,
    private readonly transactions: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService,
    @Optional() private readonly bankAccounts?: BankRechargeAccountService,
    @Optional() private readonly bankOrders?: BankRechargeOrderService,
    @Optional() private readonly settings?: RechargeSettingsService,
    @Optional() private readonly bankCards?: BankRechargeCardService,
    @Optional() private readonly proxies?: RechargeProxyService,
    @Optional() private readonly totpAccounts?: IdBusinessV2TotpAccountService
  ) {}

  async listAddresses(value: unknown, operator: AuthenticatedUser) {
    const query = validateRechargeAddressListQuery(value);
    const result = await this.addressRepository.list(operator.id, query);
    return { ...result, page: query.page, pageSize: query.pageSize };
  }

  async importAddresses(value: unknown, operator: AuthenticatedUser) {
    const input = validateRechargeAddressImport(value);
    return this.transactions.execute(
      async (tx) => {
        const created = await this.addressRepository.createMany(tx, operator.id, input.streets);
        const result = {
          imported: created.count,
          duplicated: input.duplicatedInFile + input.streets.length - created.count,
          rejected: input.rejected
        };
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.auto_recharge.addresses.import',
          objectType: 'recharge_address_batch',
          objectId: randomUUID(),
          afterData: { ...result, location: RECHARGE_ADDRESS_LOCATION },
          remark: '批量导入自动充值地址'
        });
        return result;
      },
      {
        changedScopes: ['auto-recharge'],
        requestId: randomUUID(),
        operator,
        retryMode: 'none'
      }
    );
  }

  async updateAddressStatus(id: string, value: unknown, operator: AuthenticatedUser) {
    if (!uuidPattern.test(id)) throw new BadRequestException('地址编号无效');
    const status = validateRechargeAddressStatus(value);
    return this.transactions.execute(
      async (tx) => {
        const result = await this.addressRepository.updateStatus(tx, operator.id, id, status);
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.auto_recharge.addresses.status',
          objectType: 'recharge_address',
          objectId: id,
          beforeData: { status: result.before.status },
          afterData: { status: result.after.status },
          remark: status === 'used' ? '标记地址已使用' : '更新地址可用状态'
        });
        return result.after;
      },
      {
        changedScopes: ['auto-recharge'],
        requestId: randomUUID(),
        operator,
        retryMode: 'none'
      }
    );
  }

  async list(operator: AuthenticatedUser) {
    return listRechargeJobs(
      this.repository,
      operator.id,
      process.env.AUTO_RECHARGE_WORKER_TOKEN ?? ''
    );
  }

  private async finishUnreceivedJob(id: string, ownerId: string, unknown: boolean) {
    await this.transactions.execute(
      async (tx) => {
        await this.repository.lock(tx);
        const job = await this.repository.findJob(tx, id);
        if (!job || job.ownerId !== ownerId || job.state === 'finished') return;
        await this.repository.updateJob(tx, id, {
          state: unknown ? 'unknown' : 'finished',
          leaseUntil: new Date(),
          result: toV2JsonDocument({
            ...object(job.result),
            status: 'blocked',
            reason: unknown ? 'worker_acceptance_unknown' : 'worker_not_received',
            payment_requests_sent: 0
          })
        });
      },
      { changedScopes: ['auto-recharge'], requestId: id, retryMode: 'none' }
    );
  }

  async start(value: unknown, operator: AuthenticatedUser) {
    return startRechargeJob(value, operator, {
      repository: this.repository,
      addressRepository: this.addressRepository,
      transactions: this.transactions,
      audit: this.audit,
      bankAccounts: this.bankAccounts,
      bankCards: this.bankCards,
      totpAccounts: this.totpAccounts,
      settings: this.settings,
      proxies: this.proxies,
      finishUnreceivedJob: (id, ownerId, unknown) => this.finishUnreceivedJob(id, ownerId, unknown)
    });
  }

  async recheckServer(value: unknown, operator: AuthenticatedUser) {
    return startServerRecheck(value, operator, {
      repository: this.repository,
      transactions: this.transactions,
      audit: this.audit,
      accounts: this.bankAccounts,
      totpAccounts: this.totpAccounts,
      proxies: this.proxies,
      finishUnreceivedJob: (id, ownerId, unknown) => this.finishUnreceivedJob(id, ownerId, unknown)
    });
  }

  async submitDetails(id: string, value: unknown, operator: AuthenticatedUser) {
    if (!uuidPattern.test(id)) throw new BadRequestException('任务编号无效');
    const input = validateDetailsSubmission(value);
    const selected = await this.transactions.execute(
      async (tx) => {
        await this.repository.lock(tx);
        const job = await this.repository.active(tx, id);
        if (job.ownerId !== operator.id) throw new ForbiddenException('无权操作此任务');
        if (job.action !== 'flow' || job.state !== 'awaiting_details') {
          throw new ConflictException('当前任务未在等待付款资料');
        }
        const address = await this.addressRepository.requireUnused(
          tx,
          operator.id,
          input.addressId
        );
        await this.repository.updateJob(tx, id, {
          state: 'running',
          result: toV2JsonDocument({ ...object(job.result), addressId: address.id })
        });
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.auto_recharge.details',
          objectType: 'recharge_job',
          objectId: id,
          afterData: { addressId: address.id },
          remark: '提交本次付款资料并重新核价'
        });
        return address;
      },
      { changedScopes: ['auto-recharge'], requestId: id, operator, retryMode: 'none' }
    );
    try {
      const receipt = await sendRechargeWorkerRequest(
        `/jobs/${id}/details`,
        {
          details: rechargeDetailsWithAddress(input.details, selected)
        },
        id,
        'details_received'
      );
      if (receipt !== 'accepted') {
        await this.finishUnreceivedJob(id, operator.id, receipt === 'unknown');
        throw new ServiceUnavailableException(
          receipt === 'unknown'
            ? '付款资料接收结果待核验，资料已保留在当前页面，系统不会自动重发'
            : '执行器未接收付款资料，请重新开始'
        );
      }
      return { id };
    } finally {
      clearRechargeDetails(input.details);
    }
  }
  async confirm(id: string, nonce: unknown, operator: AuthenticatedUser) {
    if (typeof nonce !== 'string' || !/^[a-f0-9]{64}$/.test(nonce)) {
      throw new BadRequestException('报价确认已失效，请重新核价');
    }
    await this.transactions.execute(
      async (tx) => {
        await this.repository.lock(tx);
        const job = await this.repository.active(tx, id);
        if (job.ownerId !== operator.id) throw new ForbiddenException('无权操作此任务');
        if (job.action === 'server') throw new ConflictException('服务器任务已经获得单次付款授权');
        if (job.state !== 'awaiting_confirmation' || job.nonceHash !== hash(nonce)) {
          throw new ConflictException('报价已变化或本次确认已提交，禁止重复付款');
        }
        await this.repository.updateJob(tx, id, { state: 'confirming' });
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.auto_recharge.confirm',
          objectType: 'recharge_job',
          objectId: id,
          afterData: toV2JsonDocument(safeDocument(job.result)),
          remark: '确认当前官方报价，仅提交一次'
        });
      },
      { changedScopes: ['auto-recharge'], requestId: id, operator, retryMode: 'none' }
    );
    const receipt = await sendRechargeWorkerRequest(
      '/jobs/' + id + '/confirm',
      { nonce },
      id,
      'confirmation_received'
    );
    if (receipt !== 'accepted') {
      if (receipt === 'not_received') {
        await this.transactions.execute(
          async (tx) => {
            await this.repository.lock(tx);
            const job = await this.repository.findJob(tx, id);
            if (job?.ownerId === operator.id && job.state === 'confirming') {
              await this.repository.updateJob(tx, id, { state: 'awaiting_confirmation' });
            }
          },
          { changedScopes: ['auto-recharge'], requestId: id, operator, retryMode: 'none' }
        );
      } else {
        await this.transactions.execute(
          async (tx) => {
            await this.repository.lock(tx);
            const job = await this.repository.findJob(tx, id);
            if (job?.ownerId === operator.id && job.state === 'confirming') {
              await this.repository.updateJob(tx, id, {
                state: 'unknown',
                leaseUntil: new Date(),
                result: toV2JsonDocument({
                  ...object(job.result),
                  status: 'blocked',
                  reason: 'confirmation_acceptance_unknown'
                })
              });
            }
          },
          { changedScopes: ['auto-recharge'], requestId: id, operator, retryMode: 'none' }
        );
      }
      throw new ServiceUnavailableException('付款确认接收结果待核验，只能刷新或复查原订单');
    }
    return { id };
  }
  async cancel(id: string, operator: AuthenticatedUser) {
    const job = await this.repository.owned(id, operator.id);
    if (job.state === 'confirming') throw new ConflictException('付款已确认，只能等待或复查原订单');
    await sendRechargeWorkerRequest('/jobs/' + id + '/cancel', {}, id, 'cancelled');
    return { id };
  }
  authorizeWorker(token: unknown) {
    const expected = process.env.AUTO_RECHARGE_WORKER_TOKEN ?? '';
    if (
      expected.length < 32 ||
      typeof token !== 'string' ||
      token.length !== expected.length ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(expected))
    )
      throw new ForbiddenException('执行器身份无效');
  }
  async callback(id: string, value: unknown) {
    if (!uuidPattern.test(id)) throw new BadRequestException('任务编号无效');
    const input = object(value);
    return this.transactions.execute(
      async (tx) => {
        await this.repository.lock(tx);
        const job = await this.repository.active(tx, id);
        const accountKey = input.accountKey;
        if (input.type === 'resolve_unknown_payment') {
          return completeUnknownPaymentResolution({
            tx,
            job,
            callback: input,
            repository: this.repository,
            audit: this.audit
          });
        }
        if (input.type === 'restore') {
          if (
            typeof accountKey !== 'string' ||
            !/^[a-f0-9]{64}$/.test(accountKey) ||
            (job.accountKey && job.accountKey !== accountKey)
          )
            throw new BadRequestException('账户标识不一致');
          const records = await this.repository.records(tx, accountKey);
          if (records.some((record) => record.ownerId !== job.ownerId))
            throw new ForbiddenException('该账户属于另一操作人的原任务');
          if (job.chatgptAccountId && this.bankAccounts) {
            await this.bankAccounts.assertOfficialAccount(tx, job.chatgptAccountId, accountKey);
          }
          const finished = await this.repository.finishedJobsForAccount(
            tx,
            job.ownerId,
            accountKey,
            job.id
          );
          const staleProfiles = finished
            .map((item) => staleProfile(item))
            .filter((item): item is { sourceJobId: string; profileId: string } => Boolean(item));
          await this.repository.updateJob(tx, id, { accountKey });
          return { records, staleProfiles };
        }
        if (input.type === 'stale_profile_cleanup') {
          if (
            typeof accountKey !== 'string' ||
            !/^[a-f0-9]{64}$/.test(accountKey) ||
            job.accountKey !== accountKey ||
            !Array.isArray(input.profiles) ||
            input.profiles.length < 1 ||
            input.profiles.length > 30
          )
            throw new BadRequestException('历史窗口清理回执无效');
          const requested = input.profiles.map((value) => {
            const item = object(value);
            if (
              typeof item.sourceJobId !== 'string' ||
              !uuidPattern.test(item.sourceJobId) ||
              !isBrowserProfileId(item.profileId)
            )
              throw new BadRequestException('历史窗口清理回执无效');
            return { sourceJobId: item.sourceJobId, profileId: item.profileId };
          });
          if (new Set(requested.map((item) => item.sourceJobId)).size !== requested.length)
            throw new BadRequestException('历史窗口清理回执重复');
          const finished = await this.repository.finishedJobsForAccount(
            tx,
            job.ownerId,
            accountKey,
            job.id
          );
          const byId = new Map(finished.map((item) => [item.id, item]));
          let updated = 0;
          for (const item of requested) {
            const source = byId.get(item.sourceJobId);
            const eligible = source ? staleProfile(source, true) : null;
            if (!source || !eligible || eligible.profileId !== item.profileId)
              throw new ConflictException('历史失败窗口归属无法核验');
            const before = object(source.result);
            if (before.browser_cleanup_status === 'completed') continue;
            await this.repository.updateJob(tx, source.id, {
              result: toV2JsonDocument({
                ...before,
                browser_cleanup_status: 'completed',
                stale_cleanup_job_id: job.id
              })
            });
            updated += 1;
          }
          await this.audit.append(tx, {
            userId: job.ownerId,
            module: 'id_business_v2',
            action: 'id_business_v2.auto_recharge.stale_browser_cleanup',
            objectType: 'recharge_job',
            objectId: id,
            afterData: { requested: requested.length, updated },
            remark: '已核验并清理同账号历史付款前失败窗口'
          });
          return { ok: true, updated };
        }
        if (input.type === 'ledger') {
          if (
            !job.accountKey ||
            job.accountKey !== accountKey ||
            typeof input.fileKey !== 'string' ||
            !/^(?:payments\/)?[a-f0-9]{64}(?:-pro-(?:5x|20x))?\.json$/.test(input.fileKey) ||
            !Number.isSafeInteger(input.revision) ||
            Number(input.revision) < 0
          )
            throw new BadRequestException('原订单记录无效');
          const document = safeDocument(input.document);
          if (
            input.fileKey.startsWith('payments/') &&
            !(
              (['prepare', 'flow', 'server'].includes(job.action) && job.state === 'confirming') ||
              (job.action === 'bitbrowser' &&
                ['running', 'awaiting_human_verification'].includes(job.state)) ||
              job.action === 'recheck'
            )
          ) {
            throw new ConflictException('尚未确认报价，不能记录或提交付款');
          }
          const saved = await this.repository.saveRecord(tx, {
            accountKey: job.accountKey,
            ownerId: job.ownerId,
            fileKey: input.fileKey,
            revision: Number(input.revision),
            document,
            allowCheckoutReplacement: canReplaceCheckout(job)
          });
          await consumeRechargeAddress({
            tx,
            rechargeJobId: id,
            job,
            report: document,
            addressRepository: this.addressRepository,
            audit: this.audit
          });
          await this.audit.append(tx, {
            userId: job.ownerId,
            module: 'id_business_v2',
            action: 'id_business_v2.auto_recharge.ledger',
            objectType: 'recharge_job',
            objectId: id,
            afterData: {
              fileKey: input.fileKey,
              revision: saved.revision,
              stage: String(document.stage ?? 'unknown')
            },
            remark: '官网请求标记或原单核验结果已持久化'
          });
          return saved;
        }
        if (
          !['progress', 'details_required', 'confirmation', 'finished'].includes(String(input.type))
        )
          throw new BadRequestException('执行事件无效');
        if (job.state === 'finished') {
          if (input.type === 'finished') return { ok: true };
          throw new ConflictException('已结束任务不能再写入执行事件');
        }
        const report = safeDocument(input.result);
        await bindSavedChatgptAccount(tx, job, report, this.bankAccounts);
        if (input.type === 'progress')
          await recordServerLoginNetwork(tx, job, report, this.bankAccounts);
        if (job.action === 'server') delete report.network;
        let state = job.state;
        let nonceHash = job.nonceHash;
        if (input.type === 'progress' && job.action === 'bitbrowser') {
          state = [
            'verification_required',
            'bank_verification_required',
            'login_code_required'
          ].includes(String(report.stage))
            ? 'awaiting_human_verification'
            : 'running';
        }
        if (input.type === 'details_required') {
          if (job.action !== 'flow' || job.state !== 'running') {
            throw new ConflictException('当前任务不能等待付款资料');
          }
          state = 'awaiting_details';
        }
        if (input.type === 'confirmation') {
          nonceHash = validateWorkerConfirmation(
            id,
            job,
            report,
            input.result,
            process.env.AUTO_RECHARGE_WORKER_TOKEN ?? ''
          );
          if (job.action === 'server') {
            const limit = object(job.result);
            const quote = object(report.quote);
            const today = object(quote.today);
            if (
              report.quote_authority !== 'official_checkout_response' ||
              quote.renewal_interval !== 'monthly' ||
              today.currency !== limit.locked_currency ||
              typeof today.amount_minor !== 'number' ||
              today.amount_minor <= 0 ||
              today.amount_minor > Number(limit.max_amount_minor)
            )
              throw new ConflictException('官网报价超出本次授权');
            await this.audit.append(tx, {
              userId: job.ownerId,
              module: 'id_business_v2',
              action: 'id_business_v2.auto_recharge.server.confirm',
              objectType: 'recharge_job',
              objectId: id,
              afterData: {
                plan: job.plan,
                currency: String(today.currency),
                amountMinor: today.amount_minor
              },
              remark: '官网报价在授权上限内，确认本次最多一次付款'
            });
          }
          state = job.action === 'server' ? 'confirming' : 'awaiting_confirmation';
        }
        if (input.type === 'finished') {
          await consumeRechargeAddress({
            tx,
            rechargeJobId: id,
            job,
            report,
            addressRepository: this.addressRepository,
            audit: this.audit
          });
          await completeCancellation(tx, job, report, this.repository, this.audit);
          const verifiedOrder = await recordVerifiedBankRecharge(tx, job, report, this.bankOrders);
          if (
            verifiedOrder?.cardId === job.cardId &&
            job.cardId &&
            job.billingNameEncrypted &&
            this.bankCards
          ) {
            const addressId = object(job.result).addressId;
            if (typeof addressId === 'string') {
              await this.bankCards.bindVerifiedBilling(
                tx,
                job.cardId,
                job.billingNameEncrypted,
                addressId,
                job.ownerId,
                job.id
              );
            }
          }
          state = 'finished';
          nonceHash = null;
        }
        await this.repository.updateJob(tx, id, {
          state,
          nonceHash,
          ...(job.action === 'bitbrowser' && input.type === 'progress'
            ? { leaseUntil: new Date(Date.now() + 45 * 60000) }
            : {}),
          result: mergeRechargeCallbackResult(job, report)
        });
        return { ok: true };
      },
      { changedScopes: ['auto-recharge'], requestId: id, retryMode: 'none' }
    );
  }
}
