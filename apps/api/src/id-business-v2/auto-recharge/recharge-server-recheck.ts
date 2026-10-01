import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException
} from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/auth.types';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  toV2JsonDocument
} from '../runtime/public-api';
import { parseIdBusinessV2TotpSecret } from '../workspace/public-api';
import { BankRechargeAccountService } from './bank-recharge-account.service';
import { RechargeProxyService } from './recharge-proxy.service';
import { RechargeRepository } from './persistence/recharge.repository';
import { object, uuidPattern } from './recharge-validation';
import { isRechargeWorkerConfigured, sendRechargeWorkerRequest } from './recharge-worker-client';

export async function startServerRecheck(
  value: unknown,
  operator: AuthenticatedUser,
  deps: {
    repository: RechargeRepository;
    transactions: V2CommandTransactionManager;
    audit: V2TransactionalAuditService;
    accounts?: BankRechargeAccountService;
    proxies?: RechargeProxyService;
    finishUnreceivedJob: (id: string, ownerId: string, unknown: boolean) => Promise<void>;
  }
) {
  if (!isRechargeWorkerConfigured()) throw new ServiceUnavailableException('服务器执行器尚未配置');
  const input = object(value);
  if (
    Object.keys(input).some(
      (key) => !['id', 'sourceJobId', 'sessionJson', 'login', 'chatgptAccountId'].includes(key)
    ) ||
    typeof input.id !== 'string' ||
    !uuidPattern.test(input.id) ||
    typeof input.sourceJobId !== 'string' ||
    !uuidPattern.test(input.sourceJobId) ||
    Number(typeof input.sessionJson === 'string') +
      Number(input.login !== undefined) +
      Number(input.chatgptAccountId !== undefined) !==
      1
  ) {
    throw new BadRequestException('只读复查资料格式无效');
  }
  if (
    input.sessionJson !== undefined &&
    (typeof input.sessionJson !== 'string' ||
      input.sessionJson.length < 2 ||
      Buffer.byteLength(input.sessionJson) > 65000)
  ) {
    throw new BadRequestException('授权 JSON 无效');
  }
  if (
    input.chatgptAccountId !== undefined &&
    (typeof input.chatgptAccountId !== 'string' || !uuidPattern.test(input.chatgptAccountId))
  ) {
    throw new BadRequestException('ChatGPT 账号编号无效');
  }
  const jobId = input.id as string;
  const savedAccountId = input.chatgptAccountId as string | undefined;
  let manualLogin: {
    email: string;
    password: string;
    totp?: ReturnType<typeof parseIdBusinessV2TotpSecret>;
  } | null = null;
  if (input.login !== undefined) {
    const login = object(input.login);
    if (
      Object.keys(login).some((key) => !['email', 'password', 'totpSecret'].includes(key)) ||
      typeof login.email !== 'string' ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(login.email) ||
      login.email.length > 250 ||
      typeof login.password !== 'string' ||
      !login.password ||
      login.password.length > 1024 ||
      (login.totpSecret !== undefined &&
        (typeof login.totpSecret !== 'string' || login.totpSecret.length > 2048))
    ) {
      throw new BadRequestException('本次登录资料格式无效');
    }
    try {
      manualLogin = {
        email: login.email.trim(),
        password: login.password,
        ...(login.totpSecret ? { totp: parseIdBusinessV2TotpSecret(login.totpSecret) } : {})
      };
    } catch {
      throw new BadRequestException('2FA 密钥格式无效');
    }
  }
  const source = await deps.repository.owned(input.sourceJobId, operator.id);
  const sourceResult = object(source.result ?? {});
  const reviewableState =
    ['finished', 'unknown'].includes(source.state) ||
    (source.state === 'running' && source.leaseUntil.getTime() < Date.now());
  if (
    source.action !== 'server' ||
    !reviewableState ||
    !source.accountKey ||
    !source.expectedEmailEncrypted ||
    !source.proxyId ||
    sourceResult.recheck_only === true ||
    sourceResult.payment_requests_sent !== 1 ||
    sourceResult.quote_authority !== 'official_checkout_response' ||
    typeof sourceResult.checkout_identifier !== 'string' ||
    sourceResult.status === 'subscription_activated' ||
    sourceResult.payment_status === 'declined' ||
    sourceResult.operator_resolution === 'confirmed_no_bank_request'
  ) {
    throw new ConflictException('该记录不能只读复查原订单');
  }
  if (input.chatgptAccountId && input.chatgptAccountId !== source.chatgptAccountId) {
    throw new ConflictException('复查账号与原任务不一致');
  }
  if (!deps.accounts || !deps.proxies) throw new ServiceUnavailableException('复查服务不可用');
  const expectedEmail = deps.accounts.decryptExpectedEmail(source.expectedEmailEncrypted);
  if (manualLogin && manualLogin.email.toLowerCase() !== expectedEmail.toLowerCase()) {
    throw new ConflictException('复查邮箱与原任务不一致');
  }
  const selectedProxy = await deps.proxies.forCharge(source.proxyId, operator);
  const proxy =
    selectedProxy.mode === 'dynamic'
      ? {
          mode: 'dynamic' as const,
          type: selectedProxy.type,
          extractionUrl: selectedProxy.extractionUrl
        }
      : {
          mode: 'static' as const,
          type: selectedProxy.type,
          host: selectedProxy.host,
          port: selectedProxy.port,
          username: selectedProxy.username,
          password: selectedProxy.password
        };
  const result = await deps.transactions.execute(
    async (tx) => {
      await deps.repository.lock(tx);
      if (await deps.repository.findJob(tx, jobId)) throw new ConflictException('操作编号已使用');
      if (await deps.repository.findRunningJob(tx))
        throw new ConflictException('已有一笔任务执行中');
      const current = await deps.repository.findJob(tx, source.id);
      if (
        !current ||
        current.ownerId !== operator.id ||
        current.state !== source.state ||
        current.accountKey !== source.accountKey
      )
        throw new ConflictException('原任务状态已变化');
      const account = savedAccountId
        ? await deps.accounts!.requireActive(tx, savedAccountId)
        : null;
      const login = account ? deps.accounts!.savedLogin(account) : manualLogin;
      if (login && login.email.toLowerCase() !== expectedEmail.toLowerCase())
        throw new ConflictException('复查邮箱与原任务不一致');
      await deps.accounts!.loginNetworkGuard(tx, expectedEmail, selectedProxy.countryCode);
      const job = await deps.repository.createJob(tx, {
        id: jobId,
        ownerId: operator.id,
        accountKey: source.accountKey,
        chatgptAccountId: source.chatgptAccountId,
        cardId: source.cardId,
        billingNameEncrypted: source.billingNameEncrypted,
        expectedEmailEncrypted: source.expectedEmailEncrypted,
        proxyId: source.proxyId,
        plan: source.plan,
        action: 'server',
        state: 'running',
        leaseUntil: new Date(Date.now() + 16 * 60000),
        result: toV2JsonDocument({
          status: 'rechecking_original_payment',
          recheck_only: true,
          source_job_id: source.id,
          expected_proxy_country: selectedProxy.countryCode,
          addressId: sourceResult.addressId,
          payment_attempted: true,
          payment_status: 'unknown',
          payment_requests_sent: 0
        })
      });
      await deps.audit.append(tx, {
        userId: operator.id,
        module: 'id_business_v2',
        action: 'id_business_v2.auto_recharge.server.recheck',
        objectType: 'recharge_job',
        objectId: job.id,
        afterData: { sourceJobId: source.id, plan: source.plan },
        remark: '服务器只读复查原付款，不提交新付款'
      });
      return { job, login };
    },
    { changedScopes: ['auto-recharge'], requestId: jobId, operator, retryMode: 'none' }
  );
  try {
    const receipt = await sendRechargeWorkerRequest(
      '/jobs/' + jobId,
      {
        action: 'server',
        plan: source.plan,
        recheckOnly: true,
        sourceAccountKey: source.accountKey,
        expectedEmail,
        expectedCountry: selectedProxy.countryCode,
        proxy,
        ...(result.login ? { login: result.login } : { sessionJson: input.sessionJson })
      },
      jobId,
      'accepted'
    );
    if (receipt !== 'accepted') {
      await deps.finishUnreceivedJob(jobId, operator.id, receipt === 'unknown');
      throw new ServiceUnavailableException(
        receipt === 'unknown' ? '复查接收结果待核验，系统不会自动重发' : '执行器未接收复查任务'
      );
    }
  } finally {
    if (manualLogin) {
      manualLogin.password = '';
      manualLogin.totp = undefined;
    }
    if (result.login) {
      result.login.password = '';
      result.login.totp = undefined;
    }
    if (input.login && typeof input.login === 'object') {
      const submitted = input.login as Record<string, unknown>;
      submitted.password = '';
      submitted.totpSecret = '';
    }
    input.sessionJson = '';
  }
  return { id: result.job.id };
}
