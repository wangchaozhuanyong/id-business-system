import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { Prisma, type OnlineRechargeTask } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import type { AuthenticatedUser } from '../../../auth/auth.types';
import { FieldEncryptionService } from '../../../common/crypto/field-encryption.service';
import { ONLINE_RECHARGE_DEFAULTS, type OnlineRechargeOperation } from '../contracts';
import { OnlineRechargeSettingsService } from '../settings.service';
import { OnlineRechargeRepository } from './online-recharge.repository';
import { OnlineRechargeEphemeralCredentials } from '../ephemeral-credentials.service';
import { assertOnlineSensitive } from '../assets.service';
import {
  id,
  ids,
  maskEmail,
  object,
  plan,
  redact,
  sanitize,
  session,
  text,
  activeTaskStatuses
} from '../validation';

@Injectable()
export class OnlineRechargeTasksRepository {
  constructor(
    private readonly repository: OnlineRechargeRepository,
    private readonly settings: OnlineRechargeSettingsService,
    private readonly encryption: FieldEncryptionService,
    private readonly memory: OnlineRechargeEphemeralCredentials
  ) {}
  map(row: OnlineRechargeTask, publicView = false) {
    const result = sanitize(row.result);
    const base = {
      id: row.id,
      jobKey: row.id,
      operation: row.operation,
      status: row.status,
      plan: row.plan,
      provider: row.provider,
      progress: row.progress,
      stage: row.stage,
      message: redact(row.message),
      cardLast4: row.cardLast4,
      email: maskEmail(this.encryption.decrypt(row.emailEncrypted)),
      result,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    };
    return publicView
      ? { ...base, email: undefined, cardLast4: undefined }
      : {
          ...base,
          providerOrderId: row.providerOrderId,
          providerTaskId: row.providerTaskId,
          paymentStarted: row.paymentStarted,
          confirmedPaid: row.confirmedPaid,
          hasSession: Boolean(row.sessionEncrypted)
        };
  }
  async get(taskId: string, publicView = false) {
    const row = await this.repository.read((db) =>
      db.onlineRechargeTask.findUnique({ where: { id: taskId } })
    );
    if (!row) throw new NotFoundException('任务不存在');
    return this.map(row, publicView);
  }
  async publicConfig() {
    const { settings } = await this.settings.internal();
    const active = await this.repository.read((db) =>
      db.onlineRechargeTask.count({
        where: {
          operation: 'recharge',
          status: { in: ['queued', 'running', 'awaiting_credentials'] }
        }
      })
    );
    return {
      maintenance: settings.maintenance,
      maintenanceDrain: settings.maintenance === true && active > 0,
      maxConcurrent: settings.maxConcurrent,
      active,
      paymentRegion: settings.paymentRegion,
      plans: [
        { key: 'plus', label: 'Plus' },
        { key: 'pro_5x', label: 'Pro 5x' },
        { key: 'pro_20x', label: 'Pro 20x' }
      ]
    };
  }
  async verify(input: unknown) {
    const code = text(object(input).code, '兑换码', 190);
    const row = await this.repository.read((db) =>
      db.onlineRechargeCode.findUnique({ where: { codeHash: this.encryption.hash(code)! } })
    );
    if (!row || row.status === 'disabled' || row.deletedAt)
      throw new BadRequestException('兑换码无效');
    return { valid: true, plan: row.plan, status: row.status, taskId: row.taskId };
  }
  async query(input: unknown) {
    const code = text(object(input).code, '兑换码', 190);
    const row = await this.repository.read((db) =>
      db.onlineRechargeCode.findUnique({ where: { codeHash: this.encryption.hash(code)! } })
    );
    if (!row || row.status === 'disabled' || row.deletedAt)
      throw new BadRequestException('兑换码无效');
    if (!row.taskId) return { plan: row.plan, status: row.status, task: null };
    const task = await this.repository.read((db) =>
      db.onlineRechargeTask.findUnique({ where: { id: row.taskId! } })
    );
    if (!task) throw new NotFoundException('任务记录不可用');
    return {
      plan: row.plan,
      status: row.status,
      task: this.map(task, true),
      taskToken: this.encryption.decrypt(task.publicTokenEncrypted)
    };
  }
  async authorizePublic(input: unknown) {
    const value = object(input),
      taskId = id(value.id ?? value.taskId),
      token = text(value.taskToken, '任务凭证', 100);
    const row = await this.repository.read((db) =>
      db.onlineRechargeTask.findUnique({ where: { id: taskId } })
    );
    if (!row || !row.publicTokenHash || this.encryption.hash(token) !== row.publicTokenHash)
      throw new ForbiddenException('任务凭证无效');
    return row;
  }
  async publicTask(input: unknown) {
    return this.map(await this.authorizePublic(input), true);
  }
  async publicTicket(input: unknown) {
    return this.memory.ticket((await this.authorizePublic(input)).id);
  }
  async start(
    raw: unknown,
    operator?: AuthenticatedUser,
    operation: OnlineRechargeOperation = 'recharge',
    requireFullSession = false
  ) {
    const input = object(raw);
    const sessionData = ['recharge', 'debug', 'subscription', 'renewal'].includes(operation)
      ? session(input.session, requireFullSession)
      : null;
    const code = input.code ? text(input.code, '兑换码', 190) : '';
    if (operation === 'recharge' && !operator && !code)
      throw new BadRequestException('请填写兑换码');
    const token = randomBytes(32).toString('base64url');
    const result = await this.repository.transaction('tasks-start', async (tx) => {
      const config = await tx.onlineRechargeConfig.findUnique({ where: { id: 'global' } });
      const settings = { ...ONLINE_RECHARGE_DEFAULTS, ...(config ? object(config.settings) : {}) };
      const codeRow = code
        ? await tx.onlineRechargeCode.findUnique({
            where: { codeHash: this.encryption.hash(code)! }
          })
        : null;
      if (code && (!codeRow || codeRow.status === 'disabled' || codeRow.deletedAt))
        throw new BadRequestException('兑换码无效');
      if (codeRow && codeRow.status !== 'available') {
        const existing = codeRow.taskId
          ? await tx.onlineRechargeTask.findUnique({ where: { id: codeRow.taskId } })
          : null;
        if (!existing) throw new ConflictException('兑换码已使用或待核对');
        if (existing.sessionIdentityHash !== this.encryption.hash(sessionData?.identity))
          throw new ConflictException('兑换码已绑定其他任务，请查询原任务');
        return {
          row: existing,
          taskToken: this.encryption.decrypt(existing.publicTokenEncrypted)!
        };
      }
      if (operation === 'recharge') {
        if (settings.maintenance) throw new ConflictException('线上代充维护中，请稍后再试');
        const active = await tx.onlineRechargeTask.count({
          where: {
            operation: 'recharge',
            status: { in: ['queued', 'running', 'awaiting_credentials'] }
          }
        });
        if (active >= Number(settings.maxConcurrent))
          throw new ConflictException('当前代充名额已满，请稍后再试');
        if (
          sessionData &&
          (await tx.onlineRechargeTask.count({
            where: {
              sessionIdentityHash: this.encryption.hash(sessionData.identity),
              operation: 'recharge',
              status: { in: [...activeTaskStatuses] }
            }
          }))
        )
          throw new ConflictException('该账号已有执行中或待核对任务');
      }
      const selectedPlan = codeRow?.plan ?? plan(input.plan ?? 'plus');
      const payload: Record<string, unknown> = {};
      for (const key of [
        'region',
        'planName',
        'action',
        'target',
        'proxyId',
        'ids',
        'mode',
        'size',
        'reason',
        'recheckTaskId',
        'originalProvider',
        'providerOrderId',
        'providerTaskId',
        'targetPlan',
        'sourceVersion'
      ])
        if (input[key] !== undefined) payload[key] = input[key];
      if (payload.region && !['US', 'PH', 'SG', 'MY'].includes(String(payload.region)))
        throw new BadRequestException('支付地区无效');
      if (payload.planName) payload.planName = text(payload.planName, '套餐标识', 100);
      if (
        operation === 'renewal' &&
        !['cancel', 'disable', 'enable', 'check'].includes(String(payload.action))
      )
        throw new BadRequestException('续费操作无效');
      if (payload.action === 'cancel') payload.action = 'disable';
      const row = await tx.onlineRechargeTask.create({
        data: {
          operation,
          message: '',
          plan: selectedPlan,
          provider: operation === 'recharge' && settings.gptApiEnabled ? 'third_party' : 'local',
          codeId: codeRow?.id,
          operatorId: operator?.id,
          sessionEncrypted: this.encryption.encrypt(sessionData?.source),
          sessionIdentityHash: this.encryption.hash(sessionData?.identity),
          emailEncrypted: this.encryption.encrypt(sessionData?.email),
          publicTokenHash: this.encryption.hash(token),
          publicTokenEncrypted: this.encryption.encrypt(token),
          payload: payload as Prisma.InputJsonObject
        }
      });
      if (codeRow)
        await tx.onlineRechargeCode.update({
          where: { id: codeRow.id },
          data: { status: 'reserved', taskId: row.id }
        });
      await this.repository.log(tx, 'tasks.create', operator, row.id, {
        operation,
        plan: selectedPlan,
        provider: row.provider
      });
      return { row, taskToken: token };
    });
    return { ...this.map(result.row, !operator), taskToken: result.taskToken };
  }
  async action(section: string, action: string, raw: unknown, operator: AuthenticatedUser) {
    const input = object(raw);
    if (action === 'start')
      return this.start(input, operator, section === 'checkout-debug' ? 'debug' : 'recharge');
    if (action === 'recheck') {
      const row = await this.repository.read((db) =>
        db.onlineRechargeTask.findUnique({ where: { id: id(input.id) } })
      );
      if (!row || row.status !== 'awaiting_review' || !row.sessionEncrypted)
        throw new ConflictException('仅允许复查具有会话资料的待核对任务');
      return this.start(
        {
          session: this.encryption.decrypt(row.sessionEncrypted),
          plan: row.plan,
          action: 'recheck',
          recheckTaskId: row.id,
          originalProvider: row.provider,
          providerOrderId: row.providerOrderId,
          providerTaskId: row.providerTaskId,
          targetPlan: row.plan,
          sourceVersion: row.leaseVersion
        },
        operator,
        'subscription'
      );
    }
    if (action === 'subscribe') {
      const taskId = id(input.id);
      await this.get(taskId);
      return this.memory.ticket(taskId);
    }
    if (section === 'renewal' || action === 'subscription') {
      if (input.session)
        return this.start(
          { ...input, action: action === 'subscription' ? 'check' : action },
          operator,
          action === 'subscription' ? 'subscription' : 'renewal'
        );
      const selected = ids(input),
        started: unknown[] = [];
      for (const taskId of selected) {
        const row = await this.repository.read((db) =>
          db.onlineRechargeTask.findUnique({ where: { id: taskId } })
        );
        if (!row?.sessionEncrypted) throw new NotFoundException('会话不存在');
        await this.repository.transaction(`task:${taskId}`, (tx) =>
          this.repository.log(tx, 'sessions.use', operator, taskId, { operation: action })
        );
        started.push(
          await this.start(
            {
              session: this.encryption.decrypt(row.sessionEncrypted),
              plan: row.plan,
              action: action === 'subscription' ? 'check' : action
            },
            operator,
            action === 'subscription' ? 'subscription' : 'renewal'
          )
        );
      }
      return { tasks: started };
    }
    const taskId = id(input.id);
    return this.repository.transaction(`task:${taskId}`, async (tx) => {
      const row = await tx.onlineRechargeTask.findUnique({ where: { id: taskId } });
      if (!row) throw new NotFoundException('任务不存在');
      if (action === 'detail')
        return {
          ...this.map(row),
          events: await tx.onlineRechargeEvent.findMany({
            where: { taskId },
            orderBy: { createdAt: 'asc' },
            take: 1000
          })
        };
      if (action === 'checkout-link') {
        assertOnlineSensitive(operator);
        text(input.reason, '查看原因', 500);
        if (row.operation !== 'debug') throw new BadRequestException('仅调试任务允许取出支付链接');
        const encrypted = object(row.payload).debugCheckoutEncrypted;
        if (typeof encrypted !== 'string') throw new NotFoundException('调试链接尚未生成');
        await this.repository.log(tx, 'debug.checkout_link.reveal', operator, taskId, {
          reason: input.reason
        });
        return { checkoutUrl: this.encryption.decrypt(encrypted) };
      }
      if (action === 'reveal' || action === 'export') {
        assertOnlineSensitive(operator);
        text(input.reason ?? '会话管理导出', '查看原因', 500);
        await this.repository.log(tx, `sessions.${action}`, operator, taskId, {
          reason: input.reason
        });
        return {
          session: this.encryption.decrypt(row.sessionEncrypted),
          content: this.encryption.decrypt(row.sessionEncrypted),
          filename: '线上代充会话.txt'
        };
      }
      if (action === 'cancel') {
        if (row.status !== 'queued' || row.paymentStarted || row.leaseOwner)
          throw new ConflictException('仅允许取消尚未开始的任务');
        await tx.onlineRechargeTask.update({
          where: { id: taskId },
          data: { status: 'failed', message: '管理员取消待执行任务' }
        });
        if (row.codeId)
          await tx.onlineRechargeCode.updateMany({
            where: { id: row.codeId, taskId },
            data: { status: 'available', taskId: null }
          });
      } else if (action === 'delete') {
        if (
          activeTaskStatuses.includes(row.status as (typeof activeTaskStatuses)[number]) ||
          (row.paymentStarted && !row.confirmedPaid && row.status !== 'failed')
        )
          throw new ConflictException('不能删除执行中或结果未确认的任务');
        await tx.onlineRechargeTask.update({
          where: { id: taskId },
          data: { deletedAt: new Date(), sessionEncrypted: null, emailEncrypted: null }
        });
      } else throw new BadRequestException('不支持该任务操作');
      await this.repository.log(tx, `tasks.${action}`, operator, taskId);
      return { success: true };
    });
  }
}
