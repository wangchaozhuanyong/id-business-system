import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { V2_RECHARGE_PLANS, type V2RechargeServerProxySettings } from '@apple-business/shared';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  Amount4,
  type V2CommandTransaction,
  toV2JsonDocument
} from '../runtime/public-api';
import { RechargeSettingsRepository } from './persistence/recharge-settings.repository';
import { RechargeProxyRepository } from './persistence/recharge-proxy.repository';
import { bankRechargeId, bankRechargeObject, bankRechargeUuid } from './bank-recharge-validation';
import { validateRechargeBitBrowserSettings } from './recharge-settings-validation';
import { storedBrowserOptions, validateStaticCredentials } from './recharge-browser-options';
import { accountCopyMetadata } from './account-copy-settings';

const defaults = {
  connectorUrl: 'http://127.0.0.1:55321',
  localApiUrl: 'http://127.0.0.1:54345',
  groupName: 'gpt账号注册',
  tagName: '申请gpt',
  proxyType: 'http' as const
};

const maskSecret = (value: string) => `已保存 ····${value.slice(-4)}`;
const maskUrl = (value: string) => {
  const url = new URL(value);
  return `${url.protocol}//${url.host}/…（已加密）`;
};

function serverDefaultProxyId(options: unknown): string | null {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return null;
  const value = (options as Record<string, unknown>).serverDefaultProxyId;
  return typeof value === 'string' && bankRechargeUuid.test(value) ? value : null;
}

@Injectable()
export class RechargeSettingsService {
  constructor(
    private readonly repository: RechargeSettingsRepository,
    private readonly encryption: FieldEncryptionService,
    private readonly transactions: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService,
    private readonly proxies: RechargeProxyRepository
  ) {}

  async get(operator: AuthenticatedUser) {
    return this.response(await this.repository.find(operator.id));
  }

  async getServerProxySettings(
    operator: AuthenticatedUser
  ): Promise<V2RechargeServerProxySettings> {
    const row = await this.repository.find(operator.id);
    const proxyId = serverDefaultProxyId(row?.browserOptions);
    const proxy = proxyId ? await this.proxies.find(proxyId) : null;
    return {
      proxyId,
      proxy: proxy
        ? {
            id: proxy.id,
            countryCode: proxy.countryCode,
            kind: proxy.kind,
            connectionMode: proxy.connectionMode,
            protocol: proxy.protocol as 'http' | 'https' | 'socks5',
            status: proxy.active ? 'active' : 'disabled',
            remark1: proxy.remark1
          }
        : null,
      legacyConfigured: Boolean(
        row?.dynamicProxyUrlEncrypted || row?.staticProxyCredentialsEncrypted
      )
    };
  }

  async updateServerProxySettings(value: unknown, operator: AuthenticatedUser) {
    const input = bankRechargeObject(value);
    if (Object.keys(input).some((key) => key !== 'proxyId') || !Object.hasOwn(input, 'proxyId')) {
      throw new BadRequestException('默认代理设置格式无效');
    }
    const proxyId = input.proxyId === null ? null : bankRechargeId(input.proxyId, '默认代理编号');
    await this.transactions.execute(
      async (tx) => {
        if (proxyId) {
          const proxy = await this.proxies.findInTransaction(tx, proxyId);
          if (!proxy || !proxy.active)
            throw new BadRequestException('请选择代理 IP 管理中的启用代理');
        }
        const before = await this.repository.findInTransaction(tx, operator.id);
        await this.repository.upsert(tx, operator.id, {
          browserOptions: toV2JsonDocument({
            ...storedBrowserOptions(before?.browserOptions),
            ...accountCopyMetadata(before?.browserOptions),
            serverDefaultProxyId: proxyId
          })
        });
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.auto_recharge.server_proxy_settings.update',
          objectType: 'recharge_browser_settings',
          objectId: operator.id,
          beforeData: { proxyId: serverDefaultProxyId(before?.browserOptions) },
          afterData: { proxyId },
          remark: '设置服务器默认代理，引用代理 IP 管理中的资料'
        });
      },
      { changedScopes: ['auto-recharge'], requestId: randomUUID(), operator, retryMode: 'none' }
    );
    return this.getServerProxySettings(operator);
  }

  async paymentCaps() {
    const items = await this.repository.listPaymentCaps();
    return {
      items: items.map((item) => ({
        plan: item.plan,
        currencyCode: item.currencyCode,
        maxAmount: item.maxAmount.toString()
      }))
    };
  }

  async requirePaymentCap(tx: V2CommandTransaction, plan: string, currencyCode: string) {
    const cap = await this.repository.paymentCap(tx, plan, currencyCode);
    if (!cap)
      throw new ServiceUnavailableException('请先在服务器设置中配置该套餐和币种的付款安全上限');
    return cap.maxAmount.toString();
  }

  async updatePaymentCap(
    plan: string,
    currencyCode: string,
    value: unknown,
    operator: AuthenticatedUser
  ) {
    if (!V2_RECHARGE_PLANS.includes(plan as never) || !/^[A-Z]{3}$/.test(currencyCode))
      throw new BadRequestException('套餐或币种无效');
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new BadRequestException('付款安全上限格式无效');
    const input = value as Record<string, unknown>;
    if (
      Object.keys(input).some((key) => key !== 'maxAmount') ||
      typeof input.maxAmount !== 'string' ||
      !/^[0-9]{1,9}(?:\.[0-9]{1,2})?$/.test(input.maxAmount)
    )
      throw new BadRequestException('付款安全上限格式无效');
    const amount = Amount4.from(input.maxAmount);
    if (!amount.gt('0')) throw new BadRequestException('付款安全上限必须大于零');
    return this.transactions.execute(
      async (tx) => {
        const currency = await this.repository.currencyForCap(tx, currencyCode);
        if (
          !currency ||
          !currency.active ||
          currency.minorUnits > 2 ||
          ((input.maxAmount as string).split('.')[1]?.length ?? 0) > currency.minorUnits
        )
          throw new BadRequestException('币种不可用或金额精度不匹配');
        const before = await this.repository.paymentCap(tx, plan, currencyCode);
        const updated = await this.repository.upsertPaymentCap(
          tx,
          plan,
          currencyCode,
          amount.toString(),
          operator.id
        );
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.auto_recharge.payment_cap.update',
          objectType: 'recharge_payment_cap',
          objectId: `${plan}:${currencyCode}`,
          beforeData: before ? { maxAmount: before.maxAmount.toString() } : undefined,
          afterData: { maxAmount: updated.maxAmount.toString() },
          remark: '设置服务器充值按套餐和币种的付款安全上限'
        });
        return { plan, currencyCode, maxAmount: updated.maxAmount.toString() };
      },
      { changedScopes: ['auto-recharge'], requestId: randomUUID(), operator, retryMode: 'none' }
    );
  }

  async catalogAccess(operator: AuthenticatedUser) {
    return this.transactions.execute(
      async (tx) => {
        const row = await this.repository.findInTransaction(tx, operator.id);
        const localApiToken = this.encryption.decrypt(row?.localApiTokenEncrypted);
        const connectorToken = this.encryption.decrypt(row?.connectorTokenEncrypted);
        if (!row || !localApiToken || !connectorToken) {
          throw new ServiceUnavailableException(
            '请先填写比特接口密钥和本机连接密钥，再刷新分组与标签'
          );
        }
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.auto_recharge.bitbrowser_catalog.access',
          objectType: 'recharge_browser_settings',
          objectId: operator.id,
          remark: '使用本机连接凭据读取比特浏览器分组与标签'
        });
        return {
          connectorUrl: row.connectorUrl,
          connectorToken,
          localApiUrl: row.localApiUrl,
          localApiToken
        };
      },
      { changedScopes: ['audit-logs'], requestId: randomUUID(), operator, retryMode: 'none' }
    );
  }

  async update(value: unknown, operator: AuthenticatedUser) {
    const input = validateRechargeBitBrowserSettings(value);
    const row = await this.transactions.execute(
      async (tx) => {
        const before = await this.repository.findInTransaction(tx, operator.id);
        const browserOptions = input.browserOptions ?? storedBrowserOptions(before?.browserOptions);
        const staticProxyCredentialsEncrypted = input.clearStaticProxyCredentials
          ? null
          : input.staticProxyCredentials
            ? this.encryption.encrypt(JSON.stringify(input.staticProxyCredentials))
            : before?.staticProxyCredentialsEncrypted;
        const localApiTokenEncrypted = input.localApiToken
          ? this.encryption.encrypt(input.localApiToken)
          : before?.localApiTokenEncrypted;
        const connectorTokenEncrypted = input.connectorToken
          ? this.encryption.encrypt(input.connectorToken)
          : before?.connectorTokenEncrypted;
        const dynamicProxyUrlEncrypted = input.dynamicProxyUrl
          ? this.encryption.encrypt(input.dynamicProxyUrl)
          : before?.dynamicProxyUrlEncrypted;
        if (
          (!input.serverMode && (!localApiTokenEncrypted || !connectorTokenEncrypted)) ||
          (browserOptions.proxyMode === 'dynamic' && !dynamicProxyUrlEncrypted)
        ) {
          throw new BadRequestException('请填写连接密钥及当前代理模式所需的配置');
        }
        if (input.serverMode && browserOptions.proxyMode === 'dynamic') {
          const extractionUrl = this.encryption.decrypt(dynamicProxyUrlEncrypted);
          if (!extractionUrl || new URL(extractionUrl).protocol !== 'https:')
            throw new BadRequestException('服务器动态 IP 提取链接必须使用 HTTPS');
        }
        const updated = await this.repository.upsert(tx, operator.id, {
          connectorUrl: input.connectorUrl,
          localApiUrl: input.localApiUrl,
          localApiTokenEncrypted,
          localApiTokenMask: input.localApiToken
            ? maskSecret(input.localApiToken)
            : before?.localApiTokenMask,
          connectorTokenEncrypted,
          connectorTokenMask: input.connectorToken
            ? maskSecret(input.connectorToken)
            : before?.connectorTokenMask,
          groupName: input.groupName,
          tagName: input.tagName,
          proxyType: input.proxyType,
          browserOptions: toV2JsonDocument({
            ...browserOptions,
            ...accountCopyMetadata(before?.browserOptions),
            ...(serverDefaultProxyId(before?.browserOptions)
              ? { serverDefaultProxyId: serverDefaultProxyId(before?.browserOptions) }
              : {})
          }),
          staticProxyCredentialsEncrypted,
          dynamicProxyUrlEncrypted,
          dynamicProxyUrlMask: input.dynamicProxyUrl
            ? maskUrl(input.dynamicProxyUrl)
            : before?.dynamicProxyUrlMask
        });
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.auto_recharge.bitbrowser_settings.update',
          objectType: 'recharge_browser_settings',
          objectId: operator.id,
          beforeData: before ? toV2JsonDocument(this.auditSnapshot(before)) : undefined,
          afterData: toV2JsonDocument(this.auditSnapshot(updated)),
          remark: input.serverMode ? '更新服务器充值代理设置' : '更新本机比特浏览器自动充值设置'
        });
        return updated;
      },
      {
        changedScopes: ['auto-recharge'],
        requestId: randomUUID(),
        operator,
        retryMode: 'none'
      }
    );
    return this.response(row);
  }

  async runtime(ownerId: string, selectedProxy = false) {
    const row = await this.repository.find(ownerId);
    const localApiToken = this.encryption.decrypt(row?.localApiTokenEncrypted);
    const connectorToken = this.encryption.decrypt(row?.connectorTokenEncrypted);
    const browserOptions = storedBrowserOptions(row?.browserOptions);
    const dynamicProxyUrl =
      browserOptions.proxyMode === 'dynamic'
        ? this.encryption.decrypt(row?.dynamicProxyUrlEncrypted)
        : '';
    if (
      !row ||
      !localApiToken ||
      !connectorToken ||
      (!selectedProxy && browserOptions.proxyMode === 'dynamic' && !dynamicProxyUrl)
    ) {
      throw new ServiceUnavailableException('请先完成比特浏览器设置');
    }
    const credentials =
      browserOptions.proxyMode === 'static'
        ? this.encryption.decrypt(row.staticProxyCredentialsEncrypted)
        : '';
    const staticProxyCredentials = credentials
      ? validateStaticCredentials(JSON.parse(credentials))
      : undefined;
    return {
      ...row,
      browserOptions,
      staticProxyCredentials,
      localApiToken,
      connectorToken,
      dynamicProxyUrl: dynamicProxyUrl || ''
    };
  }

  async serverProxy(ownerId: string) {
    const row = await this.repository.find(ownerId);
    const options = storedBrowserOptions(row?.browserOptions);
    if (!row) throw new ServiceUnavailableException('请先保存服务器代理设置');
    if (options.proxyMode === 'dynamic') {
      const extractionUrl = this.encryption.decrypt(row.dynamicProxyUrlEncrypted);
      if (!extractionUrl) throw new ServiceUnavailableException('请先保存动态 IP 提取链接');
      if (new URL(extractionUrl).protocol !== 'https:')
        throw new ServiceUnavailableException('服务器动态 IP 提取链接必须使用 HTTPS');
      return { mode: 'dynamic' as const, type: row.proxyType, extractionUrl };
    }
    if (!options.staticHost || !options.staticPort)
      throw new ServiceUnavailableException('请先保存固定代理地址');
    const encrypted = this.encryption.decrypt(row.staticProxyCredentialsEncrypted);
    const credentials = encrypted ? validateStaticCredentials(JSON.parse(encrypted)) : undefined;
    return {
      mode: 'static' as const,
      type: row.proxyType,
      host: options.staticHost,
      port: options.staticPort,
      username: credentials?.username ?? '',
      password: credentials?.password ?? ''
    };
  }

  private response(row: Awaited<ReturnType<RechargeSettingsRepository['find']>>) {
    return {
      connectorUrl: row?.connectorUrl ?? defaults.connectorUrl,
      localApiUrl: row?.localApiUrl ?? defaults.localApiUrl,
      localApiTokenConfigured: Boolean(row?.localApiTokenEncrypted),
      localApiTokenMask: row?.localApiTokenMask ?? null,
      connectorTokenConfigured: Boolean(row?.connectorTokenEncrypted),
      connectorTokenMask: row?.connectorTokenMask ?? null,
      groupName: row?.groupName ?? defaults.groupName,
      tagName: row?.tagName ?? defaults.tagName,
      proxyType: (row?.proxyType ?? defaults.proxyType) as 'http' | 'https' | 'socks5',
      dynamicProxyUrlConfigured: Boolean(row?.dynamicProxyUrlEncrypted),
      dynamicProxyUrlMask: row?.dynamicProxyUrlMask ?? null,
      browserOptions: storedBrowserOptions(row?.browserOptions),
      staticProxyCredentialsConfigured: Boolean(row?.staticProxyCredentialsEncrypted),
      updatedAt: row?.updatedAt.toISOString() ?? null
    };
  }

  private auditSnapshot(row: {
    connectorUrl: string;
    localApiUrl: string;
    localApiTokenMask: string | null;
    connectorTokenMask: string | null;
    groupName: string;
    tagName: string;
    proxyType: string;
    dynamicProxyUrlMask: string | null;
    browserOptions?: unknown;
    staticProxyCredentialsEncrypted?: string | null;
  }) {
    return {
      connectorUrl: row.connectorUrl,
      localApiUrl: row.localApiUrl,
      localApiTokenMask: row.localApiTokenMask,
      connectorTokenMask: row.connectorTokenMask,
      groupName: row.groupName,
      tagName: row.tagName,
      proxyType: row.proxyType,
      dynamicProxyUrlMask: row.dynamicProxyUrlMask,
      browserOptions: storedBrowserOptions(row.browserOptions),
      staticProxyCredentialsConfigured: Boolean(row.staticProxyCredentialsEncrypted)
    };
  }
}
