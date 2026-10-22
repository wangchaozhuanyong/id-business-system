import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  type OnModuleDestroy
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type { OnlineRechargeWorkerRpc } from './contracts';
import { OnlineRechargeRepository } from './persistence/online-recharge.repository';
import { OnlineRechargeWorkerRepository, requireTaskLease } from './persistence/worker.repository';
import { id, object } from './validation';

type Command = {
  sequence: number;
  kind: 'click' | 'continue';
  frameId?: string;
  x?: number;
  y?: number;
};
type Screen = { frameId: string; image: string; width: number; height: number };
type Entry = {
  scope: OnlineRechargeWorkerRpc;
  generation: string;
  deadline: number;
  owner?: string;
  seenAt: number;
  screenAt: number;
  sequence: number;
  screen?: Screen;
  command?: Command;
  stopped: boolean;
};

// Short lived, process-local relay. No browser endpoint or login credential leaves the worker.
@Injectable()
export class OnlineRechargeHumanVerification implements OnModuleDestroy {
  private readonly entries = new Map<string, Entry>();
  private readonly timer = setInterval(() => {
    for (const [key, entry] of this.entries) {
      this.expire(entry);
      if (Date.now() > entry.deadline + 10000) this.entries.delete(key);
    }
  }, 1000).unref();

  constructor(
    private readonly workers: OnlineRechargeWorkerRepository,
    private readonly repository: OnlineRechargeRepository
  ) {}

  onModuleDestroy() {
    clearInterval(this.timer);
    this.entries.clear();
  }

  private stop(entry: Entry) {
    entry.stopped = true;
    entry.screen = undefined;
    entry.command = undefined;
  }
  private expire(entry: Entry) {
    if (Date.now() >= entry.deadline || (entry.owner && Date.now() - entry.seenAt > 15000))
      this.stop(entry);
  }
  private view(entry: Entry, operatorId: string) {
    this.expire(entry);
    if (entry.stopped) return { available: false };
    const owned = entry.owner === operatorId;
    return {
      available: true,
      generation: entry.generation,
      deadline: entry.deadline,
      owned,
      busy: Boolean(entry.owner && !owned),
      pending: Boolean(entry.command),
      ...(owned && Date.now() - entry.screenAt <= 3000 ? { screen: entry.screen } : {})
    };
  }
  private requireEntry(taskId: string, generation: unknown) {
    const entry = this.entries.get(taskId);
    if (!entry || entry.generation !== generation) throw new ConflictException('人工验证已失效');
    this.expire(entry);
    return entry;
  }
  private assertBeforePayment(row: {
    status: string;
    operation: string;
    provider: string;
    paymentStarted: boolean;
    confirmedPaid: boolean;
    providerOrderId: string | null;
    providerTaskId: string | null;
  }) {
    if (
      row.status !== 'running' ||
      !['recharge', 'debug'].includes(row.operation) ||
      row.provider === 'third_party' ||
      row.paymentStarted ||
      row.confirmedPaid ||
      row.providerOrderId ||
      row.providerTaskId
    )
      throw new ConflictException('本任务不处于付款前登录验证阶段');
  }

  private exchange(rpc: OnlineRechargeWorkerRpc) {
    const args = rpc.args ?? {};
    const entry = this.requireEntry(id(rpc.taskId), args.generation);
    if (
      entry.scope.workerId !== rpc.workerId ||
      entry.scope.leaseId !== rpc.leaseId ||
      entry.scope.leaseVersion !== rpc.leaseVersion
    )
      throw new ConflictException('人工验证租约已变化');
    if (entry.stopped) return { stopped: true };
    if (rpc.method === 'humanVerificationAuthorize') {
      if (!entry.owner || entry.command?.sequence !== args.sequence)
        throw new ConflictException('人工验证操作已失效');
      return { authorized: true };
    }
    if (rpc.method !== 'humanVerificationPoll')
      throw new BadRequestException('不支持的人工验证操作');
    if (entry.command && args.ack === entry.command.sequence) entry.command = undefined;
    if (args.screen && !entry.command) {
      const screen = object(args.screen);
      const image = String(screen.image ?? '');
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(image) || image.length > 350000)
        throw new BadRequestException('验证画面无效');
      const png = Buffer.from(image, 'base64');
      const width = Number(screen.width),
        height = Number(screen.height);
      if (
        png.length < 24 ||
        png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
        !Number.isInteger(width) ||
        !Number.isInteger(height) ||
        width < 5 ||
        height < 5 ||
        width > 1400 ||
        height > 1000 ||
        png.readUInt32BE(16) !== width ||
        png.readUInt32BE(20) !== height ||
        typeof screen.frameId !== 'string' ||
        !/^[a-f0-9-]{36}$/.test(screen.frameId)
      )
        throw new BadRequestException('验证画面尺寸无效');
      entry.screen = { frameId: screen.frameId, image, width, height };
      entry.screenAt = Date.now();
    }
    return { stopped: false, command: entry.command ?? null };
  }

  async worker(rpc: OnlineRechargeWorkerRpc) {
    const taskId = id(rpc.taskId);
    const args = rpc.args ?? {};
    if (['humanVerificationPoll', 'humanVerificationAuthorize'].includes(rpc.method))
      return this.repository.read(async (db) => {
        const row = requireTaskLease(
          await db.onlineRechargeTask.findUnique({ where: { id: taskId } }),
          rpc
        );
        this.assertBeforePayment(row);
        return this.exchange(rpc);
      });
    return this.workers.withLease(rpc, async (tx, row) => {
      this.assertBeforePayment(row);
      if (rpc.method === 'humanVerificationOpen') {
        const deadline = Number(args.deadline);
        if (
          !Number.isSafeInteger(deadline) ||
          deadline <= Date.now() ||
          deadline > Date.now() + 120000
        )
          throw new BadRequestException('人工验证期限无效');
        if (this.entries.has(taskId)) throw new ConflictException('本任务已经使用过人工验证');
        await tx.onlineRechargeTask.update({
          where: { id: taskId },
          data: {
            stage: 'human_verification',
            progress: 10,
            message: '官网需要本人验证，请在剩余期限内打开任务详情完成验证'
          }
        });
        await this.repository.log(tx, 'human_verification.wait', undefined, taskId);
        const generation = randomUUID();
        this.entries.set(taskId, {
          scope: rpc,
          generation,
          deadline,
          seenAt: Date.now(),
          screenAt: 0,
          sequence: 0,
          stopped: false
        });
        return { generation, deadline };
      }
      const entry = this.requireEntry(taskId, args.generation);
      if (
        entry.scope.workerId !== rpc.workerId ||
        entry.scope.leaseId !== rpc.leaseId ||
        entry.scope.leaseVersion !== rpc.leaseVersion
      )
        throw new ConflictException('人工验证租约已变化');
      if (rpc.method === 'humanVerificationClose') {
        this.stop(entry);
        await this.repository.log(tx, 'human_verification.close', undefined, taskId);
        return { stopped: true };
      }
      throw new BadRequestException('不支持的人工验证操作');
    });
  }

  async admin(taskRaw: unknown, raw: unknown, operator: AuthenticatedUser) {
    if (
      !operator.roles.includes('admin') &&
      !operator.permissions.includes('id_business_v2.online_recharge.manage')
    )
      throw new ForbiddenException('没有管理线上代充的权限');
    const taskId = id(taskRaw),
      input = object(raw);
    const action = String(input.action ?? 'view');
    if (!['view', 'claim', 'click', 'continue', 'cancel'].includes(action))
      throw new BadRequestException('不支持的人工验证操作');
    if (action === 'view')
      return this.repository.read(async (db) => {
        const entry = this.entries.get(taskId);
        if (!entry) return { available: false };
        const row = requireTaskLease(
          await db.onlineRechargeTask.findUnique({ where: { id: taskId } }),
          entry.scope
        );
        this.assertBeforePayment(row);
        this.expire(entry);
        if (!entry.stopped && entry.owner === operator.id) entry.seenAt = Date.now();
        return this.view(entry, operator.id);
      });
    let afterCommit: (() => void) | undefined;
    let currentEntry: Entry | undefined;
    const result = await this.repository.transaction(`task:${taskId}`, async (tx) => {
      const entry = this.entries.get(taskId);
      if (!entry) return { available: false };
      currentEntry = entry;
      const row = requireTaskLease(
        await tx.onlineRechargeTask.findUnique({ where: { id: taskId } }),
        entry.scope
      );
      this.assertBeforePayment(row);
      this.expire(entry);
      if (entry.stopped) return { available: false };
      if (action !== 'view') {
        if (input.generation !== entry.generation)
          throw new ConflictException('人工验证画面已变化');
        if (entry.owner && entry.owner !== operator.id)
          throw new ConflictException('其他管理员正在处理本次验证');
        if (action === 'claim' && !entry.owner) {
          await this.repository.log(tx, 'human_verification.claim', operator, taskId);
          afterCommit = () => {
            this.expire(entry);
            if (entry.stopped || (entry.owner && entry.owner !== operator.id))
              throw new ConflictException('人工验证已失效');
            entry.owner = operator.id;
            entry.seenAt = Date.now();
          };
        } else if (entry.owner !== operator.id) throw new ForbiddenException('请先接管本次验证');
        entry.seenAt = Date.now();
        if (action === 'cancel') {
          await this.repository.log(tx, 'human_verification.cancel', operator, taskId);
          afterCommit = () => this.stop(entry);
          return { available: false };
        }
        if (action === 'click' || action === 'continue') {
          if (entry.command) throw new ConflictException('上一次操作尚未确认');
          const x = Number(input.x),
            y = Number(input.y);
          if (
            action === 'click' &&
            (!entry.screen ||
              input.frameId !== entry.screen.frameId ||
              Date.now() - entry.screenAt > 3000 ||
              !Number.isFinite(x) ||
              !Number.isFinite(y) ||
              x < 0 ||
              y < 0 ||
              x >= entry.screen.width ||
              y >= entry.screen.height)
          )
            throw new ConflictException('验证画面已过期，请等待刷新');
          await this.repository.log(tx, `human_verification.${action}`, operator, taskId);
          const sequence = entry.sequence;
          const command: Command = {
            sequence: sequence + 1,
            kind: action,
            ...(action === 'click' ? { frameId: entry.screen!.frameId, x, y } : {})
          };
          // The worker can only receive a command after its audit commits.
          afterCommit = () => {
            this.expire(entry);
            if (
              entry.stopped ||
              entry.owner !== operator.id ||
              entry.command ||
              entry.sequence !== sequence
            )
              throw new ConflictException('人工验证操作已失效');
            entry.sequence = command.sequence;
            entry.command = command;
          };
        }
      } else if (entry.owner === operator.id) entry.seenAt = Date.now();
      return this.view(entry, operator.id);
    });
    afterCommit?.();
    return currentEntry ? this.view(currentEntry, operator.id) : result;
  }
}
