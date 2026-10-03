import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException
} from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/auth.types';
import {
  Amount4,
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  toV2JsonDocument
} from '../runtime/public-api';
import { RechargeRepository } from './persistence/recharge.repository';
import { RechargeAddressRepository } from './persistence/recharge-address.repository';
import { BankRechargeAccountService } from './bank-recharge-account.service';
import type { RechargeNameService } from './recharge-name.service';
import { BankRechargeCardService } from './bank-recharge-card.service';
import { RechargeSettingsService } from './recharge-settings.service';
import { RechargeProxyService } from './recharge-proxy.service';
import type { IdBusinessV2TotpAccountService } from '../workspace/public-api';
import {
  clearRechargeDetails,
  clearRechargeStartSecrets,
  parseRechargeTotpSecret,
  rechargeDetailsWithAddress
} from './recharge-job-helpers';
import { object, validateStart } from './recharge-validation';
import { isRechargeWorkerConfigured, sendRechargeWorkerRequest } from './recharge-worker-client';

export interface RechargeStartDependencies {
  repository: RechargeRepository;
  addressRepository: RechargeAddressRepository;
  transactions: V2CommandTransactionManager;
  audit: V2TransactionalAuditService;
  bankAccounts?: BankRechargeAccountService;
  bankCards?: BankRechargeCardService;
  names?: RechargeNameService;
  settings?: RechargeSettingsService;
  proxies?: RechargeProxyService;
  totpAccounts?: IdBusinessV2TotpAccountService;
  finishUnreceivedJob: (id: string, ownerId: string, unknown: boolean) => Promise<void>;
}

export async function startRechargeJob(
  value: unknown,
  operator: AuthenticatedUser,
  deps: RechargeStartDependencies
) {
  if (!isRechargeWorkerConfigured()) {
    throw new ServiceUnavailableException('服务器执行器尚未配置');
  }
  const input = validateStart(value);
  let manualLogin: {
    email: string;
    password: string;
    totp?: ReturnType<typeof parseRechargeTotpSecret>;
  } | null = null;
  if (input.login) {
    try {
      manualLogin = {
        email: input.login.email.trim(),
        password: input.login.password,
        ...(input.login.totpSecret ? { totp: parseRechargeTotpSecret(input.login.totpSecret) } : {})
      };
    } catch {
      throw new BadRequestException('2FA 密钥格式无效');
    }
  }
  if (input.action === 'server') {
    await deps.bankCards?.checkAvailability({ number: input.details!.number });
  }
  const selectedProxy =
    input.action === 'server' && input.proxyId
      ? await deps.proxies?.forCharge(input.proxyId, operator, input.proxyCountryCode)
      : null;
  if (input.action === 'server' && !selectedProxy)
    throw new ServiceUnavailableException('请选择可用的代理国家和代理 IP');
  const serverProxy =
    input.action !== 'server'
      ? null
      : selectedProxy?.mode === 'dynamic'
        ? {
            mode: 'dynamic' as const,
            type: selectedProxy.type,
            extractionUrl: selectedProxy.extractionUrl
          }
        : selectedProxy?.mode === 'static'
          ? {
              mode: 'static' as const,
              type: selectedProxy.type,
              host: selectedProxy.host,
              port: selectedProxy.port,
              username: selectedProxy.username,
              password: selectedProxy.password
            }
          : null;
  if (input.action === 'server' && !serverProxy)
    throw new ServiceUnavailableException('服务器代理配置不可用');
  const result = await deps.transactions.execute(
    async (tx) => {
      await deps.repository.lock(tx);
      const previous = await deps.repository.findJob(tx, input.id);
      if (previous) {
        if (previous.ownerId !== operator.id) throw new ForbiddenException('无权访问此任务');
        if (previous.plan !== input.plan || previous.action !== input.action) {
          throw new ConflictException('同一操作编号不能更换套餐或步骤');
        }
        if (
          ['prepare', 'server'].includes(input.action) &&
          (input.manualAddress === true
            ? object(previous.result).manual_address !== true
            : object(previous.result).addressId !== input.addressId)
        ) {
          throw new ConflictException('同一操作编号不能更换账单地址');
        }
        return { job: previous, created: false, address: null, login: null, previousLoginIp: null };
      }
      const active = await deps.repository.findRunningJob(tx);
      if (active) throw new ConflictException('已有一笔任务执行中，请先查看执行记录');
      const manualAddress =
        input.action === 'server' && input.manualAddress === true
          ? await deps.addressRepository.createOrReuseManual(tx, operator.id, input.details!)
          : null;
      const address =
        manualAddress?.address ??
        (input.action === 'server'
          ? await deps.addressRepository.requireAvailable(tx, operator.id, input.addressId!)
          : input.action === 'prepare'
            ? await deps.addressRepository.requireUnused(tx, operator.id, input.addressId!)
            : null);
      if (manualAddress?.created) {
        await deps.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.auto_recharge.addresses.create_manual',
          objectType: 'recharge_address',
          objectId: address!.id,
          afterData: { country: address!.country },
          remark: '保存本次手填真实账单地址'
        });
      }
      const account =
        input.action === 'server' && input.chatgptAccountId
          ? await deps.bankAccounts?.assertRechargeEligible(tx, input.chatgptAccountId, input.plan)
          : null;
      if (input.chatgptAccountId && !account)
        throw new ServiceUnavailableException('ChatGPT 账号服务不可用');
      const login = account ? deps.bankAccounts!.savedLogin(account) : manualLogin;
      if (login && login.email.toLowerCase() !== input.details!.email.toLowerCase())
        throw new ConflictException('账单邮箱与登录账号不一致');
      if (login && input.login?.totpAccountId) {
        if (!deps.totpAccounts) throw new ServiceUnavailableException('系统 2FA 服务不可用');
        login.totp = await deps.totpAccounts.forExecution(tx, input.login.totpAccountId, operator);
      }
      const previousLoginIp =
        input.action === 'server'
          ? await deps.bankAccounts?.loginNetworkGuard(
              tx,
              input.details!.email,
              input.proxyCountryCode!
            )
          : null;
      const resolvedCard =
        input.action === 'server' && deps.names
          ? await deps.names.prepareCard(
              tx,
              { ...input.details!, currencyCode: input.lockedCurrency! },
              operator
            )
          : null;
      if (resolvedCard && input.cardId && resolvedCard.id !== input.cardId)
        throw new ConflictException('所选银行卡与输入卡号不一致');
      const paymentCardId = resolvedCard?.id ?? input.cardId;
      if (input.action === 'server' && paymentCardId) {
        if (!deps.bankCards) throw new ServiceUnavailableException('银行卡服务不可用');
        await deps.bankCards.assertRechargeCard(
          tx,
          paymentCardId,
          input.details!.number,
          input.lockedCurrency!,
          input.details!.name,
          address!.id
        );
      }
      const currency =
        input.action === 'server'
          ? await deps.bankAccounts?.requireCurrency(tx, input.lockedCurrency!)
          : null;
      if (input.action === 'server' && !currency) throw new BadRequestException('锁定币种不可用');
      const policyLimit =
        input.action === 'server'
          ? await deps.settings?.requirePaymentCap(tx, input.plan, input.lockedCurrency!)
          : null;
      if (input.action === 'server' && !policyLimit)
        throw new ServiceUnavailableException('请先配置本套餐与币种的付款安全上限');
      if (
        input.action === 'server' &&
        input.maxAmount &&
        Amount4.from(input.maxAmount).gt(policyLimit!)
      )
        throw new BadRequestException('本次最高金额不能高于系统付款安全上限');
      const effectiveMax = input.action === 'server' ? (input.maxAmount ?? policyLimit!) : null;
      const maximum = effectiveMax ? effectiveMax.split('.') : [];
      if (
        input.action === 'server' &&
        (currency!.minorUnits > 2 || (maximum[1]?.length ?? 0) > currency!.minorUnits)
      )
        throw new BadRequestException('最高金额与币种精度不匹配');
      const amountMinor =
        input.action === 'server'
          ? Number(
              BigInt(Amount4.from(effectiveMax!).toFixed(currency!.minorUnits).replace('.', ''))
            )
          : 0;
      if (input.action === 'server' && (!Number.isSafeInteger(amountMinor) || amountMinor <= 0))
        throw new BadRequestException('最高金额超出安全范围');
      const job = await deps.repository.createJob(tx, {
        id: input.id,
        ownerId: operator.id,
        proxyId: selectedProxy?.id ?? null,
        cardId: paymentCardId ?? null,
        chatgptAccountId: input.chatgptAccountId ?? null,
        expectedEmailEncrypted:
          input.action === 'server'
            ? deps.bankAccounts?.encryptExpectedEmail(input.details!.email)
            : null,
        billingNameEncrypted:
          input.action === 'server' && paymentCardId
            ? deps.bankCards?.encryptBillingName(input.details!.name)
            : null,
        plan: input.plan,
        action: input.action,
        state: 'running',
        result: toV2JsonDocument(
          address
            ? {
                addressId: address.id,
                ...(manualAddress ? { manual_address: true } : {}),
                ...(input.action === 'server'
                  ? {
                      locked_currency: input.lockedCurrency,
                      max_amount: effectiveMax,
                      max_amount_minor: amountMinor,
                      expected_proxy_country: input.proxyCountryCode,
                      mode: 'server'
                    }
                  : {})
              }
            : {}
        ),
        // 服务器代理准备最多 1200 秒，另留 60 秒接收回执。
        leaseUntil: new Date(Date.now() + (input.action === 'server' ? 21 : 16) * 60000)
      });
      await deps.audit.append(tx, {
        userId: operator.id,
        module: 'id_business_v2',
        action: 'id_business_v2.auto_recharge.start',
        objectType: 'recharge_job',
        objectId: job.id,
        afterData: {
          plan: input.plan,
          action: input.action,
          ...(address ? { addressId: address.id } : {})
        },
        remark: '启动单笔订阅操作'
      });
      return { job, created: true, address, login, previousLoginIp };
    },
    { changedScopes: ['auto-recharge'], requestId: input.id, operator, retryMode: 'none' }
  );
  if (result.created) {
    const workerInput = { ...input };
    try {
      delete workerInput.addressId;
      delete workerInput.manualAddress;
      delete workerInput.proxyId;
      delete workerInput.proxyCountryCode;
      delete workerInput.chatgptAccountId;
      delete workerInput.cardId;
      delete workerInput.maxAmount;
      if (result.login) Object.assign(workerInput, { login: result.login });
      delete workerInput.login?.totpSecret;
      delete workerInput.login?.totpAccountId;
      if (input.action === 'prepare' && input.details && result.address) {
        workerInput.details = rechargeDetailsWithAddress(input.details, result.address);
      }
      if (input.action === 'server' && input.details && result.address && serverProxy) {
        workerInput.details = rechargeDetailsWithAddress(input.details, result.address);
        Object.assign(workerInput, {
          proxy: serverProxy,
          safety: {
            lockedCurrency: input.lockedCurrency,
            maxAmountMinor: Number(object(result.job.result).max_amount_minor),
            authorizeSinglePayment: true
          },
          expectedCountry: input.proxyCountryCode,
          previousLoginIp: serverProxy.mode === 'dynamic' ? result.previousLoginIp : null,
          expectedEmail: input.details.email
        });
      }
      const receipt = await sendRechargeWorkerRequest(
        '/jobs/' + input.id,
        workerInput,
        input.id,
        'accepted'
      );
      if (receipt !== 'accepted') {
        await deps.finishUnreceivedJob(input.id, operator.id, receipt === 'unknown');
        throw new ServiceUnavailableException(
          receipt === 'unknown'
            ? '执行器接收结果待核验，系统不会自动重发'
            : '执行器未接收本次任务，请重新开始'
        );
      }
    } finally {
      clearRechargeStartSecrets(input);
      clearRechargeDetails(workerInput.details);
      if (result.login) {
        result.login.password = '';
        result.login.totp = undefined;
      }
    }
  }
  return { id: result.job.id };
}
