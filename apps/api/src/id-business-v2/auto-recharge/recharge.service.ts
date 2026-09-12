import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException
} from '@nestjs/common';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { V2RechargeQuote } from '@apple-business/shared';
import type { AuthenticatedUser } from '../../auth/auth.types';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  toV2JsonDocument
} from '../runtime/public-api';
import { RechargeRepository } from './persistence/recharge.repository';
import { RechargeAddressRepository } from './persistence/recharge-address.repository';
import {
  RECHARGE_ADDRESS_LOCATION,
  validateRechargeAddressImport,
  validateRechargeAddressListQuery,
  validateRechargeAddressStatus
} from './recharge-address-validation';
import {
  assertFinalQuote,
  confirmationNonce,
  hash,
  object,
  safeDocument,
  uuidPattern,
  validateDetailsSubmission,
  validateStart
} from './recharge-validation';

@Injectable()
export class RechargeService {
  constructor(
    private readonly repository: RechargeRepository,
    private readonly addressRepository: RechargeAddressRepository,
    private readonly transactions: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService
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
    const items = await this.repository.list(operator.id);
    return {
      items: items.map((job) => ({
        ...job,
        nonceHash: undefined,
        accountKey: undefined,
        state:
          job.state !== 'finished' && job.leaseUntil.getTime() < Date.now() ? 'unknown' : job.state,
        result: this.resultWithConfirmation(job)
      })),
      configured: this.configured()
    };
  }

  private configured() {
    return (process.env.AUTO_RECHARGE_WORKER_TOKEN?.length ?? 0) >= 32;
  }

  private resultWithConfirmation(job: {
    id: string;
    state: string;
    nonceHash: string | null;
    result: unknown;
  }) {
    const result = object(job.result);
    if (job.state !== 'awaiting_confirmation' || !job.nonceHash || !result.quote) return result;
    try {
      const nonce = confirmationNonce(
        job.id,
        result.quote as V2RechargeQuote,
        process.env.AUTO_RECHARGE_WORKER_TOKEN ?? ''
      );
      return hash(nonce) === job.nonceHash ? { ...result, nonce } : result;
    } catch {
      return result;
    }
  }

  private async workerReceipt(
    id: string
  ): Promise<Record<string, unknown> & { knownMissing: boolean }> {
    const base = process.env.AUTO_RECHARGE_WORKER_URL ?? 'http://auto-recharge:8051';
    try {
      const response = await fetch(`${base}/jobs/${id}/status`, {
        redirect: 'error',
        headers: { 'X-Recharge-Worker': process.env.AUTO_RECHARGE_WORKER_TOKEN! },
        signal: AbortSignal.timeout(3000)
      });
      if (response.status === 404) return { knownMissing: true };
      if (!response.ok) return { knownMissing: false };
      const value = (await response.json()) as Record<string, unknown>;
      return { knownMissing: false, ...value };
    } catch {
      return { knownMissing: false };
    }
  }

  private async worker(
    path: string,
    body: object,
    id: string,
    receipt: 'accepted' | 'details_received' | 'confirmation_received' | 'cancelled'
  ): Promise<'accepted' | 'not_received' | 'unknown'> {
    if (!this.configured()) throw new ServiceUnavailableException('服务器执行器尚未配置');
    const base = process.env.AUTO_RECHARGE_WORKER_URL ?? 'http://auto-recharge:8051';
    try {
      const response = await fetch(base + path, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
          'X-Recharge-Worker': process.env.AUTO_RECHARGE_WORKER_TOKEN!
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000)
      });
      if (response.ok) return 'accepted';
    } catch {
      /* 只读查询本次编号，不重发写请求。 */
    }
    const status = await this.workerReceipt(id);
    if (status[receipt] === true) return 'accepted';
    return status.knownMissing ? 'not_received' : 'unknown';
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
    if (!this.configured()) throw new ServiceUnavailableException('服务器执行器尚未配置');
    const input = validateStart(value);
    const result = await this.transactions.execute(
      async (tx) => {
        await this.repository.lock(tx);
        const previous = await this.repository.findJob(tx, input.id);
        if (previous) {
          if (previous.ownerId !== operator.id) throw new ForbiddenException('无权访问此任务');
          if (previous.plan !== input.plan || previous.action !== input.action) {
            throw new ConflictException('同一操作编号不能更换套餐或步骤');
          }
          if (input.action === 'prepare' && object(previous.result).addressId !== input.addressId) {
            throw new ConflictException('同一操作编号不能更换账单地址');
          }
          return { job: previous, created: false, address: null };
        }
        const active = await this.repository.findRunningJob(tx);
        if (active) throw new ConflictException('已有一笔任务执行中，请先查看执行记录');
        const address =
          input.action === 'prepare'
            ? await this.addressRepository.requireUnused(tx, operator.id, input.addressId!)
            : null;
        const job = await this.repository.createJob(tx, {
          id: input.id,
          ownerId: operator.id,
          plan: input.plan,
          action: input.action,
          state: 'running',
          result: toV2JsonDocument(address ? { addressId: address.id } : {}),
          leaseUntil: new Date(Date.now() + 16 * 60000)
        });
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.auto_recharge.start',
          objectType: 'recharge_job',
          objectId: job.id,
          afterData: {
            plan: input.plan,
            action: input.action,
            ...(address ? { addressId: address.id } : {})
          },
          remark: '启动单笔订阅操作'
        });
        return { job, created: true, address };
      },
      { changedScopes: ['auto-recharge'], requestId: input.id, operator, retryMode: 'none' }
    );
    if (result.created) {
      try {
        const workerInput = { ...input };
        delete workerInput.addressId;
        if (input.action === 'prepare' && input.details && result.address) {
          workerInput.details = {
            ...input.details,
            country: result.address.country,
            line1: result.address.line1,
            line2: '',
            city: result.address.city,
            state: result.address.state,
            postal_code: result.address.postalCode
          };
        }
        const receipt = await this.worker('/jobs/' + input.id, workerInput, input.id, 'accepted');
        if (receipt !== 'accepted') {
          await this.finishUnreceivedJob(input.id, operator.id, receipt === 'unknown');
          throw new ServiceUnavailableException(
            receipt === 'unknown'
              ? '执行器接收结果待核验，系统不会自动重发'
              : '执行器未接收本次任务，请重新开始'
          );
        }
      } finally {
        input.sessionJson = '';
        if (input.details)
          Object.keys(input.details).forEach((key) => {
            input.details![key as keyof typeof input.details] = '';
          });
      }
    }
    return { id: result.job.id };
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
      const receipt = await this.worker(
        `/jobs/${id}/details`,
        {
          details: {
            ...input.details,
            country: selected.country,
            line1: selected.line1,
            line2: '',
            city: selected.city,
            state: selected.state,
            postal_code: selected.postalCode
          }
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
      Object.keys(input.details).forEach((key) => {
        input.details[key as keyof typeof input.details] = '';
      });
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
    const receipt = await this.worker(
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
    await this.worker('/jobs/' + id + '/cancel', {}, id, 'cancelled');
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
        const markAddressUsed = async (report: Record<string, unknown>) => {
          if (object(job.result).recheck_only === true) return;
          const addressConsumed =
            report.status === 'subscription_activated' ||
            (report.payment_attempted === true &&
              Number(report.confirmation_requests_sent) === 1) ||
            Number(report.payment_requests_sent) === 1;
          if (!['prepare', 'flow', 'bitbrowser'].includes(job.action) || !addressConsumed) return;
          const addressId = object(job.result).addressId;
          if (typeof addressId !== 'string' || !uuidPattern.test(addressId)) {
            throw new ConflictException('本次充值地址记录不完整');
          }
          const changed = await this.addressRepository.markUsed(tx, job.ownerId, addressId);
          if (!changed.changed) return;
          await this.audit.append(tx, {
            userId: job.ownerId,
            module: 'id_business_v2',
            action: 'id_business_v2.auto_recharge.addresses.consume',
            objectType: 'recharge_address',
            objectId: addressId,
            beforeData: { status: changed.before.status },
            afterData: { status: changed.after.status, rechargeJobId: id },
            remark: '账单地址已用于本次官方付款请求，自动标记已使用'
          });
        };
        const accountKey = input.accountKey;
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
          await this.repository.updateJob(tx, id, { accountKey });
          return { records };
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
              (['prepare', 'flow'].includes(job.action) && job.state === 'confirming') ||
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
            allowCheckoutReplacement: job.action === 'quote'
          });
          await markAddressUsed(document);
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
        const report = safeDocument(input.result);
        let state = job.state;
        let nonceHash = job.nonceHash;
        if (input.type === 'progress' && job.action === 'bitbrowser') {
          state = ['verification_required', 'bank_verification_required'].includes(
            String(report.stage)
          )
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
          const nonce = object(input.result).nonce;
          const quote = object(report.quote) as unknown as V2RechargeQuote;
          assertFinalQuote(quote, job.plan, report.quote_authority);
          const expected = confirmationNonce(
            id,
            quote,
            process.env.AUTO_RECHARGE_WORKER_TOKEN ?? ''
          );
          if (
            !['prepare', 'flow'].includes(job.action) ||
            job.state !== 'running' ||
            typeof nonce !== 'string' ||
            !/^[a-f0-9]{64}$/.test(nonce) ||
            nonce.length !== expected.length ||
            !timingSafeEqual(Buffer.from(nonce), Buffer.from(expected))
          )
            throw new ConflictException('不能确认当前报价');
          nonceHash = hash(nonce);
          state = 'awaiting_confirmation';
        }
        if (input.type === 'finished') {
          await markAddressUsed(report);
          state = 'finished';
          nonceHash = null;
        }
        await this.repository.updateJob(tx, id, {
          state,
          nonceHash,
          result: toV2JsonDocument({ ...object(job.result), ...report })
        });
        return { ok: true };
      },
      { changedScopes: ['auto-recharge'], requestId: id, retryMode: 'none' }
    );
  }
}
