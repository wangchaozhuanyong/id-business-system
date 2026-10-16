import { OnlineRechargeTaskNotAccepted } from '../task-acceptance';
import { assertSharedCardPlan } from '../../bank-card-pool/public-api';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { Prisma, type OnlineRechargeTask } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { acquireMysqlTransactionLock } from '../../../common/prisma/mysql-transaction-lock';
import {
  proxyConnectionVersion,
  safeProxyTestTaskResult,
  proxyTestFailureMessage
} from '../../proxy-pool/public-api';
import type { AuthenticatedUser } from '../../../auth/auth.types';
import { FieldEncryptionService } from '../../../common/crypto/field-encryption.service';
import {
  ONLINE_RECHARGE_DEFAULTS,
  ONLINE_RECHARGE_PLAN_LABELS,
  ONLINE_RECHARGE_PLANS,
  type OnlineRechargeOperation
} from '../contracts';
import { OnlineRechargeSettingsService } from '../settings.service';
import { onlineProxyCountry } from '../proxy-input';
import { resolvePlanRegion, paymentRegion, taskPlanRegion } from '../plan-region';
import { OnlineRechargeRepository } from './online-recharge.repository';
import { OnlineRechargeEphemeralCredentials } from '../ephemeral-credentials.service';
import { assertOnlineSensitive } from '../assets.service';
import { OnlineRechargeOrderSyncService } from '../order-sync.service';
import {
  id,
  ids,
  object,
  plan,
  paymentLimit,
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
    private readonly memory: OnlineRechargeEphemeralCredentials,
    private readonly orderSync: OnlineRechargeOrderSyncService
  ) {}
  map(row: OnlineRechargeTask, publicView = false) {
    const payload =
      row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
        ? row.payload
        : {};
    const proxyTest = row.operation === 'proxy_test';
    const legacyTerminalTest =
      proxyTest &&
      typeof payload.proxyConnectionVersion !== 'string' &&
      !['queued', 'running'].includes(row.status);
    const proxyResult = legacyTerminalTest
      ? {
          ok: false,
          ip: null,
          latencyMs: null,
          errorCode: 'legacy_test',
          message: '旧检测缺少连接版本，请重新检测'
        }
      : proxyTest
        ? safeProxyTestTaskResult(row.result, payload.proxyId)
        : null;
    const result = proxyResult ?? sanitize(row.result, '', publicView);
    const resultObject =
      result && typeof result === 'object' && !Array.isArray(result)
        ? (result as Record<string, unknown>)
        : {};
    const subscription =
      resultObject.data &&
      typeof resultObject.data === 'object' &&
      !Array.isArray(resultObject.data)
        ? (resultObject.data as Record<string, unknown>)
        : resultObject;
    const subscriptionVerified =
      (resultObject.ok === true || resultObject.renewalVerified === true) &&
      typeof subscription.hasActiveSubscription === 'boolean';
    const payment = row.payload ? object(row.payload).paymentContext : null;
    const change =
      payment && typeof payment === 'object' && !Array.isArray(payment)
        ? (payment as Record<string, unknown>)
        : null;
    const base = {
      id: row.id,
      jobKey: row.id,
      operation: row.operation,
      status: legacyTerminalTest ? 'failed' : row.status,
      plan: row.plan,
      provider: row.provider,
      planRegion: payload.planRegion ? sanitize(payload.planRegion) : null,
      progress: row.progress,
      stage: row.stage,
      message: proxyTest
        ? legacyTerminalTest
          ? '旧检测缺少连接版本，请重新检测'
          : payload.proxyConnectionChanged === true
            ? '连接资料已修改，请重新检测'
            : row.status === 'queued'
              ? '等待执行代理检测'
              : row.status === 'running'
                ? '正在检测代理连接和出口 IP'
                : row.message === '管理员取消待执行任务'
                  ? '已取消待执行的代理检测'
                  : row.status === 'succeeded' && proxyResult?.ok === true
                    ? '检测成功'
                    : proxyTestFailureMessage(proxyResult?.errorCode)
        : redact(row.message, publicView),
      ...(proxyTest
        ? {
            proxyId: typeof payload.proxyId === 'string' ? payload.proxyId : null,
            connectionChanged: payload.proxyConnectionChanged === true,
            requiresResubmission: typeof payload.proxyConnectionVersion !== 'string'
          }
        : {}),
      cardLast4: row.cardLast4,
      email: publicView ? undefined : (this.encryption.decrypt(row.emailEncrypted) ?? ''),
      subscriptionChange: change
        ? {
            kind: change.kind,
            sourcePlan: change.sourcePlan,
            targetPlan: change.targetPlan,
            amount: change.amount,
            currency: change.currency,
            ...(publicView ? {} : { cardLast4: change.cardLast4 }),
            ...(change.quoteId ? { quoteId: change.quoteId } : {})
          }
        : null,
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
          hasSession: Boolean(row.sessionEncrypted),
          sessionMasked: row.sessionEncrypted ? '已提供（加密保存）' : null,
          subscriptionStatus: subscriptionVerified
            ? subscription.hasActiveSubscription
              ? 'active'
              : 'inactive'
            : null,
          autoRenew:
            subscriptionVerified && typeof subscription.autoRenewRaw === 'boolean'
              ? subscription.autoRenewRaw
              : null,
          expiresAt:
            subscriptionVerified &&
            typeof subscription.expiresAt === 'string' &&
            Number.isFinite(Date.parse(subscription.expiresAt))
              ? subscription.expiresAt
              : null
        };
  }
  async get(taskId: string, publicView = false) {
    const row = await this.repository.read((db) =>
      db.onlineRechargeTask.findUnique({ where: { id: taskId } })
    );
    if (!row) throw new NotFoundException('任务不存在');
    return publicView
      ? this.map(row, true)
      : { ...this.map(row), orderSync: await this.orderSync.summary(taskId) };
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
      plans: ONLINE_RECHARGE_PLANS.map((key) => ({ key, label: ONLINE_RECHARGE_PLAN_LABELS[key] }))
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
    requireFullSession = false,
    integrationSource?: string
  ) {
    const input = object(raw);
    const sessionData = ['recharge', 'debug', 'subscription', 'renewal'].includes(operation)
      ? session(input.session, requireFullSession)
      : null;
    const code = input.code ? text(input.code, '兑换码', 190) : '';
    if (operation === 'recharge' && !operator && !code)
      throw new BadRequestException('请填写兑换码');
    const token = randomBytes(32).toString('base64url');
    const pending = this.repository.transaction('tasks-start', async (tx) => {
      let testedProxy: { id: string; version: string } | undefined;
      if (operation === 'proxy_test') {
        const requested = id(input.proxyId);
        const canonicalId =
          input.proxyPoolReference === true
            ? requested
            : ((await tx.idBusinessV2ProxyAlias.findUnique({ where: { oldId: requested } }))
                ?.proxyId ?? requested);
        await acquireMysqlTransactionLock(tx, `proxy-pool:${canonicalId}`);
        const proxy = await tx.idBusinessV2RechargeProxy.findUnique({ where: { id: canonicalId } });
        if (!proxy || !proxy.active) throw new ConflictException('所选代理已停用或不存在');
        testedProxy = { id: proxy.id, version: proxyConnectionVersion(proxy) };
        const aliases = await tx.idBusinessV2ProxyAlias.findMany({
          where: { proxyId: canonicalId },
          select: { oldId: true }
        });
        const existing = await tx.onlineRechargeTask.findFirst({
          where: {
            operation: 'proxy_test',
            status: { in: ['queued', 'running'] },
            deletedAt: null,
            OR: [canonicalId, ...aliases.map((row) => row.oldId)].flatMap((proxyId) => [
              { payload: { path: '$.proxyId', equals: proxyId } },
              { payload: { path: '$.ids', array_contains: proxyId } }
            ])
          },
          orderBy: { createdAt: 'desc' }
        });
        if (existing) {
          const prior = object(existing.payload);
          if (!prior.proxyConnectionVersion && existing.status === 'queued') {
            const retired = await tx.onlineRechargeTask.updateMany({
              where: {
                id: existing.id,
                status: 'queued',
                leaseOwner: null,
                paymentStarted: false,
                confirmedPaid: false
              },
              data: {
                status: 'failed',
                progress: 100,
                stage: 'finished',
                message: '旧检测缺少连接版本，已停止，请重新检测',
                result: { ok: false, errorCode: 'legacy_test' }
              }
            });
            if (!retired.count) return { row: existing, taskToken: '', reused: true };
            await this.repository.log(tx, 'tasks.proxy_test.retire_legacy', operator, existing.id);
          } else if (
            !prior.proxyConnectionVersion ||
            prior.proxyConnectionVersion === testedProxy.version
          )
            return { row: existing, taskToken: '', reused: true };
        }
      }
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
      }
      if (
        sessionData &&
        (operation === 'recharge' || (operation === 'renewal' && input.action !== 'check')) &&
        (await tx.onlineRechargeTask.count({
          where: {
            sessionIdentityHash: this.encryption.hash(sessionData.identity),
            operation: { in: ['recharge', 'renewal'] },
            status: { in: [...activeTaskStatuses] }
          }
        }))
      )
        throw new ConflictException('该账号已有充值或续费执行中或待核对任务，请先核对原任务');
      const selectedPlan = codeRow?.plan ?? plan(input.plan ?? 'plus');
      if (operation === 'recharge' && settings.gptApiEnabled && selectedPlan === 'pro_500')
        throw new BadRequestException('第三方通道尚未核实支持 Pro 500，请使用本地执行通道');
      const payload: Record<string, unknown> = {};
      if (integrationSource) payload.integrationSource = integrationSource;
      if (input.paymentLimit !== undefined) {
        if (!operator || operation !== 'recharge' || settings.gptApiEnabled)
          throw new BadRequestException('付款上限仅支持管理端官网充值任务');
        payload.paymentLimit = paymentLimit(input.paymentLimit);
      }
      if (input.cardId) {
        const cardId = id(input.cardId);
        const selectedCard = await tx.onlineRechargeCard.findUnique({ where: { id: cardId } });
        if (!selectedCard || selectedCard.status !== 'active' || selectedCard.leaseOwner)
          throw new ConflictException('所选银行卡当前不可用');
        assertSharedCardPlan(selectedCard.allowedPlans, selectedPlan);
        payload.cardId = cardId;
      }
      for (const key of [
        'region',
        'planName',
        'action',
        'target',
        'proxyId',
        'proxyPoolReference',
        'ids',
        'mode',
        'size',
        'reason',
        'recheckTaskId',
        'originalProvider',
        'originalOperation',
        'renewalAction',
        'providerOrderId',
        'providerTaskId',
        'targetPlan',
        'sourceVersion'
      ])
        if (input[key] !== undefined) payload[key] = input[key];
      if (testedProxy) {
        payload.proxyId = testedProxy.id;
        payload.proxyPoolReference = true;
        payload.proxyConnectionVersion = testedProxy.version;
      }
      if (operation === 'recharge' || operation === 'debug') {
        const route = resolvePlanRegion(
          settings,
          selectedPlan,
          config?.version ?? 0,
          operation === 'debug' ? payload.region : undefined
        );
        if (operation === 'recharge' && settings.gptApiEnabled && route.paymentRegion === 'CL')
          throw new BadRequestException('第三方通道尚未核实支持智利，请使用官网银行卡通道');
        payload.planRegion = route;
        payload.region = route.paymentRegion;
        payload.proxyCountryCode = route.proxyCountryCode;
      }
      if (
        ['recharge', 'debug', 'subscription', 'renewal'].includes(operation) &&
        !(operation === 'subscription' && payload.recheckTaskId)
      ) {
        const countryCode = onlineProxyCountry(
          payload.proxyCountryCode ?? settings.proxyCountryCode
        );
        if (!(await tx.idBusinessV2RechargeProxy.count({ where: { active: true, countryCode } })))
          throw new ConflictException('所选代理国家暂无启用代理，请先在代理 IP 管理中添加或启用');
        // 固定本次任务的国家，后续修改全局配置不改变已受理任务的代理范围。
        payload.proxyCountryCode = countryCode;
      }
      if (payload.region) paymentRegion(payload.region);
      if (payload.planName) {
        if (operation !== 'debug')
          throw new BadRequestException('自定义套餐标识仅允许用于付款前调试');
        payload.planName = text(payload.planName, '套餐标识', 100);
      }
      if (
        operation === 'renewal' &&
        !['cancel', 'disable', 'enable', 'check'].includes(String(payload.action))
      )
        throw new BadRequestException('续费操作无效');
      if (payload.action === 'cancel') payload.action = 'disable';
      if (operation === 'subscription' && payload.recheckTaskId) {
        const original = await tx.onlineRechargeTask.findUnique({
          where: { id: id(payload.recheckTaskId) }
        });
        if (
          !operator ||
          !original ||
          original.status !== 'awaiting_review' ||
          original.leaseVersion !== payload.sourceVersion ||
          original.plan !== selectedPlan ||
          original.sessionIdentityHash !== this.encryption.hash(sessionData?.identity)
        )
          throw new ConflictException('原任务核对资料已变化，请重新打开原任务');
        const originalPayload = original.payload ? object(original.payload) : {};
        const originalRegion = taskPlanRegion(originalPayload, original.plan);
        payload.proxyCountryCode = onlineProxyCountry(originalPayload.proxyCountryCode);
        if (originalRegion) {
          payload.planRegion = originalRegion;
          payload.region = originalRegion.paymentRegion;
        } else if (originalPayload.region) payload.region = paymentRegion(originalPayload.region);
        else
          throw new ConflictException('原任务缺少固定支付地区，请先人工核对，不自动套用当前配置');
        if (originalPayload.paymentContext) payload.paymentContext = originalPayload.paymentContext;
        const originalResult = original.result ? object(original.result) : {};
        if (originalResult.paymentEvidence)
          payload.originalPaymentEvidence = originalResult.paymentEvidence;
      }
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
      return { row, taskToken: token, reused: false };
    });
    const result = await pending.catch((error: unknown) => {
      if (
        integrationSource &&
        (error instanceof BadRequestException || error instanceof ConflictException)
      )
        throw new OnlineRechargeTaskNotAccepted();
      throw error;
    });
    return {
      ...this.map(result.row, !operator),
      taskToken: result.taskToken,
      ...(operation === 'proxy_test' ? { reused: result.reused === true } : {})
    };
  }
  async action(section: string, action: string, raw: unknown, operator: AuthenticatedUser) {
    const input = object(raw);
    if (section === 'jobs' && action === 'sync-order')
      return this.orderSync.enqueue(id(input.id), operator);
    if (section === 'jobs' && action === 'order-backfill-preview')
      return this.orderSync.preview(input, operator);
    if (section === 'jobs' && action === 'order-backfill')
      return this.orderSync.backfill(input, operator);
    if (action === 'start')
      return this.start(input, operator, section === 'checkout-debug' ? 'debug' : 'recharge');
    if (action === 'recheck') {
      const row = await this.repository.read((db) =>
        db.onlineRechargeTask.findUnique({ where: { id: id(input.id) } })
      );
      if (
        !row ||
        row.status !== 'awaiting_review' ||
        !row.sessionEncrypted ||
        !['recharge', 'renewal'].includes(row.operation)
      )
        throw new ConflictException('仅允许复查具有会话资料的待核对任务');
      return this.start(
        {
          session: this.encryption.decrypt(row.sessionEncrypted),
          plan: row.plan,
          action: 'recheck',
          recheckTaskId: row.id,
          originalProvider: row.provider,
          originalOperation: row.operation,
          renewalAction:
            row.operation === 'renewal' && row.payload ? object(row.payload).action : undefined,
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
          orderSync: await this.orderSync.summary(taskId, tx),
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
