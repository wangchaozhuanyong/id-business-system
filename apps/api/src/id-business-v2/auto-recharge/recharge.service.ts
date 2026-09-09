import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  toV2JsonDocument
} from '../runtime/public-api';
import { RechargeRepository } from './persistence/recharge.repository';
import { hash, object, safeDocument, uuidPattern, validateStart } from './recharge-validation';

@Injectable()
export class RechargeService {
  constructor(
    private readonly repository: RechargeRepository,
    private readonly transactions: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService
  ) {}

  async list(operator: AuthenticatedUser) {
    const items = await this.repository.list(operator.id);
    return {
      items: items.map((job) => ({
        ...job,
        nonceHash: undefined,
        accountKey: undefined,
        state:
          job.state !== 'finished' && job.leaseUntil.getTime() < Date.now() ? 'unknown' : job.state,
        result: this.confirmations.has(job.id)
          ? { ...object(job.result), nonce: this.confirmations.get(job.id) }
          : job.result
      })),
      configured: this.configured()
    };
  }

  private readonly confirmations = new Map<string, string>();
  private configured() {
    return (process.env.AUTO_RECHARGE_WORKER_TOKEN?.length ?? 0) >= 32;
  }

  private async worker(path: string, body: object) {
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
      if (!response.ok) throw new Error();
    } catch {
      throw new ServiceUnavailableException('执行器未确认接收，请核验原任务；系统不会自动重发');
    }
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
          return { job: previous, created: false };
        }
        const active = await this.repository.findRunningJob(tx);
        if (active) throw new ConflictException('已有一笔任务执行中，请先查看执行记录');
        const job = await this.repository.createJob(tx, {
          id: input.id,
          ownerId: operator.id,
          plan: input.plan,
          action: input.action,
          state: 'running',
          result: {},
          leaseUntil: new Date(Date.now() + 16 * 60000)
        });
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.auto_recharge.start',
          objectType: 'recharge_job',
          objectId: job.id,
          afterData: { plan: input.plan, action: input.action },
          remark: '启动单笔订阅操作'
        });
        return { job, created: true };
      },
      { changedScopes: ['auto-recharge'], requestId: input.id, operator, retryMode: 'none' }
    );
    if (result.created) {
      try {
        await this.worker('/jobs/' + input.id, input);
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
        await this.repository.updateJob(tx, id, { state: 'confirming', nonceHash: null });
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
    this.confirmations.delete(id);
    await this.worker('/jobs/' + id + '/confirm', { nonce });
    return { id };
  }

  async cancel(id: string, operator: AuthenticatedUser) {
    const job = await this.repository.owned(id, operator.id);
    if (job.state === 'confirming') throw new ConflictException('付款已确认，只能等待或复查原订单');
    await this.worker('/jobs/' + id + '/cancel', {});
    this.confirmations.delete(id);
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
            !((job.action === 'prepare' && job.state === 'confirming') || job.action === 'recheck')
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
        if (!['progress', 'confirmation', 'finished'].includes(String(input.type)))
          throw new BadRequestException('执行事件无效');
        const report = safeDocument(input.result);
        let state = job.state;
        let nonceHash = job.nonceHash;
        if (input.type === 'confirmation') {
          const nonce = object(input.result).nonce;
          if (
            job.action !== 'prepare' ||
            job.state !== 'running' ||
            typeof nonce !== 'string' ||
            !/^[a-f0-9]{64}$/.test(nonce) ||
            !object(report.quote).today
          )
            throw new ConflictException('不能确认当前报价');
          this.confirmations.set(id, nonce);
          nonceHash = hash(nonce);
          state = 'awaiting_confirmation';
        }
        if (input.type === 'finished') {
          state = 'finished';
          nonceHash = null;
          this.confirmations.delete(id);
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
