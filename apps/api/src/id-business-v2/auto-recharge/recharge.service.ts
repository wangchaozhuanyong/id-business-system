import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Optional
} from '@nestjs/common';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  toV2JsonDocument
} from '../runtime/public-api';
import { RechargeRepository } from './persistence/recharge.repository';
import { completeCancellation } from './recharge-cancellation';
import { RechargeAddressRepository } from './persistence/recharge-address.repository';
import { consumeRechargeAddress } from './recharge-address-consumption';
import {
  RECHARGE_ADDRESS_LOCATION,
  validateRechargeAddressImport,
  validateRechargeAddressListQuery,
  validateRechargeAddressStatus
} from './recharge-address-validation';
import {
  object,
  safeDocument,
  uuidPattern,
  validateWorkerConfirmation,
  assertFinalQuote
} from './recharge-validation';
import { completeUnknownPaymentResolution } from './recharge-resolution';
import {
  isBrowserProfileId,
  staleProfile,
  findOwnedRechargeBrowserProfile
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
import { hasOfficialRechargeQuote } from './recharge-upgrade-protocol';
import { RechargeSettingsService } from './recharge-settings.service';
import { RechargeProxyService } from './recharge-proxy.service';
import { RechargeNameService } from './recharge-name.service';
import { finalizeRechargeCardBilling } from './recharge-card-billing';
import { startRechargeJob } from './recharge-start';
import { startServerRecheck } from './recharge-server-recheck';
import { listRechargeJobs } from './recharge-job-list';
import { completeRechargeLedgerCallback } from './recharge-ledger-callback';
import { IdBusinessV2TotpAccountService } from '../workspace/public-api';
import {
  readRechargeHandoff,
  serverHandoffProgressState,
  serverQuoteConfirmationState
} from './recharge-handoff';
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
    @Optional() private readonly totpAccounts?: IdBusinessV2TotpAccountService,
    @Optional() private readonly names?: RechargeNameService
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

  async start(value: unknown, operator: AuthenticatedUser) {
    return startRechargeJob(value, operator, {});
  }

  async recheckServer(value: unknown, operator: AuthenticatedUser) {
    return startServerRecheck(value, operator, {});
  }

  async submitDetails(
    id: string,
    value: unknown,
    operator: AuthenticatedUser
  ): Promise<{ id: string }> {
    void id;
    void value;
    void operator;
    throw new ConflictException('服务器付款资料提交已停用，请在比特浏览器充值页面操作');
  }

  async confirm(id: string, nonce: unknown, operator: AuthenticatedUser): Promise<{ id: string }> {
    void id;
    void nonce;
    void operator;
    throw new ConflictException('付款确认必须通过所属本机充值助手执行');
  }
  handoffFrame(id: string, operator: AuthenticatedUser) {
    return readRechargeHandoff(id, operator, { repository: this.repository });
  }
  async handoffCommand(id: string, input: unknown, operator: AuthenticatedUser): Promise<never> {
    void id;
    void input;
    void operator;
    throw new ConflictException('服务器远程操作已停用，请在所属比特浏览器窗口处理验证');
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
          const ownedProfile =
            job.action === 'bitbrowser'
              ? findOwnedRechargeBrowserProfile(finished, job.ownerId, accountKey)
              : undefined;
          return { records, staleProfiles, ...(ownedProfile ? { ownedProfile } : {}) };
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
          return completeRechargeLedgerCallback({
            tx,
            job,
            callback: input,
            repository: this.repository,
            addressRepository: this.addressRepository,
            audit: this.audit
          });
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
        const verifiedAt =
          input.type === 'progress'
            ? await recordServerLoginNetwork(tx, job, report, this.bankAccounts)
            : undefined;
        if (job.action === 'server') delete report.network;
        let state = job.state;
        let nonceHash = job.nonceHash;
        if (input.type === 'progress' && job.action === 'bitbrowser') {
          if (report.status === 'awaiting_confirmation') {
            const quote = object(report.quote);
            const today = object(quote.today);
            const limit = object(job.result);
            assertFinalQuote(quote as never, job.plan, report.quote_authority, report);
            if (
              !job.accountKey ||
              report.account_matched !== true ||
              !/^[a-f0-9]{64}$/.test(String(report.quote_digest)) ||
              typeof report.confirmation_expires_at !== 'string' ||
              !Number.isFinite(Date.parse(report.confirmation_expires_at)) ||
              Date.parse(report.confirmation_expires_at) <= Date.now() ||
              Date.parse(report.confirmation_expires_at) > Date.now() + 10 * 60000 ||
              today.currency !== limit.locked_currency ||
              typeof today.amount_minor !== 'number' ||
              today.amount_minor <= 0 ||
              today.amount_minor > Number(limit.max_amount_minor) ||
              !Number.isSafeInteger(limit.max_amount_minor)
            )
              throw new ConflictException('本机官网报价未完整核实或超出付款上限');
            state = 'awaiting_confirmation';
            await this.audit.append(tx, {
              userId: job.ownerId,
              module: 'id_business_v2',
              action: 'id_business_v2.auto_recharge.bitbrowser.quote_verified',
              objectType: 'recharge_job',
              objectId: id,
              afterData: {
                plan: job.plan,
                currency: String(today.currency),
                amountMinor: today.amount_minor
              },
              remark: '本机官网报价已核实，等待本人在所属充值助手确认；尚未付款'
            });
          } else {
            state = [
              'verification_required',
              'bank_verification_required',
              'login_code_required'
            ].includes(String(report.stage))
              ? 'awaiting_human_verification'
              : 'running';
          }
        }
        if (input.type === 'progress' && job.action === 'server') {
          state = serverHandoffProgressState(job, report);
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
          state =
            job.action === 'server'
              ? serverQuoteConfirmationState(job.result, report)
              : 'awaiting_confirmation';
          if (job.action === 'server') {
            const limit = object(job.result);
            const quote = object(report.quote);
            const today = object(quote.today);
            if (
              !hasOfficialRechargeQuote(report) ||
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
              action:
                object(job.result).manual_payment_confirmation === true
                  ? 'id_business_v2.auto_recharge.server.quote_verified'
                  : 'id_business_v2.auto_recharge.server.confirm',
              objectType: 'recharge_job',
              objectId: id,
              afterData: {
                plan: job.plan,
                currency: String(today.currency),
                amountMinor: today.amount_minor
              },
              remark:
                object(job.result).manual_payment_confirmation === true
                  ? '官网报价在授权上限内，等待本人确认；尚未付款'
                  : '官网报价在授权上限内，确认本次最多一次付款'
            });
          }
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
          await finalizeRechargeCardBilling(tx, job, verifiedOrder, this.bankCards, this.names);
          state = 'finished';
          nonceHash = null;
        }
        const previousResult = object(job.result);
        const serverBusinessHandoff =
          job.action === 'server' &&
          job.state === 'running' &&
          input.type === 'progress' &&
          ['proxy_verifying', 'proxy_retrying'].includes(String(previousResult.stage)) &&
          report.stage === 'session_restore' &&
          previousResult.server_business_lease_started !== true;
        // API 写入一次交接标记，迟到的代理进度也不能再次延长业务期限。
        if (serverBusinessHandoff) report.server_business_lease_started = true;
        await this.repository.updateJob(tx, id, {
          state,
          nonceHash,
          ...(job.action === 'bitbrowser' && input.type === 'progress'
            ? { leaseUntil: new Date(Date.now() + 45 * 60000) }
            : serverBusinessHandoff
              ? { leaseUntil: new Date(Date.now() + 16 * 60000) }
              : {}),
          result: mergeRechargeCallbackResult(job, report, verifiedAt)
        });
        return { ok: true };
      },
      { changedScopes: ['auto-recharge'], requestId: id, retryMode: 'none' }
    );
  }
}
