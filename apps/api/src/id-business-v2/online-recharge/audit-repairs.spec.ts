import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import type { OnlineRechargeTask } from '@prisma/client';
import { IS_PUBLIC_KEY } from '../../auth/auth.decorators';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { OnlineRechargePublicController, OnlineRechargePublicLimiter } from './public.controller';
import { OnlineRechargeTasksService } from './tasks.service';
import { OnlineRechargeTasksRepository } from './persistence/tasks.repository';
import { OnlineRechargeAdminRepository } from './persistence/admin.repository';
import { OnlineRechargeRepository } from './persistence/online-recharge.repository';
import { OnlineRechargeSettingsService } from './settings.service';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { parseOnlineRechargeProxy } from './proxy-input';

const operator: AuthenticatedUser = {
  id: 'synthetic-operator',
  username: 'fixture',
  displayName: '测试',
  roles: ['employee'],
  permissions: ['id_business_v2.online_recharge.read']
};
describe('线上代充审计修复的后台边界和返回契约', () => {
  it('原客户命名接口需要后台身份，提交还需要管理权限并记录实际操作人', async () => {
    const guard = new PermissionsGuard(new Reflector());
    const context = (method: 'config' | 'redeem' | 'subscription', user?: AuthenticatedUser) =>
      ({
        getHandler: () => OnlineRechargePublicController.prototype[method],
        getClass: () => OnlineRechargePublicController,
        switchToHttp: () => ({ getRequest: () => ({ user }) })
      }) as unknown as ExecutionContext;
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, OnlineRechargePublicController)).not.toBe(true);
    expect(() => guard.canActivate(context('config'))).toThrow();
    expect(guard.canActivate(context('config', operator))).toBe(true);
    expect(() => guard.canActivate(context('redeem', operator))).toThrow();
    expect(() => guard.canActivate(context('subscription', operator))).toThrow();
    const manager = {
      ...operator,
      permissions: [...operator.permissions, 'id_business_v2.online_recharge.manage']
    };
    expect(guard.canActivate(context('redeem', manager))).toBe(true);
    const start = vi.fn().mockResolvedValue({ id: 'synthetic-task' });
    const controller = new OnlineRechargePublicController(
      { start } as unknown as OnlineRechargeTasksService,
      new OnlineRechargePublicLimiter()
    );
    const body = { code: 'synthetic', session: '{}' };
    await controller.redeem(body, { ip: '192.0.2.1' }, manager);
    expect(start).toHaveBeenCalledWith(body, manager, 'recharge', true);
    await controller.subscription(body, { ip: '192.0.2.1' }, manager);
    expect(start).toHaveBeenLastCalledWith(body, manager, 'subscription', true);
  });
  it('成功任务与实际确认充值分别统计，浏览器显示检测时刻和真实字段', async () => {
    const taskGroup = vi.fn(async (query) =>
      query.where?.operation === 'recharge' ? [] : [{ status: 'succeeded', _count: 6 }]
    );
    const taskCount = vi.fn(async () => 0);
    const observedAt = new Date('2026-10-15T01:00:00Z');
    const db = {
      onlineRechargeTask: {
        groupBy: taskGroup,
        count: taskCount,
        findFirst: vi.fn(async () => ({
          result: { mode: 'pool', slots: [{ slotId: 2, inUse: true, jobKey: 'synthetic-task' }] },
          updatedAt: observedAt
        }))
      },
      onlineRechargeCode: { groupBy: vi.fn(async () => []) },
      onlineRechargeCard: { groupBy: vi.fn(async () => []) },
      onlineRechargeBill: { groupBy: vi.fn(async () => []) }
    };
    const repo = new OnlineRechargeAdminRepository(
      {
        read: (fn: (client: typeof db) => unknown) => fn(db)
      } as unknown as OnlineRechargeRepository,
      {} as never,
      { get: async () => ({ browserMode: 'pool' }) } as unknown as OnlineRechargeSettingsService,
      {} as never,
      {} as never,
      {} as never
    );
    const overview = await repo.overview();
    expect(overview.tasks).toEqual([{ status: 'succeeded', _count: 6 }]);
    expect(overview.rechargeTasks).toEqual([]);
    expect(overview.confirmedRechargeCount).toBe(0);
    expect(taskCount).toHaveBeenCalledWith({
      where: { operation: 'recharge', confirmedPaid: true }
    });
    const list = await repo.list('browser-pool', {}, operator);
    expect(list.items[0]).toMatchObject({
      id: '2',
      mode: 'pool',
      taskId: 'synthetic-task',
      status: 'busy',
      updatedAt: observedAt
    });
  });
  it('订阅投影只使用成功查询结果，预览不泄露会话和凭据', () => {
    const repo = new OnlineRechargeTasksRepository(
      {} as never,
      {} as never,
      { decrypt: () => 'fixture@example.invalid' } as unknown as FieldEncryptionService,
      {} as never
    );
    const row = {
      id: 'fixture',
      operation: 'subscription',
      status: 'succeeded',
      message: '',
      sessionEncrypted: 'synthetic-encrypted',
      result: {
        ok: true,
        data: {
          hasActiveSubscription: true,
          autoRenewRaw: false,
          expiresAt: '2027-01-01T00:00:00Z'
        }
      }
    } as unknown as OnlineRechargeTask;
    expect(repo.map(row)).toMatchObject({
      subscriptionStatus: 'active',
      autoRenew: false,
      expiresAt: '2027-01-01T00:00:00Z',
      sessionMasked: '已提供（加密保存）'
    });
    expect(
      repo.map({
        ...row,
        result: { ok: false, data: { hasActiveSubscription: true, autoRenewRaw: true } }
      })
    ).toMatchObject({ subscriptionStatus: null, autoRenew: null });
    expect(repo.map(row, true)).not.toHaveProperty('sessionMasked');
    expect(JSON.stringify(repo.map(row))).not.toContain('synthetic-encrypted');
    expect(
      repo.map({
        ...row,
        operation: 'renewal',
        result: {
          success: true,
          renewalVerified: true,
          data: { hasActiveSubscription: true, autoRenewRaw: true }
        }
      })
    ).toMatchObject({ subscriptionStatus: 'active', autoRenew: true });
  });
  it('接受四段网关和指定供应商提取链接，拒绝任意HTTP路径', () => {
    expect(
      parseOnlineRechargeProxy('gateway.example.invalid:8082:synthetic:pass@word')
    ).toMatchObject({
      raw: 'http://synthetic:pass%40word@gateway.example.invalid:8082',
      protocol: 'http'
    });
    expect(
      parseOnlineRechargeProxy(
        'https://api.ipdeep.com/api/Pro/DynamicIp/GetIpByGenerateLink?id=synthetic-only'
      )
    ).toMatchObject({ protocol: 'extraction', displayHost: 'api.ipdeep.com（每任务提取）' });
    for (const value of [
      'http://127.0.0.1/internal?id=synthetic',
      'https://api.ipdeep.com.evil.invalid/api/Pro/DynamicIp/GetIpByGenerateLink?id=synthetic',
      'https://api.ipdeep.com/api/Pro/DynamicIp/GetIpByGenerateLink',
      'gateway:70000:user:pass'
    ])
      expect(() => parseOnlineRechargeProxy(value)).toThrow();
  });
  it('原账号尚有待核对变更时，不创建新的续费提交任务', async () => {
    const count = vi.fn(async () => 1);
    const create = vi.fn();
    const tx = {
      onlineRechargeConfig: { findUnique: async () => null },
      onlineRechargeTask: { count, create }
    };
    const repository = {
      transaction: async (_key: string, fn: (client: typeof tx) => unknown) => fn(tx)
    };
    const tasks = new OnlineRechargeTasksRepository(
      repository as unknown as OnlineRechargeRepository,
      {} as never,
      { hash: () => 'synthetic-identity-hash' } as unknown as FieldEncryptionService,
      {} as never
    );
    const token = `fixture.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' } })).toString('base64url')}.unused`;
    await expect(
      tasks.start(
        { session: JSON.stringify({ accessToken: token }), action: 'enable' },
        operator,
        'renewal'
      )
    ).rejects.toThrow('请先核对原任务');
    expect(create).not.toHaveBeenCalled();
    expect(count).toHaveBeenCalledWith({
      where: {
        sessionIdentityHash: 'synthetic-identity-hash',
        operation: { in: ['recharge', 'renewal'] },
        status: { in: ['queued', 'running', 'awaiting_credentials', 'awaiting_review'] }
      }
    });
  });
});
