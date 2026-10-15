import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { OnlineRechargeTask } from '@prisma/client';
import { ONLINE_RECHARGE_DEFAULTS } from './contracts';
import { confirmedSubscription, requireTaskLease } from './persistence/worker.repository';
import { plan, redact, sanitize, session, sessionAccountId } from './validation';
import { secureEqual } from './worker.service';
import { assertOnlineSensitive } from './assets.service';
import { createOnlineRechargeCodes } from './cdk-generator';
import { parseOnlineRechargeProxy } from './proxy-input';
import { OnlineRechargeArtifactsService } from './artifacts.service';
import type { OnlineRechargeArtifactsRepository } from './persistence/artifacts.repository';

describe('线上代充安全边界和原版默认行为', () => {
  it('兑换码保留原KC前缀、15位后缀、字符集、数量夹取和批次去重', () => {
    for (const [count, length] of [
      [undefined, 1],
      [0, 1],
      [-2, 1],
      [1, 1],
      [9, 9],
      [101, 100]
    ] as const) {
      const codes = createOnlineRechargeCodes(count);
      expect(codes).toHaveLength(length);
      expect(new Set(codes).size).toBe(length);
      for (const code of codes) expect(code).toMatch(/^KC-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{15}$/);
    }
  });
  it('代理保留原sticky session占位符以及HTTP标准默认端口', () => {
    expect(
      parseOnlineRechargeProxy(' http://user-{session}:synthetic@proxy.example.invalid:80 ').raw
    ).toBe('http://user-{session}:synthetic@proxy.example.invalid:80');
    expect(parseOnlineRechargeProxy('https://proxy.example.invalid')).toMatchObject({
      protocol: 'https',
      displayHost: 'proxy.example.invalid'
    });
    expect(parseOnlineRechargeProxy('socks5://proxy.example.invalid:1080')).toMatchObject({
      protocol: 'socks5',
      displayHost: 'proxy.example.invalid:1080'
    });
    expect(() => parseOnlineRechargeProxy('file:///synthetic')).toThrow('协议');
  });
  it('保持原套餐、并发、阈值、浏览器和验证码默认', () => {
    expect(ONLINE_RECHARGE_DEFAULTS).toMatchObject({
      maxConcurrent: 1,
      cardMaxSubscriptionCount: 2,
      cardMaxDeclineCount: 3,
      paymentMaxCardAttempts: 3,
      browserMode: 'pool',
      hcaptchaEnabled: true,
      hcaptchaSolverTimeoutMs: 240000,
      vlmTimeoutMs: 45000,
      planNamePlus: 'chatgptplusplan',
      planNamePro5x: 'chatgptprolite',
      planNamePro20x: 'chatgptpro',
      telegramNotifySuccess: false
    });
  });
  it('公共提交必须包含完整会话，拒绝单独令牌和已过期JWT', () => {
    expect(() => session('eyJsynthetic.only.token', true)).toThrow();
    const expired = `eyJtest.${Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url')}.signature`;
    expect(() =>
      session(
        JSON.stringify({
          accessToken: expired,
          user: { id: randomUUID(), email: 'fixture@example.invalid' }
        }),
        true
      )
    ).toThrow('过期');
  });
  it('成功证据绑定实际Session账户并独立确认原套餐档位，不能只信执行器布尔值', () => {
    const token = `eyJsynthetic.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' } })).toString('base64url')}.synthetic-unused-signature`;
    const source = JSON.stringify({
      accessToken: token,
      user: { id: 'different-user-id', email: 'fixture@example.invalid' },
      account: { id: 'different-account-id' }
    });
    const expected = sessionAccountId(source);
    expect(expected).toBe('synthetic-account');
    expect(session(source, true).identity).toBe('synthetic-account');
    expect(sessionAccountId(JSON.stringify({ accessToken: '', access_token: token }))).toBe(
      expected
    );
    expect(
      sessionAccountId(JSON.stringify({ accessToken: token.split('.').slice(0, 2).join('.') }))
    ).toBe('');
    expect(sessionAccountId(null)).toBe('');
    expect(sessionAccountId('{}')).toBe('');
    expect(sessionAccountId('invalid')).toBe('');
    const proof = {
      verified: true,
      source: 'subscription',
      querySucceeded: true,
      hasActiveSubscription: true,
      accountId: expected,
      expectedAccountId: expected,
      targetPlan: 'pro_5x',
      observedPlan: 'chatgptprolite'
    };
    expect(confirmedSubscription({ confirmation: proof }, 'pro_5x', expected)).toBe(true);
    for (const invalid of [
      { ...proof, accountId: 'other', expectedAccountId: 'other' },
      { ...proof, observedPlan: 'chatgptpro' },
      { ...proof, tierVerified: false },
      { ...proof, tierVerified: true, observedCanonicalPlan: 'pro_20x' },
      { ...proof, querySucceeded: false },
      { ...proof, hasActiveSubscription: false },
      { ...proof, observedPlan: 'pro' }
    ]) {
      expect(confirmedSubscription({ confirmation: invalid }, 'pro_5x', expected)).toBe(false);
    }
    expect(confirmedSubscription({ confirmation: proof }, 'pro_5x', '')).toBe(false);
    expect(
      confirmedSubscription(
        { confirmation: { ...proof, targetPlan: 'pro_20x', observedPlan: 'pro_20x' } },
        'pro_20x',
        expected
      )
    ).toBe(true);
    expect(
      confirmedSubscription(
        { confirmation: { ...proof, targetPlan: 'plus', observedPlan: 'chatgptplusplan' } },
        'plus',
        expected
      )
    ).toBe(true);
  });
  it('新增 Pro 500 保留旧套餐值，拒绝未知值和只有通用 Pro 的成功凭据', () => {
    for (const value of ['plus', 'pro_5x', 'pro_20x', 'pro_500']) expect(plan(value)).toBe(value);
    expect(() => plan('pro')).toThrow('套餐无效');
    expect(() => plan('pro_1000')).toThrow('套餐无效');
    const proof = {
      verified: true,
      source: 'subscription',
      querySucceeded: true,
      hasActiveSubscription: true,
      accountId: 'synthetic-account',
      expectedAccountId: 'synthetic-account',
      targetPlan: 'pro_500',
      observedPlan: 'pro'
    };
    for (const invalid of [
      proof,
      { ...proof, observedPlan: 'chatgptpro' },
      { ...proof, observedPlan: 'pro_500' },
      { ...proof, observedCanonicalPlan: 'pro_500' },
      { ...proof, tierVerified: true, observedCanonicalPlan: 'pro_20x' }
    ])
      expect(confirmedSubscription({ confirmation: invalid }, 'pro_500', 'synthetic-account')).toBe(
        false
      );
    expect(
      confirmedSubscription(
        { confirmation: { ...proof, tierVerified: true, observedCanonicalPlan: 'pro_500' } },
        'pro_500',
        'synthetic-account'
      )
    ).toBe(true);
    expect(
      confirmedSubscription(
        { confirmation: { ...proof, targetPlan: 'pro_20x', observedPlan: 'chatgptpro' } },
        'pro_20x',
        'synthetic-account'
      )
    ).toBe(false);
    expect(ONLINE_RECHARGE_DEFAULTS.planNamePro500).toBe('');
  });
  it('日志和公开结果递归移除凭据、卡号和结账链接', () => {
    const value = sanitize({
      session: 'secret',
      cvc: '123',
      raw: {
        accessToken: 'secret',
        card_number: '4242424242424242',
        email: 'fixture@example.invalid',
        checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_synthetic'
      },
      message: 'card_number=4242424242424242'
    });
    expect(JSON.stringify(value)).not.toContain('4242424242424242');
    expect(JSON.stringify(value)).not.toContain('cs_synthetic');
    expect(JSON.stringify(value)).toContain('f***@example.invalid');
    expect(redact('https://checkout.stripe.com/c/pay/cs_synthetic')).toBe('（支付链接已脱敏）');
  });
  it('付款证据的合法UUID和固定报价摘要原样保留，日志脱敏规则不变', () => {
    const uuid = '12345678-1234-4567-8def-123456789012';
    const evidence = {
      accountId: uuid,
      expectedAccountId: uuid,
      cardId: uuid,
      recheckTaskId: uuid,
      recheckedByTaskId: uuid,
      quoteId: 'quote:123456789012abcdefabcdefabcdefab'
    };
    expect(sanitize({ paymentEvidence: evidence })).toEqual({ paymentEvidence: evidence });
    expect(redact(uuid)).not.toBe(uuid);
  });
  it('相同元数据字段中的银行卡号码或令牌仍脱敏，其他字段不能借UUID形状绕过', () => {
    const pan = '4242424242424242';
    const token = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.synthetic';
    for (const value of [pan, token]) {
      const safe = sanitize(
        Object.fromEntries(
          [
            'accountId',
            'expectedAccountId',
            'cardId',
            'recheckTaskId',
            'recheckedByTaskId',
            'quoteId'
          ].map((key) => [key, value])
        )
      );
      expect(JSON.stringify(safe)).not.toContain(value);
    }
    const uuid = '12345678-1234-4567-8def-123456789012';
    expect(sanitize({ message: uuid })).not.toEqual({ message: uuid });
    expect(sanitize({ accessToken: uuid, card_number: uuid })).toEqual({});
  });
  it('不允许旧版本、其他所有者、到期或待核对任务继续执行', () => {
    const leaseId = randomUUID(),
      taskId = randomUUID();
    const row = {
      id: taskId,
      status: 'running',
      leaseOwner: 'fixture-worker',
      leaseId,
      leaseVersion: 3,
      leaseExpiresAt: new Date(Date.now() + 60000)
    } as OnlineRechargeTask;
    const rpc = {
      method: 'heartbeat',
      taskId,
      workerId: 'fixture-worker',
      leaseId,
      leaseVersion: 3
    };
    expect(requireTaskLease(row, rpc).id).toBe(taskId);
    for (const invalid of [
      { ...rpc, leaseVersion: 2 },
      { ...rpc, workerId: 'another' },
      { ...rpc, leaseId: randomUUID() }
    ])
      expect(() => requireTaskLease(row, invalid)).toThrow('租约失效');
    expect(() => requireTaskLease({ ...row, leaseExpiresAt: new Date(0) }, rpc)).toThrow(
      '租约失效'
    );
    expect(() => requireTaskLease({ ...row, status: 'awaiting_review' }, rpc)).toThrow('租约失效');
  });
  it('内部凭证缺失、短凭证或不匹配一律拒绝', () => {
    const testKey = 'synthetic-test-key-that-is-not-used-externally';
    expect(secureEqual(testKey, testKey)).toBe(true);
    expect(secureEqual('wrong', testKey)).toBe(false);
    expect(secureEqual('short', 'short')).toBe(false);
    expect(secureEqual(undefined, undefined)).toBe(false);
  });
  it('员工取密权限缺失或被设为须审批时关闭，管理员仍按既有策略允许', () => {
    const key = 'id_business_v2.online_recharge.sensitive';
    const employee = {
      id: randomUUID(),
      username: 'fixture',
      displayName: '测试',
      roles: ['employee'],
      permissions: [] as string[]
    };
    expect(() => assertOnlineSensitive(employee)).toThrow('权限');
    expect(() =>
      assertOnlineSensitive({
        ...employee,
        permissions: [key],
        sensitiveApprovalPermissionCodes: [key]
      })
    ).toThrow('审批');
    expect(() => assertOnlineSensitive({ ...employee, permissions: [key] })).not.toThrow();
    expect(() =>
      assertOnlineSensitive({
        ...employee,
        roles: ['admin'],
        sensitiveApprovalPermissionCodes: [key]
      })
    ).not.toThrow();
  });
  it('运行资料下载遵守敏感权限和审批策略，拒绝时不接触文件仓储', () => {
    let reads = 0;
    const artifacts = new OnlineRechargeArtifactsService({
      download: () => {
        reads++;
        return Promise.resolve('fixture');
      }
    } as unknown as OnlineRechargeArtifactsRepository);
    const user = {
      id: randomUUID(),
      username: 'fixture',
      displayName: '测试',
      roles: ['employee'],
      permissions: ['id_business_v2.online_recharge.read']
    };
    expect(() => artifacts.download(randomUUID(), user)).toThrow('权限');
    expect(() =>
      artifacts.download(randomUUID(), {
        ...user,
        permissions: ['id_business_v2.online_recharge.sensitive'],
        sensitiveApprovalPermissionCodes: ['id_business_v2.online_recharge.sensitive']
      })
    ).toThrow('审批');
    expect(reads).toBe(0);
    expect(() => artifacts.download(randomUUID(), { ...user, roles: ['admin'] })).not.toThrow();
    expect(reads).toBe(1);
  });
  it('数字卡号和驼峰字段脱敏，日志邮箱与不透明凭据遮盖而Decimal金额保留', () => {
    const safe = sanitize({
      provider: {
        cardNumber: 4242424242424242,
        pan: 4000000000000002,
        number: '4242424242424242',
        nested: [4242424242424242]
      },
      amount: '10000000000000.1234',
      message:
        'fixture@example.invalid opaqueToken=synthetic-opaque-secret pk_live_synthetic {"accessToken":"opaque-json-credential"} Bearer opaque-bearer-credential'
    });
    const encoded = JSON.stringify(safe);
    expect(encoded).not.toContain('4242424242424242');
    expect(encoded).not.toContain('4000000000000002');
    expect(encoded).not.toContain('fixture@example.invalid');
    expect(encoded).not.toContain('synthetic-opaque-secret');
    expect(encoded).not.toContain('pk_live_synthetic');
    expect(encoded).not.toContain('opaque-json-credential');
    expect(encoded).not.toContain('opaque-bearer-credential');
    expect(encoded).toContain('10000000000000.1234');
  });
});
