import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import type { OnlineRechargeTask } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import type { AuthenticatedUser } from '../../../auth/auth.types';
import { FieldEncryptionService } from '../../../common/crypto/field-encryption.service';
import { BankRechargeOnlineOrderService } from '../../auto-recharge/public-api';
import { isPrismaErrorCode, type V2CommandTransaction } from '../../runtime/public-api';
import { OnlineRechargeRepository } from './online-recharge.repository';
import { verifiedOnlineOrderFact } from '../order-sync-facts';
import { ONLINE_RECHARGE_PERMISSION } from '../contracts';
import { id, object, sessionAccountId } from '../validation';

type PreviewItem = {
  taskId: string;
  status: 'eligible' | 'existing' | 'insufficient';
  reasonCode: string;
  orderId?: string;
  orderNo?: string;
};
type Preview = {
  actorId: string;
  expiresAt: number;
  tasks: { id: string; version: string; leaseVersion: number }[];
};

@Injectable()
export class OnlineRechargeOrderSyncRepository {
  private polling = false;
  private readonly previews = new Map<string, Preview>();
  constructor(
    private readonly repository: OnlineRechargeRepository,
    private readonly encryption: FieldEncryptionService,
    private readonly orders: BankRechargeOnlineOrderService
  ) {}

  /** Called in the original successful task transaction; it never invokes a worker. */
  async enqueueInTransaction(tx: V2CommandTransaction, taskId: string) {
    await tx.onlineRechargeOrderSync.upsert({
      where: { taskId },
      create: { taskId },
      update: {}
    });
  }

  async summary(taskId: string, tx?: V2CommandTransaction) {
    const work = async (db: Pick<V2CommandTransaction, 'onlineRechargeTask'>) => {
      const task = await db.onlineRechargeTask.findUnique({
        where: { id: taskId },
        select: {
          operation: true,
          status: true,
          orderSync: { select: { status: true, lastErrorCode: true } },
          rechargeOrder: { select: { id: true, orderNo: true } }
        }
      });
      if (task?.rechargeOrder)
        return {
          status: 'synced' as const,
          orderId: task.rechargeOrder.id,
          orderNo: task.rechargeOrder.orderNo
        };
      if (task?.orderSync)
        return {
          status: task.orderSync.status,
          ...(task.orderSync.lastErrorCode ? { errorCode: task.orderSync.lastErrorCode } : {})
        };
      return {
        status:
          task?.operation === 'recharge' && task.status === 'succeeded'
            ? ('needs_review' as const)
            : ('not_applicable' as const),
        ...(task?.operation === 'recharge' && task.status === 'succeeded'
          ? { errorCode: 'ORDER_SYNC_NOT_QUEUED' }
          : {})
      };
    };
    return tx ? work(tx) : this.repository.read(work);
  }

  private fact(
    task: OnlineRechargeTask,
    card: Parameters<typeof verifiedOnlineOrderFact>[2] = null
  ) {
    try {
      return verifiedOnlineOrderFact(
        task,
        sessionAccountId(this.encryption.decrypt(task.sessionEncrypted)),
        card
      );
    } catch {
      return { eligible: false as const, reasonCode: 'SESSION_IDENTITY_UNAVAILABLE' };
    }
  }

  async enqueue(taskId: string, operator: AuthenticatedUser) {
    this.assertAdmin(operator, true);
    await this.repository.transaction(`task:${taskId}`, async (tx) => {
      const task = await tx.onlineRechargeTask.findUnique({
        where: { id: taskId },
        include: { rechargeOrder: { select: { id: true } } }
      });
      if (!task) throw new NotFoundException('任务不存在');
      if (task.rechargeOrder) return;
      const source = this.fact(task);
      if (!source.eligible) throw new ConflictException('原任务尚无完整成功证据，不能补同步订单');
      await tx.onlineRechargeOrderSync.upsert({
        where: { taskId },
        create: { taskId },
        update: { status: 'pending', attempts: 0, nextAttemptAt: new Date(), lastErrorCode: null }
      });
      await this.repository.log(tx, 'orders.enqueue', operator, taskId);
    });
    return this.summary(taskId);
  }

  async processPending() {
    if (this.polling) return;
    this.polling = true;
    try {
      const pending = await this.repository.read((db) =>
        db.onlineRechargeOrderSync.findMany({
          where: { status: 'pending', nextAttemptAt: { lte: new Date() } },
          orderBy: [{ nextAttemptAt: 'asc' }, { taskId: 'asc' }],
          take: 20,
          select: { taskId: true }
        })
      );
      for (const { taskId } of pending) {
        try {
          await this.processOne(taskId);
        } catch (error) {
          await this.recordFailure(taskId, error).catch(() => undefined);
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private async processOne(taskId: string) {
    await this.repository.transaction(
      `task:${taskId}`,
      async (tx) => {
        const queue = await tx.onlineRechargeOrderSync.findUnique({ where: { taskId } });
        if (!queue || queue.status !== 'pending' || queue.nextAttemptAt.getTime() > Date.now())
          return;
        const task = await tx.onlineRechargeTask.findUnique({
          where: { id: taskId },
          include: { rechargeOrder: { select: { id: true } } }
        });
        if (task?.rechargeOrder) {
          await tx.onlineRechargeOrderSync.update({
            where: { taskId },
            data: { status: 'synced', attempts: { increment: 1 }, lastErrorCode: null }
          });
          await this.repository.log(tx, 'orders.synced_existing', undefined, taskId, {
            orderId: task.rechargeOrder.id
          });
          return;
        }
        const card = task?.cardId
          ? await tx.onlineRechargeCard.findUnique({
              where: { id: task.cardId },
              select: { id: true, last4: true, holderName: true }
            })
          : null;
        const source = task ? this.fact(task, card) : null;
        if (!source?.eligible) {
          const code = source && !source.eligible ? source.reasonCode : 'TASK_MISSING';
          await tx.onlineRechargeOrderSync.update({
            where: { taskId },
            data: { status: 'needs_review', attempts: { increment: 1 }, lastErrorCode: code }
          });
          await this.repository.log(tx, 'orders.needs_review', undefined, taskId, { code });
          return;
        }
        const order = await this.orders.syncInTransaction(tx, source.fact);
        await tx.onlineRechargeOrderSync.update({
          where: { taskId },
          data: { status: 'synced', attempts: { increment: 1 }, lastErrorCode: null }
        });
        await this.repository.log(tx, 'orders.synced', undefined, taskId, { orderId: order.id });
      },
      ['online-recharge', 'auto-recharge']
    );
  }

  private async recordFailure(taskId: string, error: unknown) {
    const conflict = error instanceof ConflictException || error instanceof BadRequestException;
    const duplicate = isPrismaErrorCode(error, 'P2002');
    const code = conflict
      ? 'ORDER_EVIDENCE_CONFLICT'
      : duplicate
        ? 'ORDER_DUPLICATE_CONFLICT'
        : 'ORDER_SYNC_TEMPORARY_FAILURE';
    await this.repository.transaction(`task:${taskId}`, async (tx) => {
      const queue = await tx.onlineRechargeOrderSync.findUnique({ where: { taskId } });
      if (!queue || queue.status !== 'pending') return;
      const attempts = queue.attempts + 1;
      await tx.onlineRechargeOrderSync.update({
        where: { taskId },
        data: {
          status: conflict || duplicate || attempts >= 5 ? 'needs_review' : 'pending',
          attempts,
          nextAttemptAt: new Date(Date.now() + Math.min(3600, 10 * 2 ** (attempts - 1)) * 1000),
          lastErrorCode: code
        }
      });
      await this.repository.log(tx, 'orders.sync_failed', undefined, taskId, { code, attempts });
    });
  }

  async preview(raw: unknown, operator: AuthenticatedUser) {
    this.assertAdmin(operator);
    const input = object(raw);
    const cursor = input.cursor ? id(input.cursor) : null;
    for (const [key, value] of this.previews)
      if (value.expiresAt <= Date.now()) this.previews.delete(key);
    if (this.previews.size >= 200) throw new ConflictException('预览较多，请稍后重试');
    const items: PreviewItem[] = [];
    const selected: Preview['tasks'] = [];
    const counts = { total: 0, eligible: 0, existing: 0, insufficient: 0 };
    let scanCursor: string | null = null;
    let nextCursor: string | null = null;
    do {
      const batch = await this.repository.read((db) =>
        db.onlineRechargeTask.findMany({
          where: {
            operation: 'recharge',
            status: 'succeeded',
            ...(scanCursor ? { id: { gt: scanCursor } } : {})
          },
          orderBy: { id: 'asc' },
          take: 500,
          include: { rechargeOrder: { select: { id: true, orderNo: true } } }
        })
      );
      for (const task of batch) {
        const source = task.rechargeOrder ? null : this.fact(task);
        const item: PreviewItem = task.rechargeOrder
          ? {
              taskId: task.id,
              status: 'existing',
              reasonCode: 'ORDER_EXISTS',
              orderId: task.rechargeOrder.id,
              orderNo: task.rechargeOrder.orderNo
            }
          : source?.eligible
            ? { taskId: task.id, status: 'eligible', reasonCode: 'VERIFIED_SUCCESS' }
            : {
                taskId: task.id,
                status: 'insufficient',
                reasonCode: source && !source.eligible ? source.reasonCode : 'TASK_MISSING'
              };
        counts.total++;
        counts[item.status]++;
        if ((!cursor || task.id > cursor) && items.length < 100) {
          items.push(item);
          selected.push({
            id: task.id,
            version: task.updatedAt.toISOString(),
            leaseVersion: task.leaseVersion
          });
        } else if ((!cursor || task.id > cursor) && items.length === 100) {
          nextCursor = items[items.length - 1]!.taskId;
        }
      }
      scanCursor = batch.length === 500 ? batch[batch.length - 1]!.id : null;
    } while (scanCursor);
    const previewToken = randomBytes(32).toString('base64url');
    this.previews.set(previewToken, {
      actorId: operator.id,
      expiresAt: Date.now() + 10 * 60000,
      tasks: selected
    });
    return { items, ...counts, previewToken, nextCursor };
  }

  async backfill(raw: unknown, operator: AuthenticatedUser) {
    this.assertAdmin(operator, true);
    const token = object(raw).previewToken;
    const preview = typeof token === 'string' ? this.previews.get(token) : undefined;
    if (!preview || preview.actorId !== operator.id || preview.expiresAt <= Date.now())
      throw new ConflictException('预览已失效，请重新生成补录预览');
    this.previews.delete(String(token));
    const counts = { queued: 0, existing: 0, skipped: 0 };
    for (const selected of preview.tasks) {
      const state = await this.repository.transaction(`task:${selected.id}`, async (tx) => {
        const task = await tx.onlineRechargeTask.findUnique({
          where: { id: selected.id },
          include: { rechargeOrder: { select: { id: true } } }
        });
        if (task?.rechargeOrder) return 'existing' as const;
        if (
          !task ||
          task.updatedAt.toISOString() !== selected.version ||
          task.leaseVersion !== selected.leaseVersion ||
          !this.fact(task).eligible
        )
          return 'skipped' as const;
        await tx.onlineRechargeOrderSync.upsert({
          where: { taskId: task.id },
          create: { taskId: task.id },
          update: { status: 'pending', attempts: 0, nextAttemptAt: new Date(), lastErrorCode: null }
        });
        await this.repository.log(tx, 'orders.backfill_enqueue', operator, task.id);
        return 'queued' as const;
      });
      counts[state]++;
    }
    return counts;
  }

  private assertAdmin(operator: AuthenticatedUser, write = false) {
    if (
      !operator.roles.includes('admin') ||
      !operator.permissions.includes(ONLINE_RECHARGE_PERMISSION.read) ||
      (write && !operator.permissions.includes(ONLINE_RECHARGE_PERMISSION.manage))
    )
      throw new ForbiddenException('订单同步需要管理员及对应的线上代充权限');
  }
}
