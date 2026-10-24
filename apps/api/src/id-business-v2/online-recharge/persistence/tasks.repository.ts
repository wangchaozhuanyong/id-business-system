import { OnlineRechargeTaskNotAccepted } from '../task-acceptance';
import { assertSharedCardPlan, lockSharedBankCards } from '../../bank-card-pool/public-api';
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
import {
  assertV2ExpectedUpdatedAt,
  normalizeV2ExpectedUpdatedAt,
  type V2CommandTransaction
} from '../../runtime/public-api';
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
import { originalRecheckSchedule, ORIGINAL_RECHECK_DELAYS_MS } from '../reconciliation';
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
  activeTaskStatuses,
  assertQueryTransportModeInput
} from '../validation';

@Injectable()
export class OnlineRechargeTasksRepository {
  private recheckScanCursor?: string;
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
    const reconciliation = payload.reconciliation
      ? originalRecheckSchedule(payload.reconciliation, row.updatedAt)
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
      email: publicView ? '' : (this.encryption.decrypt(row.emailEncrypted) ?? ''),
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
          reconciliation: reconciliation
            ? {
                attempts: reconciliation.attempts,
                nextAttemptAt: reconciliation.nextAttemptAt,
                stopped: reconciliation.stopped,
                ...(reconciliation.reasonCode ? { reasonCode: reconciliation.reasonCode } : {})
              }
            : null,
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
    const [active, queued, awaitingCredentials] = await this.repository.read((db) =>
      Promise.all(
        (['running', 'queued', 'awaiting_credentials'] as const).map((status) =>
          db.onlineRechargeTask.count({ where: { operation: 'recharge', status } })
        )
      )
    );
    return {
      maintenance: settings.maintenance,
      maintenanceDrain: settings.maintenance === true && active + queued + awaitingCredentials > 0,
      maxConcurrent: settings.maxConcurrent,
      active,
      queued,
      awaitingCredentials,
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
    const queryTransportMode = assertQueryTransportModeInput(
      input,
      operator,
      operation,
      integrationSource
    );
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
            status: 'running'
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
      if (input.validationMode !== undefined && input.validationMode !== 'link_only') {
        if (!operator || operation !== 'debug' || input.validationMode !== 'ready_before_payment')
          throw new BadRequestException('不付款验收仅支持管理端调试任务');
        if (code) throw new BadRequestException('不付款验收不使用兑换码');
        payload.validationMode = 'ready_before_payment';
      }
      if (queryTransportMode) payload.queryTransportMode = queryTransportMode;
      if (operation === 'recharge' && !settings.gptApiEnabled) payload.checkoutRecoveryVersion = 1;
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
        const existing = await this.activeRecheck(tx, original);
        if (existing)
          return {
            row: existing,
            taskToken: this.encryption.decrypt(existing.publicTokenEncrypted) ?? '',
            reused: true
          };
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
        provider: row.provider,
        ...(queryTransportMode ? { queryTransportMode } : {})
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
  private activeRecheck(tx: V2CommandTransaction, original: OnlineRechargeTask) {
    return tx.onlineRechargeTask.findFirst({
      where: {
        operation: 'subscription',
        deletedAt: null,
        status: { in: ['queued', 'running'] },
        AND: [
          { payload: { path: '$.recheckTaskId', equals: original.id } },
          { payload: { path: '$.sourceVersion', equals: original.leaseVersion } }
        ]
      },
      orderBy: { createdAt: 'asc' }
    });
  }
  async processDueRechecks(now = new Date()) {
    const scanned = await this.repository.transaction('tasks-start', async (tx) => {
      const originals = await tx.onlineRechargeTask.findMany({
        where: {
          status: 'awaiting_review',
          operation: { in: ['recharge', 'renewal'] },
          deletedAt: null,
          ...(this.recheckScanCursor ? { id: { gt: this.recheckScanCursor } } : {})
        },
        orderBy: { id: 'asc' },
        take: 100
      });
      let enqueued = 0;
      for (const original of originals) {
        const payload = original.payload ? object(original.payload) : {};
        const schedule = originalRecheckSchedule(payload.reconciliation, original.updatedAt);
        if (schedule.stopped) continue;
        const missingIdentity =
          original.operation === 'recharge' &&
          original.provider === 'local' &&
          !payload.checkoutRecoveryEncrypted;
        const missingSession = !original.sessionEncrypted || !original.sessionIdentityHash;
        const missingSubmission =
          original.operation === 'renewal'
            ? !payload.renewalSubmission
            : !original.paymentStarted &&
              !original.confirmedPaid &&
              !original.providerOrderId &&
              !original.providerTaskId;
        let route: ReturnType<typeof taskPlanRegion> = null;
        let missingRoute = false;
        try {
          route = taskPlanRegion(payload, original.plan);
          onlineProxyCountry(payload.proxyCountryCode);
          if (!route) paymentRegion(payload.region);
        } catch {
          missingRoute = true;
        }
        if (missingIdentity || missingSession || missingSubmission || missingRoute) {
          schedule.stopped = true;
          schedule.nextAttemptAt = null;
          schedule.reasonCode = missingSubmission
            ? 'original_submission_missing'
            : missingIdentity
              ? 'legacy_original_identity_missing'
              : missingSession
                ? 'original_session_missing'
                : 'original_route_missing';
          await tx.onlineRechargeTask.update({
            where: { id: original.id },
            data: {
              payload: { ...payload, reconciliation: schedule } as unknown as Prisma.InputJsonValue
            }
          });
          await this.repository.log(tx, 'tasks.recheck.unavailable', undefined, original.id, {
            reasonCode: schedule.reasonCode
          });
          continue;
        }
        if (!schedule.nextAttemptAt || Date.parse(schedule.nextAttemptAt) > now.getTime()) continue;
        if (await this.activeRecheck(tx, original)) continue;
        const source = original.result ? object(original.result) : {};
        const recheck = await tx.onlineRechargeTask.create({
          data: {
            operation: 'subscription',
            provider: 'local',
            plan: original.plan,
            operatorId: original.operatorId,
            sessionEncrypted: original.sessionEncrypted,
            sessionIdentityHash: original.sessionIdentityHash,
            emailEncrypted: original.emailEncrypted,
            message: '自动核对原单，仅查询付款与订阅，不再次提交付款',
            payload: {
              action: 'recheck',
              recheckTaskId: original.id,
              sourceVersion: original.leaseVersion,
              originalProvider: original.provider,
              originalOperation: original.operation,
              targetPlan: original.plan,
              ...(original.operation === 'renewal' ? { renewalAction: payload.action } : {}),
              ...(original.providerOrderId ? { providerOrderId: original.providerOrderId } : {}),
              ...(original.providerTaskId ? { providerTaskId: original.providerTaskId } : {}),
              ...(payload.proxyCountryCode ? { proxyCountryCode: payload.proxyCountryCode } : {}),
              ...(payload.proxyId
                ? { proxyId: payload.proxyId, proxyPoolReference: payload.proxyPoolReference }
                : {}),
              ...(route
                ? { planRegion: route, region: route.paymentRegion }
                : payload.region
                  ? { region: payload.region }
                  : {}),
              ...(payload.paymentContext ? { paymentContext: payload.paymentContext } : {}),
              ...(source.paymentEvidence
                ? { originalPaymentEvidence: source.paymentEvidence }
                : {}),
              automaticRecheck: true
            } as Prisma.InputJsonValue
          }
        });
        schedule.attempts++;
        schedule.lastTaskId = recheck.id;
        schedule.stopped = schedule.attempts >= ORIGINAL_RECHECK_DELAYS_MS.length;
        schedule.nextAttemptAt = schedule.stopped
          ? null
          : new Date(
              Date.parse(schedule.startedAt) + ORIGINAL_RECHECK_DELAYS_MS[schedule.attempts]!
            ).toISOString();
        if (schedule.stopped) schedule.reasonCode = 'attempts_exhausted';
        await tx.onlineRechargeTask.update({
          where: { id: original.id },
          data: {
            payload: { ...payload, reconciliation: schedule } as unknown as Prisma.InputJsonValue
          }
        });
        await this.repository.log(tx, 'tasks.recheck.schedule', undefined, original.id, {
          recheckTaskId: recheck.id,
          attempt: schedule.attempts,
          sourceVersion: original.leaseVersion
        });
        enqueued++;
      }
      return { enqueued, cursor: originals.length === 100 ? originals[99]!.id : undefined };
    });
    this.recheckScanCursor = scanned.cursor;
    return { enqueued: scanned.enqueued };
  }
  private async resolveNotCharged(
    input: Record<string, unknown>,
    operator: AuthenticatedUser,
    tx: V2CommandTransaction
  ) {
    if (!operator.roles.includes('admin'))
      throw new ForbiddenException('仅管理员可依据用户声明收尾历史付款');
    if (input.userConfirmedNotCharged !== true || input.confirmationSource !== 'user_statement')
      throw new BadRequestException('必须明确记录用户未扣款声明，不能替代支付方证明');
    const taskId = id(input.id),
      requestId = id(input.requestId),
      expected = normalizeV2ExpectedUpdatedAt(input.version, '历史充值任务'),
      confirmationReference = text(input.confirmationReference, '用户确认来源', 190),
      reason = text(input.reason, '人工收尾原因', 500);
    await acquireMysqlTransactionLock(tx, `online-recharge:task:${taskId}`);
    await lockSharedBankCards(tx);
    const row = await tx.onlineRechargeTask.findUnique({ where: { id: taskId } });
    if (!row || row.deletedAt) throw new NotFoundException('历史充值任务不存在');
    const payload = row.payload ? object(row.payload) : {},
      result = row.result ? object(row.result) : {},
      previous = result.manualNotChargedResolution;
    const reply = (alreadyResolved: boolean, version: Date) => ({
      success: true,
      id: row.id,
      status: 'failed' as const,
      paymentStarted: true,
      confirmedPaid: false,
      manualResolution: true,
      cardDisabled: true,
      alreadyResolved,
      version: version.toISOString()
    });
    if (previous && typeof previous === 'object' && !Array.isArray(previous)) {
      const prior = previous as Record<string, unknown>;
      if (
        row.status === 'failed' &&
        row.paymentStarted &&
        !row.confirmedPaid &&
        prior.version === 1 &&
        prior.requestId === requestId &&
        prior.operatorId === operator.id &&
        prior.expectedUpdatedAt === expected.toISOString() &&
        prior.confirmationSource === 'user_statement' &&
        prior.confirmationReference === confirmationReference &&
        prior.reason === reason &&
        prior.originalLeaseVersion === row.leaseVersion - 1
      )
        return reply(true, row.updatedAt);
      throw new ConflictException('原任务已有不同的人工收尾记录，请核对原结果');
    }
    assertV2ExpectedUpdatedAt(row.updatedAt, expected, '历史充值任务');
    if (
      row.operation !== 'recharge' ||
      row.provider !== 'local' ||
      row.status !== 'awaiting_review' ||
      !row.paymentStarted ||
      row.confirmedPaid ||
      !row.cardId ||
      !row.cardLast4 ||
      !row.sessionIdentityHash ||
      row.leaseOwner ||
      row.leaseId ||
      row.leaseExpiresAt
    )
      throw new ConflictException('仅允许无执行租约、已提交但未确认付款的历史本地充值收尾');
    if (
      payload.checkoutRecoveryVersion !== undefined ||
      payload.checkoutRecoveryEncrypted !== undefined ||
      payload.debugCheckoutEncrypted !== undefined
    )
      throw new ConflictException('任务已有原单恢复能力，必须核对原单，不能人工解除付款保护');
    const hasPaidEvidence = (value: unknown) => {
      const proof =
        value && typeof value === 'object' && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {};
      return proof.verified === true || proof.confirmedPaid === true;
    };
    if (
      result.confirmedPaid === true ||
      result.success === true ||
      hasPaidEvidence(result.paymentEvidence) ||
      hasPaidEvidence(result.originalPaymentEvidence) ||
      hasPaidEvidence(payload.originalPaymentEvidence) ||
      (await tx.onlineRechargeBill.findFirst({
        where: { taskId, status: { in: ['success', 'paid', 'succeeded'] } },
        select: { id: true }
      })) ||
      (await tx.idBusinessV2BankRechargeOrder.findFirst({
        where: { onlineRechargeTaskId: taskId },
        select: { id: true }
      })) ||
      (await tx.onlineRechargeOrderSync.findUnique({
        where: { taskId },
        select: { taskId: true }
      })) ||
      (await tx.onlineRechargeEvent.findUnique({
        where: { dedupeKey: `${taskId}:${row.cardId}:recordCardUsage` },
        select: { id: true }
      }))
    )
      throw new ConflictException('原任务存在付款或入账证据，不能按用户未扣款声明收尾');
    if (
      await tx.onlineRechargeTask.findFirst({
        where: {
          id: { not: taskId },
          deletedAt: null,
          OR: [
            {
              sessionIdentityHash: row.sessionIdentityHash,
              operation: { in: ['recharge', 'renewal', 'subscription', 'debug'] },
              status: { in: ['queued', 'running', 'awaiting_credentials'] }
            },
            {
              operation: 'subscription',
              status: { in: ['queued', 'running', 'awaiting_credentials'] },
              payload: { path: '$.recheckTaskId', equals: taskId }
            },
            { cardId: row.cardId, status: { in: [...activeTaskStatuses] } }
          ]
        },
        select: { id: true }
      })
    )
      throw new ConflictException('该账号、旧卡或原单仍有执行或核对任务，请等待结束后重新确认');
    const card = await tx.onlineRechargeCard.findUnique({ where: { id: row.cardId } });
    if (!card || card.last4 !== row.cardLast4 || (card.leaseOwner && card.leaseOwner !== taskId))
      throw new ConflictException('原银行卡绑定或占用已变化，不能人工收尾');
    const resolution = {
      version: 1,
      outcome: 'user_reported_not_charged',
      paymentProviderVerified: false,
      requestId,
      expectedUpdatedAt: expected.toISOString(),
      operatorId: operator.id,
      confirmationSource: 'user_statement',
      confirmationReference,
      reason,
      resolvedAt: new Date().toISOString(),
      originalLeaseVersion: row.leaseVersion,
      cardId: card.id,
      cardLast4: card.last4
    };
    const changed = await tx.onlineRechargeTask.updateMany({
      where: {
        id: taskId,
        updatedAt: expected,
        status: 'awaiting_review',
        paymentStarted: true,
        confirmedPaid: false,
        leaseVersion: row.leaseVersion,
        leaseOwner: null,
        leaseId: null,
        leaseExpiresAt: null
      },
      data: {
        status: 'failed',
        stage: 'finished',
        progress: 100,
        message: '管理员依据用户未扣款声明收尾；非支付方证明，原任务禁止再次付款',
        paymentStarted: true,
        confirmedPaid: false,
        leaseVersion: { increment: 1 },
        payload: {
          ...payload,
          reconciliation: {
            ...(payload.reconciliation ? object(payload.reconciliation) : {}),
            stopped: true,
            nextAttemptAt: null
          }
        } as Prisma.InputJsonValue,
        result: { ...result, manualNotChargedResolution: resolution } as Prisma.InputJsonValue
      }
    });
    if (changed.count !== 1) throw new ConflictException('历史充值任务版本已变化，请核对后重试');
    const disabled = await tx.onlineRechargeCard.updateMany({
      where: {
        id: card.id,
        leaseVersion: card.leaseVersion,
        OR: [{ leaseOwner: null }, { leaseOwner: taskId }]
      },
      data: {
        status: 'disabled',
        leaseOwner: null,
        leaseId: null,
        leaseExpiresAt: null,
        leaseVersion: { increment: 1 }
      }
    });
    if (disabled.count !== 1) throw new ConflictException('原银行卡占用已变化，人工收尾未保存');
    await tx.onlineRechargeEvent.create({
      data: {
        taskId,
        level: 'warn',
        stage: 'finished',
        dedupeKey: `${taskId}:manual-not-charged`,
        message: '管理员按用户未扣款声明关闭历史任务并停用旧卡；不代表支付方已证明未付款',
        metadata: resolution as Prisma.InputJsonValue
      }
    });
    await this.repository.log(tx, 'tasks.resolve_not_charged', operator, taskId, {
      ...resolution,
      before: {
        status: row.status,
        paymentStarted: true,
        confirmedPaid: false,
        leaseVersion: row.leaseVersion,
        cardStatus: card.status,
        cardSuccessCount: card.successCount,
        cardDeclineCount: card.declineCount
      },
      after: {
        status: 'failed',
        paymentStarted: true,
        confirmedPaid: false,
        cardStatus: 'disabled'
      }
    });
    const saved = await tx.onlineRechargeTask.findUnique({ where: { id: taskId } });
    return reply(false, saved!.updatedAt);
  }
  async action(section: string, action: string, raw: unknown, operator: AuthenticatedUser) {
    const input = object(raw);
    const manualClose = section === 'jobs' && action === 'resolve-not-charged';
    if (manualClose && !operator.roles.includes('admin'))
      throw new ForbiddenException('仅管理员可依据用户声明收尾历史付款');
    if (action === 'detail') {
      if (input.includeEvents !== undefined && typeof input.includeEvents !== 'boolean')
        throw new BadRequestException('日志读取选项无效');
      const taskId = id(input.id);
      const task = await this.get(taskId);
      if (input.includeEvents === false) return task;
      const events = await this.repository.read((db) =>
        db.onlineRechargeEvent.findMany({
          where: { taskId },
          orderBy: { createdAt: 'asc' },
          take: 1000
        })
      );
      return { ...task, events };
    }
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
              action: action === 'subscription' ? 'check' : action,
              ...(input.queryTransportMode === 'transport_compare'
                ? { queryTransportMode: 'transport_compare' }
                : {})
            },
            operator,
            action === 'subscription' ? 'subscription' : 'renewal'
          )
        );
      }
      return { tasks: started };
    }
    const taskId = id(input.id);
    return this.repository.transaction(
      manualClose ? 'tasks-start' : `task:${taskId}`,
      async (tx) => {
        if (manualClose) await this.resolveNotCharged(input, operator, tx);
        else {
          const row = await tx.onlineRechargeTask.findUnique({ where: { id: taskId } });
          if (!row) throw new NotFoundException('任务不存在');
          if (action === 'checkout-link') {
            assertOnlineSensitive(operator);
            text(input.reason, '查看原因', 500);
            if (row.operation !== 'debug')
              throw new BadRequestException('仅调试任务允许取出支付链接');
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
        }
        return { success: true };
      }
    );
  }
}
