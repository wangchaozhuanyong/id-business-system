import {
  RechargeProxyService,
  RechargeProxyRepository,
  OnlineProxyPoolRepository
} from '../proxy-pool/public-api';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { createCipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { V2TransactionalAuditService, V2CommandTransactionManager } from '../runtime/public-api';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type { OnlineRechargePaymentContext, OnlineRechargeWorkerRpc } from './contracts';
import { OnlineRechargeRepository } from './persistence/online-recharge.repository';
import { OnlineRechargeWorkerRepository } from './persistence/worker.repository';
import { OnlineRechargeSettingsService } from './settings.service';
import { OnlineRechargeEphemeralCredentials } from './ephemeral-credentials.service';
import { OnlineRechargeAssetsService } from './assets.service';
import { OnlineRechargeTasksService } from './tasks.service';
import { OnlineRechargeWebhooksService } from './webhooks.service';
import { OnlineRechargeSettingsRepository } from './persistence/settings.repository';
import { OnlineRechargeAssetsRepository } from './persistence/assets.repository';
import { OnlineRechargeTasksRepository } from './persistence/tasks.repository';
import { OnlineRechargeWebhooksRepository } from './persistence/webhooks.repository';
import { OnlineRechargeModule } from './online-recharge.module';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { OnlineRechargeSecurityNotificationService } from './security-notification.service';
import { OnlineRechargeSecurityNotificationRepository } from './persistence/security-notification.repository';
import { sessionAccountId } from './validation';
import { OnlineRechargeOrderSyncService } from './order-sync.service';
import { OnlineRechargeOrderSyncRepository } from './persistence/order-sync.repository';
import { OnlineRechargeAdminRepository } from './persistence/admin.repository';

const enabled = process.env.ONLINE_RECHARGE_MYSQL_TEST === '1';
const suite = enabled ? describe : describe.skip;

suite('线上代充隔离MySQL事务验收', () => {
  const db = new PrismaService();
  const config = new ConfigService({
    FIELD_ENCRYPTION_KEY: 'synthetic-field-encryption-fixture',
    HASH_SECRET: 'synthetic-blind-index-fixture'
  });
  const encryption = new FieldEncryptionService(config);
  const poolRepository = new RechargeProxyRepository(db);
  const pool = new RechargeProxyService(
    poolRepository,
    new V2CommandTransactionManager(db),
    new V2TransactionalAuditService(),
    encryption
  );
  const proxiesPool = new OnlineProxyPoolRepository(pool, poolRepository, encryption);
  const repository = new OnlineRechargeRepository(
    proxiesPool,
    db,
    new V2TransactionalAuditService(),
    new V2CommandTransactionManager(db)
  );
  const settings = new OnlineRechargeSettingsService(
    new OnlineRechargeSettingsRepository(repository, encryption)
  );
  const memory = new OnlineRechargeEphemeralCredentials(config);
  const assets = new OnlineRechargeAssetsService(
    new OnlineRechargeAssetsRepository(proxiesPool, repository, encryption, memory)
  );
  const orderSync = new OnlineRechargeOrderSyncService(
    new OnlineRechargeOrderSyncRepository(repository, encryption, {} as never)
  );
  const taskRepository = new OnlineRechargeTasksRepository(
    repository,
    settings,
    encryption,
    memory,
    orderSync
  );
  const tasks = new OnlineRechargeTasksService(taskRepository);
  const admin = new OnlineRechargeAdminRepository(
    repository,
    assets,
    settings,
    tasks,
    memory,
    {} as never,
    encryption
  );
  const workers = new OnlineRechargeWorkerRepository(
    repository,
    settings,
    encryption,
    memory,
    orderSync
  );
  const webhooks = new OnlineRechargeWebhooksService(
    new OnlineRechargeWebhooksRepository(repository, settings, encryption, assets, memory)
  );
  const notifications = new OnlineRechargeSecurityNotificationService(
    new OnlineRechargeSecurityNotificationRepository(repository, settings)
  );
  let operator: AuthenticatedUser;
  const credentials = vi.spyOn(memory, 'available').mockImplementation(async (ids) => ids);
  vi.spyOn(memory, 'putCvc').mockResolvedValue(undefined);
  const putCards = vi.spyOn(memory, 'putCards').mockResolvedValue(undefined);
  vi.spyOn(memory, 'forgetCvc').mockResolvedValue(undefined);
  const fullSession = (identity = randomUUID()) =>
    JSON.stringify({
      accessToken: `eyJsynthetic.${Buffer.from(JSON.stringify({ exp: 4102444800, 'https://api.openai.com/auth': { chatgpt_account_id: identity } })).toString('base64url')}.synthetic-unused-signature`,
      user: { id: identity, email: 'fixture@example.invalid' }
    });
  const start = async (identity = randomUUID(), code?: string) =>
    tasks.start({ session: fullSession(identity), plan: 'plus', code }, operator);
  const prepareCard = async (claim: NonNullable<Awaited<ReturnType<typeof workers.claim>>>) => {
    await assets.importCards(
      [{ number: '4242424242424242', expiryMonth: 12, expiryYear: 2030 }],
      operator
    );
    return workers.reserveCard(lease(claim)) as Promise<{
      id: string;
      leaseId: string;
      leaseVersion: number;
    }>;
  };
  const lease = (
    claim: NonNullable<Awaited<ReturnType<typeof workers.claim>>>,
    args: Record<string, unknown> = {}
  ): OnlineRechargeWorkerRpc => ({
    method: 'fixture',
    taskId: claim.id,
    workerId: claim.workerId,
    leaseId: claim.leaseId,
    leaseVersion: claim.leaseVersion,
    args
  });
  const paymentFor = async (
    claim: NonNullable<Awaited<ReturnType<typeof workers.claim>>>,
    changes: Partial<OnlineRechargePaymentContext> = {}
  ) => {
    const row = await db.onlineRechargeTask.findUniqueOrThrow({ where: { id: claim.id } });
    const card = await db.onlineRechargeCard.findUniqueOrThrow({ where: { id: row.cardId! } });
    const checkoutId = `oaics_fixture_${claim.id.replaceAll('-', '')}`;
    const context: OnlineRechargePaymentContext = {
      kind: 'initial',
      sourcePlan: 'free',
      targetPlan: claim.plan,
      accountId: sessionAccountId(claim.session),
      cardId: card.id,
      cardLast4: card.last4,
      amount: '20.1000',
      currency: 'USD',
      ...changes,
      quoteId: `quote:${createHash('sha256').update(checkoutId).digest('hex').slice(0, 32)}`
    };
    return {
      context,
      checkoutRecovery: {
        ...context,
        version: 1,
        checkoutId,
        processorEntity: 'openai',
        checkoutUrl: `https://chatgpt.com/checkout/openai/${checkoutId}`
      },
      evidence: { ...context, source: 'checkout', verified: true }
    };
  };
  const submitPayment = async (
    claim: NonNullable<Awaited<ReturnType<typeof workers.claim>>>,
    args: Record<string, unknown> = {}
  ) => {
    const payment = await paymentFor(claim);
    await workers.beforeSubmit(
      lease(claim, {
        ...args,
        paymentContext: payment.context,
        checkoutRecovery: payment.checkoutRecovery
      })
    );
    return payment;
  };

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL ?? 'mysql://invalid.invalid/invalid');
    const database = url.pathname.slice(1);
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !(
        database.startsWith('online_recharge_test') ||
        database === 'id_business_v2_online_recharge_fixture'
      )
    )
      throw new Error('专项验收只允许本机线上代充专属隔离数据库');
    await db.$connect();
    const user = await db.user.create({
      data: {
        username: `online-fixture-${randomUUID()}`,
        displayName: '隔离测试身份',
        passwordHash: 'synthetic-unusable-password-hash'
      }
    });
    operator = {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      roles: ['admin'],
      permissions: []
    };
  });
  beforeEach(async () => {
    for (const model of [
      db.onlineRechargeOrderSync,
      db.onlineRechargeBill,
      db.onlineRechargeEvent,
      db.onlineRechargeWebhookReceipt,
      db.onlineRechargeTask,
      db.onlineRechargeCode,
      db.onlineRechargeCard,
      db.onlineRechargeProxy,
      db.idBusinessV2ProxyAlias,
      db.idBusinessV2RechargeProxy,
      db.onlineRechargeAddress,
      db.onlineRechargeConfig
    ]) {
      await (model.deleteMany as () => Promise<unknown>)();
    }
    await db.onlineRechargeConfig.create({
      data: { id: 'global', settings: { proxyCountryCode: 'PH' } }
    });
    await pool.create(
      {
        countryCode: 'PH',
        kind: 'mobile',
        connectionMode: 'direct',
        protocol: 'http',
        url: 'http://country-fixture.example.invalid:8080'
      },
      operator
    );
    credentials.mockImplementation(async (ids) => ids);
    putCards.mockReset().mockResolvedValue(undefined);
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it('套餐规则保存后按四档冻结国家和币种；修改配置不改变原任务', async () => {
    await pool.create(
      {
        countryCode: 'CL',
        kind: 'mobile',
        connectionMode: 'direct',
        protocol: 'http',
        url: 'http://chile-fixture.example.invalid:8080'
      },
      operator
    );
    const initial = await settings.get();
    await expect(
      settings.update(
        { version: Number(initial.version) - 1, planRegionRoutingEnabled: true },
        operator
      )
    ).rejects.toThrow('设置已变化');
    expect((await settings.get()).version).toBe(initial.version);
    const saved = await settings.update(
      { version: initial.version, planRegionRoutingEnabled: true },
      operator
    );
    for (const [plan, region, currency] of [
      ['plus', 'PH', 'PHP'],
      ['pro_5x', 'CL', 'CLP'],
      ['pro_20x', 'PH', 'PHP'],
      ['pro_500', 'CL', 'CLP']
    ] as const) {
      const task = await tasks.start(
        { session: fullSession(), plan, region: 'US', proxyCountryCode: 'US' },
        operator,
        'debug'
      );
      const row = await db.onlineRechargeTask.findUniqueOrThrow({ where: { id: task.id } });
      expect(row.payload).toMatchObject({
        region,
        proxyCountryCode: region,
        planRegion: {
          policy: 'plan',
          configVersion: saved.version,
          targetPlan: plan,
          expectedCurrency: currency
        }
      });
    }
    const original = await db.onlineRechargeTask.findFirstOrThrow({ where: { plan: 'pro_5x' } });
    await settings.update(
      { version: saved.version, planPaymentRegionPro5x: 'PH', planProxyCountryPro5x: 'PH' },
      operator
    );
    expect(
      (await db.onlineRechargeTask.findUniqueOrThrow({ where: { id: original.id } })).payload
    ).toEqual(original.payload);
    const next = await tasks.start({ session: fullSession(), plan: 'pro_5x' }, operator, 'debug');
    expect(
      (await db.onlineRechargeTask.findUniqueOrThrow({ where: { id: next.id } })).payload
    ).toMatchObject({
      region: 'PH',
      proxyCountryCode: 'PH',
      planRegion: { expectedCurrency: 'PHP', configVersion: Number(saved.version) + 1 }
    });
  });

  it('智利代理缺失时保留兑换码可用且不创建任务；客户端套餐不能改变代码绑定', async () => {
    await settings.update({ planRegionRoutingEnabled: true }, operator);
    const codes = (await assets.action(
      'cdks',
      'generate',
      { count: 1, plan: 'pro_5x' },
      operator
    )) as { codes: string[] };
    await expect(
      tasks.start({ session: fullSession(), code: codes.codes[0], plan: 'plus' }, operator)
    ).rejects.toThrow('暂无启用代理');
    expect(await db.onlineRechargeTask.count()).toBe(0);
    expect(await db.onlineRechargeCode.findFirst()).toMatchObject({
      status: 'available',
      plan: 'pro_5x',
      taskId: null
    });
    expect(await db.onlineRechargeBill.count()).toBe(0);
  });

  it('兑换码创建十个、软删除、再创建十个，概览与清单均为 10→0→10', async () => {
    const generate = async () =>
      assets.action('cdks', 'generate', { plan: 'pro_20x', count: 10 }, operator) as Promise<{
        ids: string[];
        codes: string[];
      }>;
    const assertCount = async (expected: number) => {
      const overview = await admin.overview();
      expect(overview.codes.find((row) => row.status === 'available')?._count ?? 0).toBe(expected);
      expect((await repository.list('cdks', { status: 'available' })).total).toBe(expected);
    };
    const first = await generate();
    await assertCount(10);
    const priorAudit = await db.auditLog.count({
      where: { userId: operator.id, action: 'id_business_v2.online_recharge.cdks.delete' }
    });
    await assets.action('cdks', 'delete', { ids: first.ids }, operator);
    await assertCount(0);
    expect(
      await db.onlineRechargeCode.count({
        where: { id: { in: first.ids }, deletedAt: { not: null } }
      })
    ).toBe(10);
    expect(
      await db.auditLog.count({
        where: { userId: operator.id, action: 'id_business_v2.online_recharge.cdks.delete' }
      })
    ).toBe(priorAudit + 1);
    for (const code of first.codes)
      await expect(tasks.verify({ code })).rejects.toThrow('兑换码无效');
    const second = await generate();
    await assertCount(10);
    for (const code of second.codes)
      await expect(tasks.verify({ code })).resolves.toMatchObject({
        valid: true,
        plan: 'pro_20x',
        status: 'available'
      });
    expect(await db.onlineRechargeCode.count()).toBe(20);
    expect(await db.onlineRechargeTask.count()).toBe(0);
    expect(await db.onlineRechargeBill.count()).toBe(0);
  });

  it('并发同兑换码只创建一个任务且返回同一个恢复凭证', async () => {
    const codes = (await assets.action(
      'cdks',
      'generate',
      { count: 1, plan: 'plus' },
      operator
    )) as { codes: string[] };
    const identity = randomUUID();
    const [first, second] = await Promise.all([
      start(identity, codes.codes[0]),
      start(identity, codes.codes[0])
    ]);
    expect(first.id).toBe(second.id);
    expect(first.taskToken).toBe(second.taskToken);
    expect(await db.onlineRechargeTask.count()).toBe(1);
    expect((await db.onlineRechargeCode.findFirst())?.status).toBe('reserved');
  });
  it('扩展迁移保留旧套餐并贯通 Pro 500 兑换码、任务与账单列', async () => {
    await settings.update({ maxConcurrent: 10 }, operator);
    expect((await settings.runtime()).planNames).toMatchObject({ pro_500: '' });
    for (const target of ['plus', 'pro_5x', 'pro_20x', 'pro_500'] as const) {
      const codes = (await assets.action(
        'cdks',
        'generate',
        { count: 1, plan: target },
        operator
      )) as { codes: string[] };
      expect(await tasks.verify({ code: codes.codes[0] })).toMatchObject({
        plan: target,
        status: 'available'
      });
      const task = await tasks.start({ session: fullSession(), code: codes.codes[0] }, operator);
      expect(task.plan).toBe(target);
      await db.onlineRechargeBill.create({
        data: {
          taskId: task.id,
          plan: target,
          status: 'failed',
          amount: null,
          currency: 'USD',
          idempotencyKey: `${task.id}:schema-fixture`,
          message: '仅验证套餐枚举兼容'
        }
      });
      expect(await db.onlineRechargeBill.findFirst({ where: { taskId: task.id } })).toMatchObject({
        plan: target
      });
    }
    expect(await db.onlineRechargeCode.count()).toBe(4);
    expect(await db.onlineRechargeTask.count()).toBe(4);
  });
  it('500映射默认空，显式配置不得复用旧套餐；第三方未核实前不创建500任务', async () => {
    for (const alias of ['pro', 'chatgptpro', 'chatgptprolite', 'chatgptplusplan', 'pro_20x'])
      await expect(settings.update({ planNamePro500: alias }, operator)).rejects.toThrow(
        '不能复用'
      );
    await settings.update({ planNamePro500: 'fixture-verified-tier-500' }, operator);
    expect((await settings.runtime()).planNames.pro_500).toBe('fixture-verified-tier-500');
    await settings.update({ gptApiEnabled: true }, operator);
    const codes = (await assets.action(
      'cdks',
      'generate',
      { count: 1, plan: 'pro_500' },
      operator
    )) as { codes: string[] };
    await expect(
      tasks.start({ session: fullSession(), code: codes.codes[0] }, operator)
    ).rejects.toThrow('尚未核实支持 Pro 500');
    expect(await db.onlineRechargeTask.count()).toBe(0);
    expect(await db.onlineRechargeCode.findFirst()).toMatchObject({
      status: 'available',
      taskId: null
    });
  });
  it('地址保留独立支付地区与国家，清空按原地区且仅清未绑定', async () => {
    await assets.action(
      'addresses',
      'create',
      {
        region: 'US',
        country: 'PH',
        street: '100 Main St',
        city: 'Synthetic',
        state: 'S'.repeat(100),
        postalCode: '00000'
      },
      operator
    );
    await assets.action(
      'addresses',
      'create',
      {
        region: 'PH',
        country: 'PH',
        street: '200 Main St',
        city: 'Synthetic',
        state: 'Synthetic',
        postalCode: '00000'
      },
      operator
    );
    expect((await repository.list('addresses', { region: 'US' })).total).toBe(1);
    expect((await repository.list('addresses', { country: 'PH' })).total).toBe(2);
    expect((await repository.list('addresses', { country: 'US' })).total).toBe(0);
    await assets.action('addresses', 'clear-unbound', { region: 'US' }, operator);
    expect((await repository.list('addresses', { region: 'US' })).total).toBe(0);
    expect((await repository.list('addresses', { region: 'PH' })).total).toBe(1);
  });
  it('维护只拒绝新充值，维护前已接受任务继续执行且排空状态只读', async () => {
    const accepted = await start();
    await settings.update({ maintenance: true }, operator);
    expect(await settings.get()).toMatchObject({ maintenance: true, maintenanceDrain: true });
    expect(await tasks.publicConfig()).toMatchObject({ maintenance: true, maintenanceDrain: true });
    await expect(start()).rejects.toThrow('维护中');
    await expect(settings.update({ maintenanceWhenIdle: true }, operator)).rejects.toThrow(
      '不支持的字段'
    );
    await expect(settings.update({ maintenanceDrain: false }, operator)).rejects.toThrow(
      '不支持的字段'
    );
    const claim = (await workers.claim('fixture-drain'))!;
    expect(claim.id).toBe(accepted.id);
    await workers.finish(lease(claim, { status: 'failed', definitiveFailure: true }), true);
    expect(await settings.get()).toMatchObject({ maintenance: true, maintenanceDrain: false });
    expect(await tasks.publicConfig()).toMatchObject({
      maintenance: true,
      maintenanceDrain: false
    });
    expect(await workers.claim('fixture-drain')).toBeNull();
    expect(await db.onlineRechargeTask.count()).toBe(1);
  });
  it('已成功绑定地址的编辑和删除由服务端禁止，清空未绑定仍保留它', async () => {
    await assets.action(
      'addresses',
      'create',
      { street: '100 Main St', city: 'Synthetic', state: 'Synthetic', postalCode: '00000' },
      operator
    );
    const bound = (await db.onlineRechargeAddress.findFirst())!;
    await db.onlineRechargeAddress.update({ where: { id: bound.id }, data: { successCount: 1 } });
    await expect(
      assets.action('addresses', 'update', { id: bound.id, street: '200 Main St' }, operator)
    ).rejects.toThrow('不能修改或删除');
    await expect(assets.action('addresses', 'delete', { id: bound.id }, operator)).rejects.toThrow(
      '不能修改或删除'
    );
    await assets.action(
      'addresses',
      'create',
      { street: '300 Main St', city: 'Synthetic', state: 'Synthetic', postalCode: '00000' },
      operator
    );
    await assets.action('addresses', 'clear-unbound', { region: 'US' }, operator);
    expect((await repository.list('addresses', {})).total).toBe(1);
    expect(await db.onlineRechargeAddress.findUnique({ where: { id: bound.id } })).toMatchObject({
      active: true,
      street: '100 Main St',
      successCount: 1
    });
  });
  it('双执行器原子领取只有一个胜者且卡号加密保存', async () => {
    await assets.importCards(
      [{ number: '4242424242424242', expiryMonth: 12, expiryYear: 2030 }],
      operator
    );
    await start();
    const claims = await Promise.all([workers.claim('fixture-a'), workers.claim('fixture-b')]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const card = await workers.reserveCard(lease(claims.find(Boolean)!));
    expect(card).toMatchObject({ card_number: '4242424242424242', hasCvc: true });
    expect(card).not.toHaveProperty('card_cvc');
    const stored = (await db.onlineRechargeCard.findFirst())!;
    expect(stored.numberEncrypted).not.toContain('4242424242424242');
    expect(JSON.stringify(stored)).not.toContain('cvc');
  });
  it('缺失临时安全码会等待补充且不开始付款', async () => {
    credentials.mockResolvedValue([]);
    await assets.importCards(
      [{ number: '4242424242424242', expiryMonth: 12, expiryYear: 2030 }],
      operator
    );
    const task = await start(),
      claim = (await workers.claim('fixture-a'))!;
    expect(await workers.reserveCard(lease(claim))).toMatchObject({ pendingCredentials: true });
    expect(await db.onlineRechargeTask.findUnique({ where: { id: task.id } })).toMatchObject({
      status: 'awaiting_credentials',
      paymentStarted: false
    });
  });
  it('保存卡升级可先无CVC预约，新卡路线仍保持缺码等待', async () => {
    credentials.mockResolvedValue([]);
    await assets.importCards(
      [{ number: '4242424242424242', expiryMonth: 12, expiryYear: 2030 }],
      operator
    );
    const task = await tasks.start({ session: fullSession(), plan: 'pro_500' }, operator);
    const claim = (await workers.claim('fixture-saved-card'))!;
    expect(await workers.reserveCard(lease(claim, { requireCvc: false }))).toMatchObject({
      hasCvc: false
    });
    expect(await db.onlineRechargeTask.findUnique({ where: { id: task.id } })).toMatchObject({
      status: 'running',
      paymentStarted: false
    });
    expect(await workers.reserveCard(lease(claim))).toMatchObject({ pendingCredentials: true });
    expect(await db.onlineRechargeTask.findUnique({ where: { id: task.id } })).toMatchObject({
      status: 'awaiting_credentials',
      paymentStarted: false
    });
  });
  it('Pro 500零应付升级只消费兑换码和确认套餐变更，不计扣款或银行卡次数', async () => {
    const codes = (await assets.action(
      'cdks',
      'generate',
      { count: 1, plan: 'pro_500' },
      operator
    )) as { codes: string[] };
    const identity = randomUUID();
    const task = await tasks.start(
      { session: fullSession(identity), code: codes.codes[0] },
      operator
    );
    const claim = (await workers.claim('fixture-zero-upgrade'))!;
    const card = await prepareCard(claim);
    const { context, checkoutRecovery } = await paymentFor(claim, {
      kind: 'upgrade',
      sourcePlan: 'plus',
      amount: '0.0000'
    });
    await workers.beforeSubmit(lease(claim, { paymentContext: context, checkoutRecovery }));
    await expect(workers.beforeSubmit(lease(claim, { paymentContext: context }))).rejects.toThrow(
      '重复提交'
    );
    const confirmation = {
      source: 'subscription',
      querySucceeded: true,
      verified: true,
      hasActiveSubscription: true,
      accountId: identity,
      expectedAccountId: identity,
      targetPlan: 'pro_500',
      observedPlan: 'pro',
      observedCanonicalPlan: 'pro_500',
      tierVerified: true
    };
    expect(
      await workers.finish(
        lease(claim, {
          status: 'succeeded',
          result: {
            subscriptionChangedVerified: true,
            confirmedPaid: false,
            confirmation,
            paymentEvidence: { ...context, source: 'subscription_change', verified: true }
          }
        }),
        false
      )
    ).toMatchObject({ status: 'succeeded' });
    expect(await db.onlineRechargeTask.findUnique({ where: { id: task.id } })).toMatchObject({
      status: 'succeeded',
      confirmedPaid: false
    });
    expect(await db.onlineRechargeCode.findFirst()).toMatchObject({
      status: 'used',
      taskId: task.id
    });
    expect(await db.onlineRechargeCard.findUnique({ where: { id: card.id } })).toMatchObject({
      leaseOwner: null,
      successCount: 0
    });
    expect(await db.onlineRechargeBill.count()).toBe(0);
  });
  it('安全码丢失后补充只恢复同任务、同兑换码和原选择卡，不创建新单', async () => {
    const codes = (await assets.action(
      'cdks',
      'generate',
      { count: 1, plan: 'plus' },
      operator
    )) as { codes: string[] };
    await assets.importCards(
      [
        { number: '4242424242424242', expiryMonth: 12, expiryYear: 2030 },
        { number: '4000000000000002', expiryMonth: 12, expiryYear: 2030 }
      ],
      operator
    );
    credentials.mockResolvedValue([]);
    const task = await start(randomUUID(), codes.codes[0]),
      first = (await workers.claim('fixture-a'))!;
    const pending = (await workers.reserveCard(lease(first))) as {
      cardId: string;
      pendingCredentials: boolean;
    };
    expect(pending.pendingCredentials).toBe(true);
    await workers.finish(lease(first, { status: 'pending_credentials' }), true);
    expect(await workers.claim('fixture-b')).toBeNull();
    await assets.action('cards', 'cvc', { id: pending.cardId, cvc: '123' }, operator);
    credentials.mockImplementation(async (ids) => ids);
    const resumed = (await workers.claim('fixture-b'))!;
    expect(resumed.id).toBe(task.id);
    expect(resumed.leaseVersion).toBeGreaterThan(first.leaseVersion);
    expect(await workers.reserveCard(lease(resumed))).toMatchObject({
      id: pending.cardId,
      hasCvc: true
    });
    expect(await db.onlineRechargeTask.count()).toBe(1);
    expect(await db.onlineRechargeCode.findFirst()).toMatchObject({
      status: 'reserved',
      taskId: task.id
    });
    expect(
      (await db.onlineRechargeTask.findUnique({ where: { id: task.id } }))?.paymentStarted
    ).toBe(false);
    await expect(workers.beforeSubmit(lease(first))).rejects.toThrow('租约失效');
  });
  it('旧租约到期后不能释放新执行器持有的卡', async () => {
    await assets.importCards(
      [{ number: '4242424242424242', expiryMonth: 12, expiryYear: 2030 }],
      operator
    );
    await start();
    const first = (await workers.claim('fixture-a'))!;
    const card = (await workers.reserveCard(lease(first))) as { id: string };
    await db.onlineRechargeTask.update({
      where: { id: first.id },
      data: { leaseExpiresAt: new Date(0) }
    });
    const second = (await workers.claim('fixture-b'))!;
    await workers.reserveCard(lease(second));
    await expect(
      workers.cardAction(lease(first, { cardId: card.id }), 'releaseCard')
    ).rejects.toThrow('租约失效');
    expect((await db.onlineRechargeCard.findUnique({ where: { id: card.id } }))?.leaseOwner).toBe(
      second.id
    );
  });
  it('提交付款后崩溃不会重新领取，兑换码仍为保留', async () => {
    const codes = (await assets.action(
      'cdks',
      'generate',
      { count: 1, plan: 'plus' },
      operator
    )) as { codes: string[] };
    await start(randomUUID(), codes.codes[0]);
    const claim = (await workers.claim('fixture-a'))!;
    await prepareCard(claim);
    await submitPayment(claim);
    await db.onlineRechargeTask.update({
      where: { id: claim.id },
      data: { leaseExpiresAt: new Date(0) }
    });
    expect(await workers.claim('fixture-b')).toBeNull();
    expect((await db.onlineRechargeTask.findUnique({ where: { id: claim.id } }))?.status).toBe(
      'awaiting_review'
    );
    expect((await db.onlineRechargeCode.findFirst())?.status).toBe('reserved');
    await expect(
      workers.finish(lease(claim, { status: 'succeeded', result: { confirmedPaid: true } }), false)
    ).rejects.toThrow('租约失效');
  });
  it('银行卡计数幂等，支付后记账失败保留待核对而非重试', async () => {
    await start();
    const claim = (await workers.claim('fixture-a'))!;
    const card = await prepareCard(claim);
    const payment = await submitPayment(claim);
    await workers.cardAction(
      lease(claim, { cardId: card.id, paymentEvidence: payment.evidence }),
      'recordCardUsage'
    );
    await workers.cardAction(
      lease(claim, { cardId: card.id, paymentEvidence: payment.evidence }),
      'recordCardUsage'
    );
    expect((await db.onlineRechargeCard.findUnique({ where: { id: card.id } }))?.successCount).toBe(
      1
    );
    await expect(
      workers.billing(
        lease(claim, { amount: 20, amountSource: 'checkout', currency: 'USD', status: 'success' })
      )
    ).rejects.toThrow('Decimal');
    expect(
      await workers.finish(lease(claim, { status: 'failed', message: '本地记账失败' }), true)
    ).toMatchObject({ status: 'awaiting_review' });
    expect((await db.onlineRechargeCard.findUnique({ where: { id: card.id } }))?.leaseOwner).toBe(
      claim.id
    );
  });
  it('第三方提交幂等，不接受第二次建单和本地账单', async () => {
    await settings.update({ gptApiEnabled: true }, operator);
    await start();
    const claim = (await workers.claim('fixture-a'))!;
    await prepareCard(claim);
    await workers.beforeSubmit(lease(claim));
    await expect(workers.beforeSubmit(lease(claim))).rejects.toThrow('禁止再次建单');
    await expect(
      workers.billing(lease(claim, { amount: '20', amountSource: 'checkout' }))
    ).rejects.toThrow('不写入本地账单');
    expect(
      await workers.finish(lease(claim, { status: 'failed', definitiveFailure: true }), true)
    ).toMatchObject({ status: 'failed' });
  });
  it('成功确认前重复记次和账单只执行一次，成功后迟到回调和旧版本不可覆盖', async () => {
    const codes = (await assets.action(
      'cdks',
      'generate',
      { count: 1, plan: 'plus' },
      operator
    )) as { codes: string[] };
    const task = await start(randomUUID(), codes.codes[0]),
      claim = (await workers.claim('fixture-a'))!;
    const card = await prepareCard(claim);
    const cardArgs = {
      cardId: card.id,
      cardLeaseId: card.leaseId,
      cardLeaseVersion: card.leaseVersion
    };
    const payment = await submitPayment(claim, cardArgs);
    const usageArgs = { ...cardArgs, paymentEvidence: payment.evidence };
    await Promise.all([
      workers.cardAction(lease(claim, usageArgs), 'recordCardUsage'),
      workers.cardAction(lease(claim, usageArgs), 'recordCardUsage')
    ]);
    const bill = {
      amount: '20.1000',
      amountSource: 'checkout',
      checkoutId: 'synthetic-confirmed-checkout',
      currency: 'USD',
      status: 'success',
      paymentEvidence: payment.evidence
    };
    await Promise.all([workers.billing(lease(claim, bill)), workers.billing(lease(claim, bill))]);
    const confirmation = {
      verified: true,
      source: 'subscription',
      querySucceeded: true,
      hasActiveSubscription: true,
      accountId: sessionAccountId(claim.session),
      expectedAccountId: sessionAccountId(claim.session),
      targetPlan: 'plus',
      observedPlan: 'chatgptplusplan'
    };
    expect(
      await workers.finish(
        lease(claim, {
          status: 'succeeded',
          result: { confirmedPaid: true, confirmation, paymentEvidence: payment.evidence }
        }),
        false
      )
    ).toMatchObject({ status: 'succeeded' });
    await expect(
      workers.finish(lease(claim, { status: 'failed', definitiveFailure: true }), true)
    ).rejects.toThrow('租约失效');
    await expect(workers.cardAction(lease(claim, cardArgs), 'recordCardUsage')).rejects.toThrow(
      '租约失效'
    );
    await expect(
      workers.billing(lease({ ...claim, leaseVersion: claim.leaseVersion - 1 }, bill))
    ).rejects.toThrow('租约失效');
    expect(await db.onlineRechargeBill.count()).toBe(1);
    expect((await db.onlineRechargeCard.findUnique({ where: { id: card.id } }))?.successCount).toBe(
      1
    );
    expect(await db.onlineRechargeTask.findUnique({ where: { id: task.id } })).toMatchObject({
      status: 'succeeded',
      confirmedPaid: true
    });
    expect(await db.onlineRechargeCode.findFirst()).toMatchObject({
      status: 'used',
      taskId: task.id
    });
  });
  it('付款前卡租约失效或版本变化会关闭外部提交', async () => {
    await start();
    const claim = (await workers.claim('fixture-a'))!,
      card = await prepareCard(claim);
    await expect(
      workers.beforeSubmit(
        lease(claim, { cardId: card.id, cardLeaseVersion: card.leaseVersion - 1 })
      )
    ).rejects.toThrow('银行卡租约失效');
    await db.onlineRechargeCard.update({
      where: { id: card.id },
      data: { leaseExpiresAt: new Date(0) }
    });
    await expect(workers.beforeSubmit(lease(claim))).rejects.toThrow('银行卡租约');
    expect(
      (await db.onlineRechargeTask.findUnique({ where: { id: claim.id } }))?.paymentStarted
    ).toBe(false);
  });
  it('提交后不能重复付款或更换卡，明确拒付只结束原任务', async () => {
    await assets.importCards(
      [
        { number: '4242424242424242', expiryMonth: 12, expiryYear: 2030 },
        { number: '4000000000000002', expiryMonth: 12, expiryYear: 2030 }
      ],
      operator
    );
    await start();
    const claim = (await workers.claim('fixture-a'))!;
    const first = (await workers.reserveCard(lease(claim))) as { id: string };
    await submitPayment(claim);
    await expect(
      workers.cardAction(lease(claim, { cardId: first.id, confirmed: true }), 'releaseCard')
    ).rejects.toThrow('不能释放');
    await workers.cardAction(lease(claim, { cardId: first.id }), 'recordCardDecline');
    await workers.cardAction(lease(claim, { cardId: first.id }), 'releaseCard');
    await expect(workers.reserveCard(lease(claim, { excludedIds: [first.id] }))).rejects.toThrow(
      '不能更换银行卡'
    );
    await expect(workers.beforeSubmit(lease(claim))).rejects.toThrow('重复提交');
    await workers.finish(lease(claim, { status: 'failed', definitiveFailure: true }), true);
    expect(await db.onlineRechargeCard.findUnique({ where: { id: first.id } })).toMatchObject({
      leaseOwner: null
    });
  });
  for (const action of ['enable', 'disable'] as const) {
    it(`续费${action}持久记录一次意图，同账号状态确认不写付款账单`, async () => {
      const original = await tasks.start(
        { session: fullSession(), plan: 'plus', action },
        operator,
        'renewal'
      );
      const claim = (await workers.claim('fixture-renewal'))!;
      expect(claim.id).toBe(original.id);
      const submission = lease(claim, { stage: 'renewal_update', renewalAction: action });
      await workers.beforeSubmit(submission);
      await expect(workers.beforeSubmit(submission)).rejects.toThrow('禁止重复提交');
      expect(await db.onlineRechargeTask.findUnique({ where: { id: original.id } })).toMatchObject({
        stage: 'renewal_submitted',
        paymentStarted: false,
        confirmedPaid: false,
        payload: { action, renewalSubmission: { action, leaseVersion: claim.leaseVersion } }
      });
      expect(await db.onlineRechargeCard.count()).toBe(0);
      await expect(
        workers.finish(
          lease(claim, {
            status: 'succeeded',
            result: {
              ok: true,
              data: {
                upstreamAccountId: sessionAccountId(claim.session),
                autoRenewRaw: action === 'enable'
              }
            }
          }),
          false
        )
      ).resolves.toMatchObject({ status: 'succeeded' });
      expect(await db.onlineRechargeTask.findUnique({ where: { id: original.id } })).toMatchObject({
        status: 'succeeded',
        paymentStarted: false,
        confirmedPaid: false
      });
      expect(await db.onlineRechargeBill.count()).toBe(0);
    });
  }
  it('续费意图提交后租约过期转待核对，不重领且阻止同账号新变更', async () => {
    const session = fullSession();
    const original = await tasks.start(
      { session, plan: 'plus', action: 'disable' },
      operator,
      'renewal'
    );
    const claim = (await workers.claim('fixture-renewal'))!;
    await workers.beforeSubmit(lease(claim, { stage: 'renewal_update', renewalAction: 'disable' }));
    await db.onlineRechargeTask.update({
      where: { id: original.id },
      data: { leaseExpiresAt: new Date(0) }
    });
    expect(await workers.claim('fixture-replacement')).toBeNull();
    expect(await db.onlineRechargeTask.findUnique({ where: { id: original.id } })).toMatchObject({
      status: 'awaiting_review',
      paymentStarted: false,
      confirmedPaid: false,
      payload: { renewalSubmission: { action: 'disable' } }
    });
    await expect(
      tasks.start({ session, plan: 'plus', action: 'enable' }, operator, 'renewal')
    ).rejects.toThrow('先核对原任务');
    expect(await db.onlineRechargeTask.count()).toBe(1);
    expect(await db.onlineRechargeBill.count()).toBe(0);
  });
  it('账单汇总通过真实MySQL区分未知金额并保留成功记录', async () => {
    const task = await db.onlineRechargeTask.create({
      data: { status: 'succeeded', confirmedPaid: true, message: '合成账务核对任务' }
    });
    const first = await db.onlineRechargeBill.create({
      data: {
        taskId: task.id,
        plan: 'plus',
        status: 'success',
        amount: '20.1234',
        currency: 'USD',
        idempotencyKey: randomUUID(),
        message: '合成已知金额'
      }
    });
    await db.onlineRechargeBill.create({
      data: {
        taskId: task.id,
        plan: 'plus',
        status: 'success',
        amount: null,
        currency: 'USD',
        idempotencyKey: randomUUID(),
        message: '合成未知金额'
      }
    });
    expect(await admin.action('billing', 'summary', {}, operator)).toEqual([
      {
        cardLast4: null,
        currency: 'USD',
        amount: null,
        knownAmount: '20.1234',
        count: 2,
        knownAmountCount: 1,
        unknownAmountCount: 1,
        isComplete: false
      }
    ]);
    expect((await admin.overview()).billing[0]).toMatchObject({
      amount: null,
      knownAmount: '20.1234',
      unknownAmountCount: 1,
      isComplete: false
    });
    await expect(admin.action('billing', 'delete', { ids: [first.id] }, operator)).rejects.toThrow(
      '必须保留'
    );
    expect(await db.onlineRechargeBill.count()).toBe(2);
  });
  it('失败账单清理逐条保存原始金额与关联审计', async () => {
    const task = await db.onlineRechargeTask.create({
      data: { status: 'failed', confirmedPaid: false, message: '合成明确失败任务' }
    });
    const row = await db.onlineRechargeBill.create({
      data: {
        taskId: task.id,
        plan: 'plus',
        status: 'failed',
        amount: '20.1234',
        currency: 'USD',
        idempotencyKey: randomUUID(),
        message: '合成失败账单'
      }
    });
    await admin.action('billing', 'delete', { ids: [row.id] }, operator);
    expect(await db.onlineRechargeBill.findUnique({ where: { id: row.id } })).toBeNull();
    const audit = await db.auditLog.findFirst({
      where: { objectId: row.id, action: 'id_business_v2.online_recharge.billing.delete' }
    });
    expect(audit?.afterData).toMatchObject({
      count: 1,
      deletedBill: { id: row.id, taskId: task.id, amount: '20.1234', currency: 'USD' }
    });
  });
  it('已确认付款的失败任务不能清理账单，审计写入失败则整笔回滚', async () => {
    const task = await db.onlineRechargeTask.create({
      data: { status: 'failed', confirmedPaid: true, message: '合成已付款任务' }
    });
    const row = await db.onlineRechargeBill.create({
      data: {
        taskId: task.id,
        plan: 'plus',
        status: 'failed',
        amount: '20',
        currency: 'USD',
        idempotencyKey: randomUUID(),
        message: '合成受保护账单'
      }
    });
    await expect(admin.action('billing', 'delete', { ids: [row.id] }, operator)).rejects.toThrow(
      '不能清理'
    );
    await db.onlineRechargeTask.update({ where: { id: task.id }, data: { confirmedPaid: false } });
    const audit = vi.spyOn(repository, 'log').mockRejectedValueOnce(new Error('合成审计故障'));
    try {
      await expect(admin.action('billing', 'delete', { ids: [row.id] }, operator)).rejects.toThrow(
        '合成审计故障'
      );
    } finally {
      audit.mockRestore();
    }
    expect(await db.onlineRechargeBill.findUnique({ where: { id: row.id } })).not.toBeNull();
  });
  it('待核对和来源缺失的账单不能清理', async () => {
    const row = await db.onlineRechargeBill.create({
      data: {
        taskId: randomUUID(),
        plan: 'plus',
        status: 'result_unknown',
        currency: 'USD',
        idempotencyKey: randomUUID(),
        message: '合成来源缺失账单'
      }
    });
    await expect(admin.action('billing', 'delete', { ids: [row.id] }, operator)).rejects.toThrow(
      '必须保留'
    );
    await db.onlineRechargeBill.update({ where: { id: row.id }, data: { status: 'failed' } });
    await expect(admin.action('billing', 'clear-failed', {}, operator)).rejects.toThrow('不能清理');
    expect(await db.onlineRechargeBill.findUnique({ where: { id: row.id } })).not.toBeNull();
  });
  it('账单实际金额Decimal，未知金额不落估算', async () => {
    await start();
    const claim = (await workers.claim('fixture-a'))!;
    await workers.billing(
      lease(claim, {
        amount: '20.10',
        amountSource: 'checkout',
        checkoutId: 'synthetic-checkout-1',
        currency: 'USD',
        status: 'success'
      })
    );
    await workers.billing(
      lease(claim, {
        amount: '20.10',
        amountSource: 'checkout',
        checkoutId: 'synthetic-checkout-1',
        currency: 'USD',
        status: 'success'
      })
    );
    expect(await db.onlineRechargeBill.count()).toBe(1);
    expect((await db.onlineRechargeBill.findFirst())?.amount?.toString()).toBe('20.1');
    await workers.billing(
      lease(claim, {
        amount: '20',
        amountSource: 'estimated',
        checkoutId: 'synthetic-checkout-2',
        currency: 'USD',
        status: 'failed'
      })
    );
    expect(
      (await db.onlineRechargeBill.findFirst({ where: { checkoutId: 'synthetic-checkout-2' } }))
        ?.amount
    ).toBeNull();
  });
  it('计卡已确认后进程中断，重启只读核对复用原证据补账单订单且不重计卡', async () => {
    const original = await start();
    const first = (await workers.claim('fixture-before-crash'))!;
    const card = await prepareCard(first);
    const payment = await submitPayment(first);
    await workers.cardAction(
      lease(first, { cardId: card.id, paymentEvidence: payment.evidence }),
      'recordCardUsage'
    );
    expect(await db.onlineRechargeTask.findUnique({ where: { id: original.id } })).toMatchObject({
      status: 'running',
      confirmedPaid: true,
      result: { paymentEvidence: payment.evidence }
    });
    expect(await db.onlineRechargeBill.count()).toBe(0);
    await db.onlineRechargeTask.update({
      where: { id: original.id },
      data: { leaseExpiresAt: new Date(0) }
    });
    expect(await workers.claim('fixture-after-restart')).toBeNull();
    await tasks.action('jobs', 'recheck', { id: original.id }, operator);
    const recheck = (await workers.claim('fixture-read-only-recovery'))!;
    const saved = (recheck.payload as Record<string, unknown>).originalPaymentEvidence;
    expect(saved).toEqual(payment.evidence);
    await workers.finish(
      lease(recheck, {
        status: 'succeeded',
        result: {
          confirmedPaid: true,
          paymentEvidence: saved,
          confirmation: {
            verified: true,
            source: 'subscription',
            querySucceeded: true,
            hasActiveSubscription: true,
            accountId: payment.context.accountId,
            expectedAccountId: payment.context.accountId,
            targetPlan: 'plus',
            observedPlan: 'plus',
            observedCanonicalPlan: 'plus',
            tierVerified: true
          }
        }
      }),
      false
    );
    expect(await db.onlineRechargeTask.findUnique({ where: { id: original.id } })).toMatchObject({
      status: 'succeeded',
      confirmedPaid: true
    });
    expect(await db.onlineRechargeCard.findUnique({ where: { id: card.id } })).toMatchObject({
      successCount: 1,
      leaseOwner: null
    });
    expect(
      await db.onlineRechargeBill.count({ where: { taskId: original.id, status: 'success' } })
    ).toBe(1);
    expect(
      await db.onlineRechargeEvent.count({
        where: { dedupeKey: `${original.id}:${card.id}:recordCardUsage` }
      })
    ).toBe(1);
    expect(await db.onlineRechargeOrderSync.count({ where: { taskId: original.id } })).toBe(1);
  }, 30000);

  it('缺恢复身份、错绑或加密失败均回滚付款前事务，不能留下半份提交资料', async () => {
    await start();
    const claim = (await workers.claim('fixture-atomic'))!;
    await prepareCard(claim);
    const payment = await paymentFor(claim);
    for (const args of [
      { paymentContext: payment.context },
      {
        paymentContext: payment.context,
        checkoutRecovery: { ...payment.checkoutRecovery, cardId: randomUUID() }
      }
    ]) {
      await expect(workers.beforeSubmit(lease(claim, args))).rejects.toThrow();
      const row = await db.onlineRechargeTask.findUniqueOrThrow({ where: { id: claim.id } });
      expect(row.paymentStarted).toBe(false);
      expect(row.payload).not.toHaveProperty('checkoutRecoveryEncrypted');
      expect(row.payload).not.toHaveProperty('paymentContext');
    }
    const failedEncryption = vi.spyOn(encryption, 'encrypt').mockImplementationOnce(() => {
      throw new Error('synthetic encryption failure');
    });
    try {
      await expect(
        workers.beforeSubmit(
          lease(claim, {
            paymentContext: payment.context,
            checkoutRecovery: payment.checkoutRecovery
          })
        )
      ).rejects.toThrow('synthetic encryption failure');
    } finally {
      failedEncryption.mockRestore();
    }
    const row = await db.onlineRechargeTask.findUniqueOrThrow({ where: { id: claim.id } });
    expect(row.paymentStarted).toBe(false);
    expect(row.payload).not.toHaveProperty('checkoutRecoveryEncrypted');
    expect(row.payload).not.toHaveProperty('paymentContext');
    expect(
      await db.auditLog.count({
        where: {
          objectId: claim.id,
          action: 'id_business_v2.online_recharge.worker.payment_submitted'
        }
      })
    ).toBe(0);
  }, 30000);

  describe('历史付款人工结案', () => {
    const legacyOriginal = async () => {
      const identity = randomUUID();
      await start(identity);
      const claim = (await workers.claim('fixture-manual-close'))!;
      const card = await prepareCard(claim);
      const initial = await db.onlineRechargeTask.findUniqueOrThrow({ where: { id: claim.id } });
      const payload = { ...(initial.payload as Prisma.InputJsonObject) };
      delete payload.checkoutRecoveryVersion;
      await db.onlineRechargeTask.update({ where: { id: claim.id }, data: { payload } });
      const payment = await paymentFor(claim);
      await workers.beforeSubmit(lease(claim, { paymentContext: payment.context }));
      await workers.billing(
        lease(claim, {
          status: 'failed',
          currency: 'USD',
          error_code: 'form_validation_failed',
          message: '合成历史失败账单'
        })
      );
      await workers.finish(
        lease(claim, {
          status: 'awaiting_review',
          result: {
            success: false,
            resultUnknown: true,
            error: '合成历史验证失败',
            errorCode: 'VERIFICATION_UNSUPPORTED'
          }
        }),
        true
      );
      const row = await db.onlineRechargeTask.findUniqueOrThrow({ where: { id: claim.id } });
      const input = {
        id: row.id,
        version: row.updatedAt.toISOString(),
        requestId: randomUUID(),
        userConfirmedNotCharged: true,
        confirmationSource: 'user_statement',
        confirmationReference: '合成用户在会话中明确确认未扣款',
        reason: '用户要求停用旧卡换新卡'
      };
      return { row, claim, card, identity, payment, input };
    };
    const close = (input: Record<string, unknown>) =>
      tasks.action('jobs', 'resolve-not-charged', input, operator);
    it('人工结案同事务保留原提交、历史账单和审计，停用旧卡后同账号仅能创建一个新任务', async () => {
      const f = await legacyOriginal();
      const bills = await db.onlineRechargeBill.findMany({ where: { taskId: f.row.id } });
      const oldEvents = await db.onlineRechargeEvent.findMany({ where: { taskId: f.row.id } });
      const oldAudits = await db.auditLog.findMany({ where: { objectId: f.row.id } });
      const results = await Promise.all([close(f.input), close(f.input)]);
      expect(results).toEqual([{ success: true }, { success: true }]);
      const resolved = await db.onlineRechargeTask.findUniqueOrThrow({ where: { id: f.row.id } });
      const originalPayload = f.row.payload as Record<string, unknown>;
      expect(resolved).toMatchObject({
        status: 'failed',
        paymentStarted: true,
        confirmedPaid: false,
        leaseVersion: f.row.leaseVersion + 1,
        payload: {
          ...originalPayload,
          reconciliation: {
            ...(originalPayload.reconciliation as object),
            stopped: true,
            nextAttemptAt: null
          }
        },
        result: {
          ...(f.row.result as object),
          manualNotChargedResolution: {
            confirmationSource: 'user_statement',
            paymentProviderVerified: false,
            requestId: f.input.requestId
          }
        }
      });
      expect(await db.onlineRechargeCard.findUnique({ where: { id: f.card.id } })).toMatchObject({
        status: 'disabled',
        leaseOwner: null,
        successCount: 0,
        declineCount: 0
      });
      expect(await db.onlineRechargeBill.findMany({ where: { taskId: f.row.id } })).toEqual(bills);
      for (const event of oldEvents)
        expect(await db.onlineRechargeEvent.findUnique({ where: { id: event.id } })).toEqual(event);
      for (const audit of oldAudits)
        expect(await db.auditLog.findUnique({ where: { id: audit.id } })).toEqual(audit);
      expect(
        await db.auditLog.count({
          where: {
            objectId: f.row.id,
            action: 'id_business_v2.online_recharge.tasks.resolve_not_charged'
          }
        })
      ).toBe(1);
      expect(
        await db.auditLog.count({
          where: {
            objectId: f.row.id,
            action: 'id_business_v2.online_recharge.worker.payment_submitted'
          }
        })
      ).toBe(1);
      expect(await workers.claim('fixture-must-not-repay-old')).toBeNull();
      await expect(
        workers.beforeSubmit(lease(f.claim, { paymentContext: f.payment.context }))
      ).rejects.toThrow('租约失效');
      const fresh = await assets.importCards(
        [{ number: '4000000000000002', expiryMonth: 12, expiryYear: 2030 }],
        operator
      );
      const newCardId = fresh.ids[0]!;
      const created = await Promise.allSettled(
        [0, 1].map(() =>
          tasks.start(
            {
              session: fullSession(f.identity),
              plan: 'plus',
              cardId: newCardId,
              paymentLimit: { currency: 'USD', maxAmount: '30' }
            },
            operator
          )
        )
      );
      expect(created.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(await db.onlineRechargeTask.count({ where: { operation: 'recharge' } })).toBe(2);
      expect(
        await db.onlineRechargeTask.findFirst({
          where: { status: 'queued', operation: 'recharge' }
        })
      ).toMatchObject({
        paymentStarted: false,
        confirmedPaid: false,
        payload: { cardId: newCardId }
      });
      expect(
        await db.idBusinessV2BankRechargeOrder.count({ where: { onlineRechargeTaskId: f.row.id } })
      ).toBe(0);
    }, 30000);

    it('人工结案审计失败时真实事务回滚任务、旧卡和新事件', async () => {
      const f = await legacyOriginal();
      const card = await db.onlineRechargeCard.findUniqueOrThrow({ where: { id: f.card.id } });
      const beforeEvents = await db.onlineRechargeEvent.count({ where: { taskId: f.row.id } });
      const log = vi.spyOn(repository, 'log');
      const originalLog = log.getMockImplementation();
      log.mockImplementation((tx, action, actor, objectId, data) => {
        if (action === 'tasks.resolve_not_charged') throw new Error('synthetic audit failure');
        return originalLog!(tx, action, actor, objectId, data);
      });
      try {
        await expect(close(f.input)).rejects.toThrow('synthetic audit failure');
      } finally {
        log.mockRestore();
      }
      expect(await db.onlineRechargeTask.findUnique({ where: { id: f.row.id } })).toEqual(f.row);
      expect(await db.onlineRechargeCard.findUnique({ where: { id: f.card.id } })).toEqual(card);
      expect(await db.onlineRechargeEvent.count({ where: { taskId: f.row.id } })).toBe(
        beforeEvents
      );
      expect(
        await db.auditLog.count({
          where: {
            objectId: f.row.id,
            action: 'id_business_v2.online_recharge.tasks.resolve_not_charged'
          }
        })
      ).toBe(0);
    }, 30000);

    it('人工结案和原单核对并发只有一方受理，不会放过正在核对的原单', async () => {
      const f = await legacyOriginal();
      const outcomes = await Promise.allSettled([
        close(f.input),
        tasks.action('jobs', 'recheck', { id: f.row.id }, operator)
      ]);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      const row = await db.onlineRechargeTask.findUniqueOrThrow({ where: { id: f.row.id } });
      const rechecks = await db.onlineRechargeTask.count({
        where: { operation: 'subscription', status: 'queued' }
      });
      expect(row.paymentStarted).toBe(true);
      expect(row.confirmedPaid).toBe(false);
      expect(
        row.status === 'failed'
          ? rechecks === 0
          : row.status === 'awaiting_review' && rechecks === 1
      ).toBe(true);
      expect(
        await db.onlineRechargeBill.count({ where: { taskId: f.row.id, status: 'success' } })
      ).toBe(0);
    }, 30000);

    it('人工结案和同账号新建任务并发仍保留唯一任务和旧卡付款保护', async () => {
      const f = await legacyOriginal();
      const imported = await assets.importCards(
        [{ number: '4000000000000002', expiryMonth: 12, expiryYear: 2030 }],
        operator
      );
      const input = { session: fullSession(f.identity), plan: 'plus', cardId: imported.ids[0]! };
      const outcomes = await Promise.allSettled([close(f.input), tasks.start(input, operator)]);
      expect(outcomes[0]!.status).toBe('fulfilled');
      if (outcomes[1]!.status === 'rejected') await tasks.start(input, operator);
      expect(
        await db.onlineRechargeTask.count({ where: { status: 'queued', operation: 'recharge' } })
      ).toBe(1);
      expect(await db.onlineRechargeTask.findUnique({ where: { id: f.row.id } })).toMatchObject({
        status: 'failed',
        paymentStarted: true
      });
      expect(await db.onlineRechargeCard.findUnique({ where: { id: f.card.id } })).toMatchObject({
        status: 'disabled',
        successCount: 0,
        declineCount: 0
      });
    }, 30000);

    it('人工结案拒绝已有付款证据、成功账单、新恢复任务和活跃核对', async () => {
      const f = await legacyOriginal();
      await db.onlineRechargeTask.update({
        where: { id: f.row.id },
        data: {
          result: {
            ...(f.row.result as object),
            paymentEvidence: f.payment.evidence
          }
        }
      });
      let row = await db.onlineRechargeTask.findUniqueOrThrow({ where: { id: f.row.id } });
      await expect(close({ ...f.input, version: row.updatedAt.toISOString() })).rejects.toThrow(
        '存在付款或入账证据'
      );
      await db.onlineRechargeTask.update({
        where: { id: f.row.id },
        data: { result: f.row.result as Prisma.InputJsonValue }
      });
      const paidBill = await db.onlineRechargeBill.create({
        data: {
          taskId: f.row.id,
          plan: 'plus',
          status: 'success',
          currency: 'USD',
          amount: '20.1000',
          idempotencyKey: randomUUID(),
          message: 'synthetic paid'
        }
      });
      row = await db.onlineRechargeTask.findUniqueOrThrow({ where: { id: f.row.id } });
      await expect(close({ ...f.input, version: row.updatedAt.toISOString() })).rejects.toThrow(
        '存在付款或入账证据'
      );
      await db.onlineRechargeBill.delete({ where: { id: paidBill.id } });
      await db.onlineRechargeTask.update({
        where: { id: f.row.id },
        data: { payload: { ...(f.row.payload as object), checkoutRecoveryVersion: 1 } }
      });
      row = await db.onlineRechargeTask.findUniqueOrThrow({ where: { id: f.row.id } });
      await expect(close({ ...f.input, version: row.updatedAt.toISOString() })).rejects.toThrow(
        '已有原单恢复能力'
      );
      await db.onlineRechargeTask.update({
        where: { id: f.row.id },
        data: { payload: f.row.payload as Prisma.InputJsonValue }
      });
      await tasks.action('jobs', 'recheck', { id: f.row.id }, operator);
      row = await db.onlineRechargeTask.findUniqueOrThrow({ where: { id: f.row.id } });
      await expect(close({ ...f.input, version: row.updatedAt.toISOString() })).rejects.toThrow(
        '仍有执行或核对任务'
      );
      expect(await db.onlineRechargeTask.findUnique({ where: { id: f.row.id } })).toMatchObject({
        status: 'awaiting_review',
        paymentStarted: true
      });
    }, 30000);

    it('人工结案与核对完成写入竞争时冲突安全回滚，不清付款标记或部分释放旧卡', async () => {
      const f = await legacyOriginal();
      await tasks.action('jobs', 'recheck', { id: f.row.id }, operator);
      const recheck = (await workers.claim('fixture-concurrent-recheck-finish'))!;
      const beforeCard = await db.onlineRechargeCard.findUniqueOrThrow({
        where: { id: f.card.id }
      });
      const beforeBills = await db.onlineRechargeBill.findMany({ where: { taskId: f.row.id } });
      const outcomes = await Promise.allSettled([
        close(f.input),
        workers.finish(
          lease(recheck, { status: 'failed', result: { success: false, resultUnknown: true } }),
          true
        )
      ]);
      for (const outcome of outcomes)
        if (outcome.status === 'rejected') expect(outcome.reason).toBeInstanceOf(ConflictException);
      const row = await db.onlineRechargeTask.findUniqueOrThrow({ where: { id: f.row.id } });
      const closeAudits = await db.auditLog.count({
        where: {
          objectId: f.row.id,
          action: 'id_business_v2.online_recharge.tasks.resolve_not_charged'
        }
      });
      const closeEvents = await db.onlineRechargeEvent.count({
        where: { dedupeKey: `${f.row.id}:manual-not-charged` }
      });
      expect(row.paymentStarted).toBe(true);
      expect(row.confirmedPaid).toBe(false);
      if (outcomes[0]!.status === 'rejected') {
        expect(row.status).toBe('awaiting_review');
        expect(row.result).not.toHaveProperty('manualNotChargedResolution');
        expect(row.leaseVersion).toBe(f.row.leaseVersion);
        expect(await db.onlineRechargeCard.findUnique({ where: { id: f.card.id } })).toEqual(
          beforeCard
        );
        expect(closeAudits).toBe(0);
        expect(closeEvents).toBe(0);
      } else {
        expect(row.status).toBe('failed');
        expect(row.result).toHaveProperty(
          'manualNotChargedResolution.paymentProviderVerified',
          false
        );
        expect(row.leaseVersion).toBe(f.row.leaseVersion + 1);
        expect(await db.onlineRechargeCard.findUnique({ where: { id: f.card.id } })).toMatchObject({
          status: 'disabled',
          leaseOwner: null,
          successCount: beforeCard.successCount,
          declineCount: beforeCard.declineCount
        });
        expect(closeAudits).toBe(1);
        expect(closeEvents).toBe(1);
      }
      expect(await db.onlineRechargeBill.findMany({ where: { taskId: f.row.id } })).toEqual(
        beforeBills
      );
      expect(await db.onlineRechargeOrderSync.count({ where: { taskId: f.row.id } })).toBe(0);
      expect(
        await db.auditLog.count({
          where: {
            objectId: f.row.id,
            action: 'id_business_v2.online_recharge.worker.payment_submitted'
          }
        })
      ).toBe(1);
    }, 30000);

    it('人工结案后的迟到旧租约和核对回执不能覆盖结案或补出成功账单', async () => {
      const f = await legacyOriginal();
      await tasks.action('jobs', 'recheck', { id: f.row.id }, operator);
      const recheck = (await workers.claim('fixture-before-manual-close'))!;
      await workers.finish(lease(recheck, { status: 'failed', result: { success: false } }), true);
      const current = await db.onlineRechargeTask.findUniqueOrThrow({ where: { id: f.row.id } });
      await close({ ...f.input, version: current.updatedAt.toISOString() });
      const before = await db.onlineRechargeTask.findUniqueOrThrow({ where: { id: f.row.id } });
      await expect(
        workers.finish(
          lease(recheck, {
            status: 'succeeded',
            result: {
              success: true,
              confirmedPaid: true,
              paymentEvidence: f.payment.evidence,
              confirmation: {
                verified: true,
                querySucceeded: true,
                source: 'subscription',
                hasActiveSubscription: true,
                accountId: f.identity,
                expectedAccountId: f.identity,
                targetPlan: 'plus',
                observedPlan: 'chatgptplusplan'
              }
            }
          }),
          false
        )
      ).rejects.toThrow('租约失效');
      await expect(
        workers.beforeSubmit(lease(f.claim, { paymentContext: f.payment.context }))
      ).rejects.toThrow('租约失效');
      expect(await db.onlineRechargeTask.findUnique({ where: { id: f.row.id } })).toEqual(before);
      expect(
        await db.onlineRechargeBill.count({ where: { taskId: f.row.id, status: 'success' } })
      ).toBe(0);
      expect(await db.onlineRechargeOrderSync.count({ where: { taskId: f.row.id } })).toBe(0);
    }, 30000);
  });

  it('旧待核对任务缺原单身份时只记录明确原因，保留付款及原卡保护', async () => {
    await start();
    const claim = (await workers.claim('fixture-legacy'))!;
    const card = await prepareCard(claim);
    const original = await db.onlineRechargeTask.findUniqueOrThrow({ where: { id: claim.id } });
    const legacyPayload = { ...(original.payload as Prisma.InputJsonObject) };
    delete legacyPayload.checkoutRecoveryVersion;
    await db.onlineRechargeTask.update({
      where: { id: claim.id },
      data: {
        status: 'awaiting_review',
        paymentStarted: true,
        payload: legacyPayload,
        leaseOwner: null,
        leaseId: null,
        leaseExpiresAt: null
      }
    });
    expect(await taskRepository.processDueRechecks(new Date(Date.now() + 600000))).toEqual({
      enqueued: 0
    });
    expect(await db.onlineRechargeTask.findUnique({ where: { id: claim.id } })).toMatchObject({
      status: 'awaiting_review',
      paymentStarted: true,
      payload: { reconciliation: { stopped: true, reasonCode: 'legacy_original_identity_missing' } }
    });
    expect(await db.onlineRechargeTask.count({ where: { operation: 'subscription' } })).toBe(0);
    expect(await db.onlineRechargeCard.findUnique({ where: { id: card.id } })).toMatchObject({
      leaseOwner: claim.id,
      successCount: 0
    });
  });

  it('自动多实例与手工核对竞争时同原单只排一个只读任务，恢复资料加密保存', async () => {
    await start();
    const claim = (await workers.claim('fixture-original'))!;
    const card = await prepareCard(claim);
    const payment = await submitPayment(claim);
    await workers.finish(lease(claim, { status: 'awaiting_review' }), true);
    const original = await db.onlineRechargeTask.findUniqueOrThrow({ where: { id: claim.id } });
    const payload = original.payload as Record<string, unknown>;
    expect(typeof payload.checkoutRecoveryEncrypted).toBe('string');
    expect(JSON.stringify(payload)).not.toContain(payment.checkoutRecovery.checkoutUrl);
    expect(JSON.stringify(payload)).not.toContain(payment.checkoutRecovery.checkoutId);
    expect(JSON.parse(encryption.decrypt(String(payload.checkoutRecoveryEncrypted))!)).toEqual(
      payment.checkoutRecovery
    );
    expect(original.paymentStarted).toBe(true);
    const schedule = payload.reconciliation as { startedAt: string };
    const due = new Date(Date.parse(schedule.startedAt) + 60001);
    const otherInstance = new OnlineRechargeTasksRepository(
      repository,
      settings,
      encryption,
      memory,
      orderSync
    );
    await Promise.all([
      taskRepository.processDueRechecks(due),
      otherInstance.processDueRechecks(due),
      tasks.action('jobs', 'recheck', { id: original.id }, operator)
    ]);
    const queued = await db.onlineRechargeTask.findMany({
      where: {
        operation: 'subscription',
        status: 'queued',
        payload: { path: '$.recheckTaskId', equals: original.id }
      }
    });
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      paymentStarted: false,
      cardId: null,
      payload: { action: 'recheck', sourceVersion: original.leaseVersion }
    });
    expect(queued[0]?.payload).not.toHaveProperty('checkoutRecoveryEncrypted');
    expect(await db.onlineRechargeTask.count({ where: { operation: 'recharge' } })).toBe(1);
    const recheck = (await workers.claim('fixture-read-only'))!;
    expect(await workers.getCheckoutRecovery(lease(recheck))).toEqual(payment.checkoutRecovery);
    await expect(workers.beforeSubmit(lease(recheck))).rejects.toThrow('付款前必须预约');
    expect(await db.onlineRechargeCard.findUnique({ where: { id: card.id } })).toMatchObject({
      leaseOwner: original.id,
      successCount: 0
    });
    expect(await db.onlineRechargeBill.count()).toBe(0);
    expect(await db.onlineRechargeOrderSync.count()).toBe(0);
  }, 30000);

  it('真实事务保留已付未生效原卡，并发及迟到核对只入一次账单、卡次数和订单同步', async () => {
    await settings.update({ maxConcurrent: 2 }, operator);
    const original = await start();
    const first = (await workers.claim('fixture-payment'))!;
    const card = await prepareCard(first);
    const payment = await submitPayment(first);
    await workers.finish(lease(first, { status: 'awaiting_review' }), true);
    await tasks.action('jobs', 'recheck', { id: original.id }, operator);
    const pending = (await workers.claim('fixture-paid-not-active'))!;
    await workers.finish(
      lease(pending, {
        status: 'succeeded',
        result: {
          confirmedPaid: true,
          paymentEvidence: payment.evidence,
          queryError: { code: 'timeout' },
          confirmation: {
            verified: false,
            source: 'subscription',
            querySucceeded: false,
            hasActiveSubscription: false,
            accountId: payment.context.accountId,
            expectedAccountId: payment.context.accountId,
            targetPlan: 'plus'
          }
        }
      }),
      false
    );
    expect(await db.onlineRechargeTask.findUnique({ where: { id: original.id } })).toMatchObject({
      status: 'awaiting_review',
      stage: 'paid_pending_activation',
      confirmedPaid: true,
      result: { paymentEvidence: payment.evidence }
    });
    expect(await db.onlineRechargeCard.findUnique({ where: { id: card.id } })).toMatchObject({
      successCount: 0,
      leaseOwner: original.id
    });
    expect(await db.onlineRechargeBill.count()).toBe(0);
    expect(await db.onlineRechargeOrderSync.count()).toBe(0);
    const scheduled = (await tasks.action('jobs', 'recheck', { id: original.id }, operator)) as {
      id: string;
    };
    const source = await db.onlineRechargeTask.findUniqueOrThrow({ where: { id: scheduled.id } });
    expect(source.payload).toMatchObject({ originalPaymentEvidence: payment.evidence });
    // Simulate an already accepted duplicate from an older process; new scheduling itself deduplicates it.
    await db.onlineRechargeTask.create({
      data: {
        operation: 'subscription',
        provider: 'local',
        message: '旧进程已经受理的重复只读核对夹具',
        plan: source.plan,
        sessionEncrypted: source.sessionEncrypted,
        sessionIdentityHash: source.sessionIdentityHash,
        payload: source.payload as Prisma.InputJsonObject
      }
    });
    const second = (await workers.claim('fixture-recheck-a'))!;
    const late = (await workers.claim('fixture-recheck-b'))!;
    const result = {
      confirmedPaid: true,
      paymentEvidence: payment.evidence,
      confirmation: {
        verified: true,
        source: 'subscription',
        querySucceeded: true,
        hasActiveSubscription: true,
        accountId: payment.context.accountId,
        expectedAccountId: payment.context.accountId,
        targetPlan: 'plus',
        observedPlan: 'plus',
        observedCanonicalPlan: 'plus',
        tierVerified: true
      }
    };
    await Promise.all([
      workers.finish(lease(second, { status: 'succeeded', result }), false),
      workers.finish(lease(late, { status: 'succeeded', result }), false)
    ]);
    expect(await db.onlineRechargeTask.findUnique({ where: { id: original.id } })).toMatchObject({
      status: 'succeeded',
      confirmedPaid: true
    });
    expect(
      await db.onlineRechargeBill.count({ where: { taskId: original.id, status: 'success' } })
    ).toBe(1);
    expect(
      (
        await db.onlineRechargeBill.findFirst({ where: { taskId: original.id, status: 'success' } })
      )?.amount?.toString()
    ).toBe('20.1');
    expect(await db.onlineRechargeCard.findUnique({ where: { id: card.id } })).toMatchObject({
      successCount: 1,
      leaseOwner: null
    });
    expect(
      await db.onlineRechargeEvent.count({
        where: { dedupeKey: `${original.id}:${card.id}:recordCardUsage` }
      })
    ).toBe(1);
    expect(await db.onlineRechargeOrderSync.count({ where: { taskId: original.id } })).toBe(1);
    await expect(
      workers.finish(lease(second, { status: 'succeeded', result }), false)
    ).rejects.toThrow('租约失效');
    expect(
      await db.onlineRechargeBill.count({ where: { taskId: original.id, status: 'success' } })
    ).toBe(1);
  }, 30000);

  it('待核对原任务只读复查同账户同套餐后消费兑换码，旧核对结果不可覆盖', async () => {
    const codes = (await assets.action(
      'cdks',
      'generate',
      { count: 1, plan: 'plus' },
      operator
    )) as { codes: string[] };
    const original = await start(randomUUID(), codes.codes[0]),
      first = (await workers.claim('fixture-a'))!;
    await prepareCard(first);
    const payment = await submitPayment(first);
    await workers.finish(lease(first, { status: 'awaiting_review' }), true);
    const recheck = (await tasks.action('jobs', 'recheck', { id: original.id }, operator)) as {
      id: string;
    };
    const second = (await workers.claim('fixture-b'))!;
    expect(second.id).toBe(recheck.id);
    expect(second.operation).toBe('subscription');
    const confirmation = {
      verified: true,
      source: 'subscription',
      querySucceeded: true,
      hasActiveSubscription: true,
      accountId: sessionAccountId(second.session),
      expectedAccountId: sessionAccountId(second.session),
      targetPlan: 'plus',
      observedPlan: 'chatgptplusplan'
    };
    await workers.finish(
      lease(second, {
        status: 'succeeded',
        result: { confirmedPaid: true, confirmation, paymentEvidence: payment.evidence }
      }),
      false
    );
    expect((await db.onlineRechargeTask.findUnique({ where: { id: original.id } }))?.status).toBe(
      'succeeded'
    );
    expect((await db.onlineRechargeCode.findFirst())?.status).toBe('used');
    expect((await db.onlineRechargeBill.findFirst())?.amount?.toString()).toBe('20.1');
    await expect(
      workers.finish(lease(first, { status: 'failed', definitiveFailure: true }), true)
    ).rejects.toThrow('租约失效');
  });
  it('仅文字成功、不同账户或不同套餐确认不会消费兑换资格', async () => {
    const codes = (await assets.action(
      'cdks',
      'generate',
      { count: 1, plan: 'plus' },
      operator
    )) as { codes: string[] };
    const original = await start(randomUUID(), codes.codes[0]),
      first = (await workers.claim('fixture-a'))!;
    await prepareCard(first);
    await submitPayment(first);
    expect(
      await workers.finish(
        lease(first, { status: 'succeeded', result: { confirmedPaid: true, message: 'success' } }),
        false
      )
    ).toMatchObject({ status: 'awaiting_review' });
    const recheck = (await tasks.action('jobs', 'recheck', { id: original.id }, operator)) as {
      id: string;
    };
    const second = (await workers.claim('fixture-b'))!;
    expect(second.id).toBe(recheck.id);
    await workers.finish(
      lease(second, {
        status: 'succeeded',
        result: {
          confirmedPaid: true,
          confirmation: {
            verified: true,
            source: 'subscription',
            querySucceeded: true,
            hasActiveSubscription: true,
            accountId: 'synthetic-other',
            expectedAccountId: 'synthetic-other',
            targetPlan: 'plus',
            observedPlan: 'chatgptplusplan'
          }
        }
      }),
      false
    );
    expect((await db.onlineRechargeTask.findUnique({ where: { id: original.id } }))?.status).toBe(
      'awaiting_review'
    );
    expect((await db.onlineRechargeCode.findFirst())?.status).toBe('reserved');
    await tasks.action('jobs', 'recheck', { id: original.id }, operator);
    const third = (await workers.claim('fixture-c'))!;
    await workers.finish(
      lease(third, {
        status: 'succeeded',
        result: {
          confirmedPaid: true,
          confirmation: {
            verified: true,
            source: 'subscription',
            querySucceeded: true,
            hasActiveSubscription: true,
            accountId: sessionAccountId(third.session),
            expectedAccountId: sessionAccountId(third.session),
            targetPlan: 'plus',
            observedPlan: 'chatgptprolite'
          }
        }
      }),
      false
    );
    expect((await db.onlineRechargeTask.findUnique({ where: { id: original.id } }))?.status).toBe(
      'awaiting_review'
    );
    expect((await db.onlineRechargeCode.findFirst())?.status).toBe('reserved');
  });
  it('原第三方单明确失败必须有同账户订阅核对，错误账户不能释放兑换资格', async () => {
    await settings.update({ gptApiEnabled: true }, operator);
    const codes = (await assets.action(
      'cdks',
      'generate',
      { count: 1, plan: 'plus' },
      operator
    )) as { codes: string[] };
    const original = await start(randomUUID(), codes.codes[0]),
      first = (await workers.claim('fixture-a'))!;
    const card = await prepareCard(first);
    await workers.beforeSubmit(lease(first));
    await workers.finish(lease(first, { status: 'awaiting_review' }), true);
    await tasks.action('jobs', 'recheck', { id: original.id }, operator);
    const wrong = (await workers.claim('fixture-b'))!;
    const failure = {
      verified: false,
      source: 'subscription',
      querySucceeded: true,
      hasActiveSubscription: false,
      accountId: 'synthetic-other',
      expectedAccountId: 'synthetic-other',
      targetPlan: 'plus',
      observedPlan: 'free'
    };
    await workers.finish(
      lease(wrong, {
        status: 'failed',
        definitiveFailure: true,
        result: { confirmedPaid: false, providerFinalStatus: 'failed', confirmation: failure }
      }),
      true
    );
    expect(await db.onlineRechargeTask.findUnique({ where: { id: original.id } })).toMatchObject({
      status: 'awaiting_review'
    });
    expect(await db.onlineRechargeCode.findFirst()).toMatchObject({ status: 'reserved' });
    expect(await db.onlineRechargeCard.findUnique({ where: { id: card.id } })).toMatchObject({
      leaseOwner: original.id
    });
    await tasks.action('jobs', 'recheck', { id: original.id }, operator);
    const correct = (await workers.claim('fixture-c'))!;
    const expected = sessionAccountId(correct.session);
    await workers.finish(
      lease(correct, {
        status: 'failed',
        definitiveFailure: true,
        result: {
          confirmedPaid: false,
          providerFinalStatus: 'failed',
          confirmation: { ...failure, accountId: expected, expectedAccountId: expected }
        }
      }),
      true
    );
    expect(await db.onlineRechargeTask.findUnique({ where: { id: original.id } })).toMatchObject({
      status: 'failed',
      confirmedPaid: false
    });
    expect(await db.onlineRechargeCode.findFirst()).toMatchObject({
      status: 'available',
      taskId: null
    });
    expect(await db.onlineRechargeCard.findUnique({ where: { id: card.id } })).toMatchObject({
      leaseOwner: null
    });
    expect(await db.onlineRechargeBill.count()).toBe(0);
  });
  it('公共任务凭据不能查询另一个任务且取密写审计', async () => {
    const task = await start();
    await expect(tasks.publicTask({ id: task.id, taskToken: 'wrong-token' })).rejects.toThrow(
      '凭证无效'
    );
    expect(await tasks.publicTask({ id: task.id, taskToken: task.taskToken })).not.toHaveProperty(
      'session'
    );
    await tasks.action('sessions', 'reveal', { id: task.id, reason: '隔离测试授权' }, operator);
    expect(
      await db.auditLog.count({
        where: { objectId: task.id, action: 'id_business_v2.online_recharge.sessions.reveal' }
      })
    ).toBe(1);
  });
  it('并发供应商回调只导入一次，拒绝伪签名、同编号不同正文', async () => {
    const secret = 'synthetic-supplier-webhook-fixture-key';
    await settings.update({ cardSupplierWebhookSecret: secret }, operator);
    const encrypt = (value: string) => {
      const iv = randomBytes(12),
        cipher = createCipheriv(
          'aes-256-gcm',
          createHmac('sha256', secret).update('vcc-webhook-sensitive-v1').digest(),
          iv
        );
      return Buffer.concat([
        iv,
        cipher.update(value),
        cipher.final(),
        cipher.getAuthTag()
      ]).toString('base64url');
    };
    const input = {
      eventId: randomUUID(),
      eventType: 'CARD_ISSUE.SUCCESS',
      data: {
        cards: [
          {
            cardNumberCiphertext: encrypt('4242424242424242'),
            expiryDateCiphertext: encrypt('12/30'),
            cvvCiphertext: encrypt('123')
          }
        ]
      }
    };
    const raw = Buffer.from(JSON.stringify(input)),
      timestamp = '1',
      nonce = 'synthetic-nonce';
    const signature = `v1=${createHmac('sha256', secret)
      .update(
        [
          input.eventId,
          input.eventType,
          timestamp,
          nonce,
          createHash('sha256').update(raw).digest('hex')
        ].join('\n')
      )
      .digest('hex')}`;
    const headers = {
      'x-vcc-webhook-id': input.eventId,
      'x-vcc-webhook-event': input.eventType,
      'x-vcc-webhook-timestamp': timestamp,
      'x-vcc-webhook-nonce': nonce,
      'x-vcc-webhook-signature': signature
    };
    const results = await Promise.all([
      webhooks.receive(headers, input, raw),
      webhooks.receive(headers, input, raw)
    ]);
    expect(results.filter((row) => row.duplicate)).toHaveLength(1);
    expect(await db.onlineRechargeCard.count()).toBe(1);
    expect(await db.onlineRechargeWebhookReceipt.count()).toBe(1);
    await expect(
      webhooks.receive(
        { ...headers, 'x-vcc-webhook-signature': 'v1=' + '0'.repeat(64) },
        input,
        raw
      )
    ).rejects.toThrow('签名验证失败');
    const changed = { ...input, syntheticChange: true },
      changedRaw = Buffer.from(JSON.stringify(changed));
    const changedSignature = `v1=${createHmac('sha256', secret)
      .update(
        [
          input.eventId,
          input.eventType,
          timestamp,
          nonce,
          createHash('sha256').update(changedRaw).digest('hex')
        ].join('\n')
      )
      .digest('hex')}`;
    await expect(
      webhooks.receive(
        { ...headers, 'x-vcc-webhook-signature': changedSignature },
        changed,
        changedRaw
      )
    ).rejects.toThrow('不同正文');
    expect((await db.onlineRechargeCard.findFirst())?.numberEncrypted).not.toContain(
      '4242424242424242'
    );
  });
  it('补货首回安全码通道失败后同正文重交付，卡片回执仍各一条', async () => {
    const secret = 'synthetic-webhook-redelivery-fixture-key';
    await settings.update({ cardSupplierWebhookSecret: secret }, operator);
    const auditCount = await db.auditLog.count({
      where: { action: 'id_business_v2.online_recharge.webhook.receive' }
    });
    const encrypt = (value: string) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv(
        'aes-256-gcm',
        createHmac('sha256', secret).update('vcc-webhook-sensitive-v1').digest(),
        iv
      );
      return Buffer.concat([
        iv,
        cipher.update(value),
        cipher.final(),
        cipher.getAuthTag()
      ]).toString('base64url');
    };
    const input = {
      eventId: randomUUID(),
      eventType: 'CARD_ISSUE.SUCCESS',
      data: {
        cards: [
          {
            cardNumberCiphertext: encrypt('4242424242424242'),
            expiryDateCiphertext: encrypt('12/2030'),
            cvvCiphertext: encrypt('123')
          }
        ]
      }
    };
    const raw = Buffer.from(JSON.stringify(input));
    const timestamp = String(Date.now());
    const nonce = randomUUID();
    const headers = {
      'x-vcc-webhook-id': input.eventId,
      'x-vcc-webhook-event': input.eventType,
      'x-vcc-webhook-timestamp': timestamp,
      'x-vcc-webhook-nonce': nonce,
      'x-vcc-webhook-signature': `v1=${createHmac('sha256', secret)
        .update(
          [
            input.eventId,
            input.eventType,
            timestamp,
            nonce,
            createHash('sha256').update(raw).digest('hex')
          ].join('\n')
        )
        .digest('hex')}`
    };
    putCards.mockRejectedValueOnce(new Error('Synthetic credentials channel unavailable'));
    await expect(webhooks.receive(headers, input, raw)).resolves.toMatchObject({
      duplicate: false,
      imported: 1,
      credentialsAvailable: false
    });
    await expect(webhooks.receive(headers, input, raw)).resolves.toMatchObject({
      duplicate: true,
      imported: 1,
      credentialsAvailable: true
    });
    expect(putCards).toHaveBeenCalledTimes(2);
    expect(putCards.mock.calls[1]![0]).toEqual(putCards.mock.calls[0]![0]);
    expect(await db.onlineRechargeCard.count()).toBe(1);
    expect(await db.onlineRechargeWebhookReceipt.count()).toBe(1);
    expect(
      await db.auditLog.count({
        where: { action: 'id_business_v2.online_recharge.webhook.receive' }
      })
    ).toBe(auditCount + 1);
  });
  it('真实Nest模块能启动关闭，HTTP资源和WebSocket任务授权可达', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              FIELD_ENCRYPTION_KEY: 'synthetic-field-encryption-fixture',
              HASH_SECRET: 'synthetic-blind-index-fixture'
            })
          ]
        }),
        PrismaModule,
        OnlineRechargeModule
      ],
      providers: [{ provide: APP_GUARD, useClass: PermissionsGuard }]
    }).compile();
    const app = module.createNestApplication({ logger: false, rawBody: true });
    app.use((req: Request & { user?: AuthenticatedUser }, _res: Response, next: NextFunction) => {
      const role = req.headers['x-synthetic-fixture-role'];
      if (typeof role === 'string')
        req.user = {
          ...operator,
          roles: [role === 'admin' ? 'admin' : 'employee'],
          permissions: ['read', 'manage', 'sensitive'].includes(role)
            ? [
                'id_business_v2.online_recharge.read',
                ...(role === 'manage' ? ['id_business_v2.online_recharge.manage'] : []),
                ...(role === 'sensitive' ? ['id_business_v2.online_recharge.sensitive'] : [])
              ]
            : []
        };
      next();
    });
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    try {
      const address = app.getHttpServer().address() as AddressInfo;
      const base = `http://127.0.0.1:${address.port}/api/id-business-v2/online-recharge`;
      const as = (role: string) => ({ 'x-synthetic-fixture-role': role });
      for (const path of ['/admin/config', '/admin/overview', '/admin/cards', '/public/config']) {
        expect((await fetch(base + path)).status).toBe(403);
        expect((await fetch(base + path, { headers: as('employee') })).status).toBe(403);
        expect((await fetch(base + path, { headers: as('read') })).ok).toBe(true);
      }
      const generated = (await assets.action(
        'cdks',
        'generate',
        { count: 1, plan: 'plus' },
        operator
      )) as { codes: string[] };
      for (const operation of ['redeem', 'subscription']) {
        const body = {
          session: fullSession(),
          plan: 'plus',
          ...(operation === 'redeem' ? { code: generated.codes[0] } : {})
        };
        const submit = (role?: string) =>
          fetch(base + '/public/' + operation, {
            method: 'POST',
            headers: { ...(role ? as(role) : {}), 'content-type': 'application/json' },
            body: JSON.stringify(body)
          });
        for (const role of [undefined, 'employee', 'read']) {
          expect((await submit(role)).status).toBe(403);
          expect(await db.onlineRechargeTask.count()).toBe(operation === 'redeem' ? 0 : 1);
        }
        const response = await submit('manage');
        expect(response.ok).toBe(true);
        const result = (await response.json()) as { id: string };
        expect(await db.onlineRechargeTask.findUnique({ where: { id: result.id } })).toMatchObject({
          operatorId: operator.id,
          operation: operation === 'redeem' ? 'recharge' : 'subscription'
        });
      }
      expect((await fetch(base + '/admin/login-logs', { headers: as('read') })).status).toBe(403);
      expect(
        (await fetch(base + `/admin/artifacts/${randomUUID()}`, { headers: as('read') })).status
      ).toBe(403);
      const patch = (role: string) =>
        fetch(base + '/admin/config', {
          method: 'PATCH',
          headers: { ...as(role), 'content-type': 'application/json' },
          body: JSON.stringify({ maxConcurrent: 1 })
        });
      expect((await patch('read')).status).toBe(403);
      expect((await patch('manage')).ok).toBe(true);
      const code = await new Promise<number>((resolve, reject) => {
        const socket = new WebSocket(
          `ws://127.0.0.1:${address.port}/api/id-business-v2/online-recharge/ws`
        );
        socket.once('open', () =>
          socket.send(JSON.stringify({ type: 'subscribe', ticket: 'invalid-synthetic-ticket' }))
        );
        socket.once('close', resolve);
        socket.once('error', reject);
      });
      expect(code).toBe(1008);
    } finally {
      await app.close();
    }
  }, 20000);
  it('安全通知默认不排队，启用后按登录事件幂等且不保存身份秘密', async () => {
    const loginAttemptId = randomUUID();
    await notifications.enqueue({ event: 'admin_login_success', loginAttemptId });
    expect(await db.onlineRechargeTask.count()).toBe(0);
    await settings.update(
      {
        telegramEnabled: true,
        telegramAdminEnabled: true,
        telegramBotToken: 'synthetic-non-operational-bot-token',
        telegramAdminChatId: 'synthetic-chat-target'
      },
      operator
    );
    await Promise.all([
      notifications.enqueue({
        event: 'admin_login_success',
        loginAttemptId,
        userId: operator.id,
        maskedIp: '127.0.*.*'
      }),
      notifications.enqueue({
        event: 'admin_login_success',
        loginAttemptId,
        userId: operator.id,
        maskedIp: '127.0.*.*'
      })
    ]);
    expect(await db.onlineRechargeTask.count({ where: { operation: 'notification' } })).toBe(1);
    const row = (await db.onlineRechargeTask.findFirst())!;
    expect(row.sessionEncrypted).toBeNull();
    expect(row.payload).toEqual({ event: 'admin_login_success', maskedIp: '127.0.*.*' });
    await expect(
      notifications.enqueue({
        event: 'admin_login_failed',
        loginAttemptId: randomUUID(),
        maskedIp: '127.0.0.1'
      })
    ).rejects.toThrow('脱敏');
  });
  it('只从指定国家的启用代理中选择，并保存任务国家快照', async () => {
    await settings.update({ proxyCountryCode: 'CL' }, operator);
    const chile = await pool.create(
      {
        countryCode: 'CL',
        kind: 'mobile',
        connectionMode: 'direct',
        protocol: 'socks5',
        url: 'socks5://country-cl.example.invalid:1080'
      },
      operator
    );
    await pool.create(
      {
        countryCode: 'US',
        kind: 'static_residential',
        connectionMode: 'direct',
        protocol: 'http',
        url: 'http://country-us.example.invalid:8080'
      },
      operator
    );
    await repository.transaction('country-filter-fixture', async (tx) => {
      for (let i = 0; i < 10; i++)
        expect(await proxiesPool.active(tx, undefined, false, undefined, 'CL')).toMatchObject({
          id: chile.id,
          countryCode: 'CL'
        });
      const philippines = await tx.idBusinessV2RechargeProxy.findFirst({
        where: { countryCode: 'PH' }
      });
      await expect(proxiesPool.active(tx, philippines!.id, true, undefined, 'CL')).rejects.toThrow(
        '不属于任务指定国家'
      );
    });
    const task = await start();
    await settings.update({ proxyCountryCode: 'PH' }, operator);
    expect(
      (await db.onlineRechargeTask.findUnique({ where: { id: task.id } }))?.payload
    ).toMatchObject({ proxyCountryCode: 'CL' });
  });
  it('未设置国家或该国没有启用代理时不创建业务任务', async () => {
    await settings.update({ proxyCountryCode: 'CL' }, operator);
    await expect(start()).rejects.toThrow('暂无启用代理');
    await settings.update({ proxyCountryCode: '' }, operator);
    await expect(start()).rejects.toThrow('代理国家');
    expect(await db.onlineRechargeTask.count()).toBe(0);
  });
  it('uses one pool for legacy online imports, country completion and canonical detection', async () => {
    const url = 'socks5://fixture:fixture@gateway.example.test:1080';
    await proxiesPool.action('import', { proxies: [url] }, operator);
    const result = await pool.list({ keyword: 'gateway.example.test' });
    expect(result.total).toBe(1);
    const proxy = result.items[0]!;
    expect(proxy.countryCode).toBe('');
    expect(proxy.kind).toBeNull();
    expect((await pool.countries()).items).toEqual(['PH']);
    await pool.update(
      proxy.id,
      { countryCode: 'CL', kind: 'mobile', remark: '共用代理' },
      operator
    );
    expect((await pool.countries()).items).toEqual(['CL', 'PH']);
    expect((await pool.forCharge(proxy.id, operator, 'CL')).mode).toBe('static');
    const oldId = '55555555-5555-4555-8555-555555555555';
    await db.idBusinessV2ProxyAlias.create({ data: { oldId, proxyId: proxy.id } });
    await repository.transaction('shared-proxy-test', async (tx) => {
      const active = await proxiesPool.active(tx, oldId);
      expect(active.id).toBe(proxy.id);
      expect(
        await proxiesPool.result(
          tx,
          oldId,
          { ip: '8.8.8.8', latencyMs: 25, ok: true },
          false,
          active.connectionVersion
        )
      ).toEqual({ applied: true });
    });
    expect((await pool.list({ keyword: 'gateway.example.test' })).items[0]).toMatchObject({
      exitIp: '8.8.8.8',
      latencyMs: 25
    });
    await pool.update(proxy.id, { status: 'disabled' }, operator);
    await repository.transaction('shared-proxy-disabled', async (tx) => {
      await expect(proxiesPool.active(tx, oldId)).rejects.toThrow('已停用');
    });
  });
  it('keeps extraction links through legacy import and protects pending batch proxy references', async () => {
    await assets.action(
      'proxies',
      'import',
      {
        proxies: [
          'https://api.ipdeep.com/api/Pro/DynamicIp/GetIpByGenerateLink?id=synthetic-shared-only'
        ]
      },
      operator
    );
    const proxy = (await pool.list({ keyword: 'api.ipdeep.com' })).items[0]!;
    expect(proxy).toMatchObject({ connectionMode: 'extraction', protocol: 'http' });
    const oldId = randomUUID();
    await db.idBusinessV2ProxyAlias.create({ data: { oldId, proxyId: proxy.id } });
    const task = await db.onlineRechargeTask.create({
      data: {
        operation: 'proxy_test',
        message: 'synthetic pending batch',
        payload: { ids: [oldId] }
      }
    });
    await expect(pool.delete(proxy.id, operator)).rejects.toThrow('正在检测');
    await expect(
      pool.update(proxy.id, { url: 'https://provider.example.test/another' }, operator)
    ).rejects.toThrow('正在检测');
    await db.onlineRechargeTask.update({
      where: { id: task.id },
      data: { status: 'failed', message: 'synthetic ended batch' }
    });
    await pool.delete(proxy.id, operator);
    expect((await pool.list({ keyword: 'api.ipdeep.com' })).total).toBe(0);
  });
});
