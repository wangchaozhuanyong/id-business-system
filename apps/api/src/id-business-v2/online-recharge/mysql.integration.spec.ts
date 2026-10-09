import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
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
import type { OnlineRechargeWorkerRpc } from './contracts';
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

const enabled = process.env.ONLINE_RECHARGE_MYSQL_TEST === '1';
const suite = enabled ? describe : describe.skip;

suite('线上代充隔离MySQL事务验收', () => {
  const db = new PrismaService();
  const config = new ConfigService({
    FIELD_ENCRYPTION_KEY: 'synthetic-field-encryption-fixture',
    HASH_SECRET: 'synthetic-blind-index-fixture'
  });
  const encryption = new FieldEncryptionService(config);
  const repository = new OnlineRechargeRepository(
    db,
    new V2TransactionalAuditService(),
    new V2CommandTransactionManager(db)
  );
  const settings = new OnlineRechargeSettingsService(
    new OnlineRechargeSettingsRepository(repository, encryption)
  );
  const memory = new OnlineRechargeEphemeralCredentials(config);
  const assets = new OnlineRechargeAssetsService(
    new OnlineRechargeAssetsRepository(repository, encryption, memory)
  );
  const tasks = new OnlineRechargeTasksService(
    new OnlineRechargeTasksRepository(repository, settings, encryption, memory)
  );
  const workers = new OnlineRechargeWorkerRepository(repository, settings, encryption, memory);
  const webhooks = new OnlineRechargeWebhooksService(
    new OnlineRechargeWebhooksRepository(repository, settings, encryption, assets, memory)
  );
  const notifications = new OnlineRechargeSecurityNotificationService(
    new OnlineRechargeSecurityNotificationRepository(repository, settings)
  );
  let operator: AuthenticatedUser;
  const credentials = vi.spyOn(memory, 'available').mockImplementation(async (ids) => ids);
  vi.spyOn(memory, 'putCvc').mockResolvedValue(undefined);
  vi.spyOn(memory, 'putCards').mockResolvedValue(undefined);
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
      db.onlineRechargeBill,
      db.onlineRechargeEvent,
      db.onlineRechargeWebhookReceipt,
      db.onlineRechargeTask,
      db.onlineRechargeCode,
      db.onlineRechargeCard,
      db.onlineRechargeProxy,
      db.onlineRechargeAddress,
      db.onlineRechargeConfig
    ]) {
      await (model.deleteMany as () => Promise<unknown>)();
    }
    credentials.mockImplementation(async (ids) => ids);
  });
  afterAll(async () => {
    await db.$disconnect();
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
    await workers.beforeSubmit(lease(claim));
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
    await workers.beforeSubmit(lease(claim));
    await workers.cardAction(lease(claim, { cardId: card.id }), 'recordCardUsage');
    await workers.cardAction(lease(claim, { cardId: card.id }), 'recordCardUsage');
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
    await workers.beforeSubmit(lease(claim, cardArgs));
    await Promise.all([
      workers.cardAction(lease(claim, cardArgs), 'recordCardUsage'),
      workers.cardAction(lease(claim, cardArgs), 'recordCardUsage')
    ]);
    const bill = {
      amount: '20.1000',
      amountSource: 'checkout',
      checkoutId: 'synthetic-confirmed-checkout',
      currency: 'USD',
      status: 'success'
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
        lease(claim, { status: 'succeeded', result: { confirmedPaid: true, confirmation } }),
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
  it('提交后未知结果和已确认付款均不能提前释放卡，明确拒付仍允许原任务换卡', async () => {
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
    await workers.beforeSubmit(lease(claim));
    await expect(
      workers.cardAction(lease(claim, { cardId: first.id, confirmed: true }), 'releaseCard')
    ).rejects.toThrow('不能释放');
    await workers.cardAction(lease(claim, { cardId: first.id }), 'recordCardDecline');
    await workers.cardAction(lease(claim, { cardId: first.id }), 'releaseCard');
    const next = (await workers.reserveCard(lease(claim, { excludedIds: [first.id] }))) as {
      id: string;
    };
    expect(next.id).not.toBe(first.id);
    await workers.beforeSubmit(lease(claim));
    await expect(
      workers.cardAction(lease(claim, { cardId: next.id }), 'releaseCard')
    ).rejects.toThrow('不能释放');
    await workers.cardAction(lease(claim, { cardId: next.id }), 'recordCardUsage');
    await expect(
      workers.cardAction(lease(claim, { cardId: next.id, confirmed: true }), 'releaseCard')
    ).rejects.toThrow('不能释放');
    await workers.finish(lease(claim, { status: 'awaiting_review', confirmedPaid: true }), true);
    expect(await db.onlineRechargeCard.findUnique({ where: { id: next.id } })).toMatchObject({
      leaseOwner: claim.id
    });
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
    await workers.beforeSubmit(lease(first));
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
      lease(second, { status: 'succeeded', result: { confirmedPaid: true, confirmation } }),
      false
    );
    expect((await db.onlineRechargeTask.findUnique({ where: { id: original.id } }))?.status).toBe(
      'succeeded'
    );
    expect((await db.onlineRechargeCode.findFirst())?.status).toBe('used');
    expect((await db.onlineRechargeBill.findFirst())?.amount).toBeNull();
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
    await workers.beforeSubmit(lease(first));
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
      for (const path of ['/admin/config', '/admin/overview', '/admin/cards']) {
        expect((await fetch(base + path)).status).toBe(403);
        expect((await fetch(base + path, { headers: as('employee') })).status).toBe(403);
        expect((await fetch(base + path, { headers: as('read') })).ok).toBe(true);
      }
      expect((await fetch(base + '/public/config')).ok).toBe(true);
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
});
