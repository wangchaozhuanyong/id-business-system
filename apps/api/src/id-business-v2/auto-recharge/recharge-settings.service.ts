import {
  BadRequestException,
  ConflictException,
  Injectable,
  ServiceUnavailableException
} from '@nestjs/common';
import {
  normalizeV2RechargeConnectorUrl,
  type V2RechargeServerProxySettings
} from '@apple-business/shared';
import { randomUUID } from 'node:crypto';
import { hash, object, uuidPattern } from './recharge-validation';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  toV2JsonDocument
} from '../runtime/public-api';
import { RechargeSettingsRepository } from './persistence/recharge-settings.repository';
import { RechargeProxyRepository } from './persistence/recharge-proxy.repository';
import { bankRechargeId, bankRechargeObject, bankRechargeUuid } from './bank-recharge-validation';
import { validateRechargeBitBrowserSettings } from './recharge-settings-validation';
import { storedBrowserOptions, validateStaticCredentials } from './recharge-browser-options';
import { accountCopyMetadata } from './account-copy-settings';
import { proxyProtocol, rechargeProxyConnection } from './recharge-proxy-validation';

const defaults = {
  connectorUrl: 'http://127.0.0.1:55321',
  localApiUrl: 'http://127.0.0.1:54345',
  groupName: 'gpt账号注册',
  tagName: '申请gpt',
  proxyType: 'http' as const
};

const canonicalLocalUrl = (value: string) => {
  const url = new URL(value);
  url.hostname = '127.0.0.1';
  return url.origin;
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

  async get(operator: AuthenticatedUser, profileId?: string | null) {
    if (
      profileId !== undefined &&
      profileId !== null &&
      (typeof profileId !== 'string' || !uuidPattern.test(profileId))
    )
      throw new BadRequestException('连接配置编号无效');
    const base = await this.repository.find(operator.id);
    const selected = profileId ?? object(base?.browserOptions ?? {}).selectedConnectionProfileId;
    const row =
      profileId === null || !selected
        ? base
        : await this.repository.effective(operator.id, profileId);
    return {
      ...this.response(row),
      connectionProfiles: await this.repository.listProfiles(operator.id)
    };
  }

  async getServerProxySettings(
    operator: AuthenticatedUser
  ): Promise<V2RechargeServerProxySettings> {
    const row = await this.repository.find(operator.id);
    const proxyId = serverDefaultProxyId(row?.browserOptions);
    const proxy = proxyId ? await this.proxies.find(proxyId) : null;
    return {
      proxyId,
      proxy:
        proxy && proxy.countryCode && proxy.kind
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
          if (!proxy || !proxy.active || !proxy.countryCode || !proxy.kind)
            throw new BadRequestException('请选择代理 IP 管理中的启用代理');
        }
        const before = await this.repository.findInTransaction(tx, operator.id);
        await this.repository.upsert(tx, operator.id, {
          browserOptions: toV2JsonDocument({
            ...storedBrowserOptions(before?.browserOptions),
            ...accountCopyMetadata(before?.browserOptions),
            ...(object(before?.browserOptions ?? {}).selectedConnectionProfileId
              ? {
                  selectedConnectionProfileId: object(before?.browserOptions ?? {})
                    .selectedConnectionProfileId
                }
              : {}),
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

  async catalogAccess(operator: AuthenticatedUser, value: unknown = {}) {
    const input = bankRechargeObject(value);
    if (
      Object.keys(input).some((key) => !['directMode', 'connectionProfileId'].includes(key)) ||
      (input.directMode !== undefined && typeof input.directMode !== 'boolean')
    )
      throw new BadRequestException('比特浏览器连接模式无效');
    return this.transactions.execute(
      async (tx) => {
        const base = await this.repository.findInTransaction(tx, operator.id);
        const selected =
          input.connectionProfileId === undefined
            ? object(base?.browserOptions ?? {}).selectedConnectionProfileId
            : input.connectionProfileId;
        if (
          selected !== undefined &&
          selected !== null &&
          (typeof selected !== 'string' || !uuidPattern.test(selected))
        )
          throw new BadRequestException('连接配置编号无效');
        const row = selected
          ? await this.repository.effective(operator.id, String(selected), tx)
          : base;
        const localApiToken = this.encryption.decrypt(row?.localApiTokenEncrypted);
        const connectorToken = input.directMode
          ? ''
          : this.encryption.decrypt(row?.connectorTokenEncrypted);
        if (!row || !localApiToken || (!input.directMode && !connectorToken)) {
          throw new ServiceUnavailableException(
            input.directMode
              ? '请先填写比特接口密钥，再刷新分组与标签'
              : '请先填写比特接口密钥和本机连接密钥，再刷新分组与标签'
          );
        }
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.auto_recharge.bitbrowser_catalog.access',
          objectType: 'recharge_browser_settings',
          objectId: operator.id,
          remark: input.directMode
            ? '使用本机接口凭据直接读取比特浏览器分组与标签'
            : '使用本机连接凭据读取比特浏览器分组与标签'
        });
        return {
          connectorUrl: row.connectorUrl,
          connectorToken: input.directMode ? '' : connectorToken!,
          localApiUrl: row.localApiUrl,
          localApiToken
        };
      },
      { changedScopes: ['audit-logs'], requestId: randomUUID(), operator, retryMode: 'none' }
    );
  }

  async update(value: unknown, operator: AuthenticatedUser) {
    const input = validateRechargeBitBrowserSettings(value);
    const connectionDraft = input.directMode === true && !input.groupName && !input.tagName;
    const row = await this.transactions.execute(
      async (tx) => {
        await this.repository.lock(tx);
        const base = await this.repository.findInTransaction(tx, operator.id);
        const selected =
          input.connectionProfileId === undefined
            ? object(base?.browserOptions ?? {}).selectedConnectionProfileId
            : input.connectionProfileId;
        const effective =
          !input.serverMode && selected
            ? await this.repository.effective(operator.id, String(selected), tx)
            : base;
        if (
          !input.newConnectionProfile &&
          input.expectedUpdatedAt !== undefined &&
          (effective?.updatedAt.toISOString() ?? null) !== input.expectedUpdatedAt
        )
          throw new ConflictException('连接配置已被修改，请重新读取后核对');
        if (base?.connectorTokenEncrypted) {
          const connectorToken = this.encryption.decrypt(base.connectorTokenEncrypted)!;
          const localApiToken = this.encryption.decrypt(base.localApiTokenEncrypted);
          await this.repository.pinLegacyConnections(tx, operator.id, {
            connection_profile_id: null,
            ...(localApiToken
              ? {
                  connection_api_key: hash(
                    canonicalLocalUrl(base.localApiUrl) + '\0' + localApiToken
                  )
                }
              : {}),
            connection_connector_key: hash(
              canonicalLocalUrl(normalizeV2RechargeConnectorUrl(base.connectorUrl)) +
                '\0' +
                connectorToken
            ),
            connection_snapshot_encrypted: this.encryption.encrypt(
              JSON.stringify({ connectorUrl: base.connectorUrl, connectorToken })
            )
          });
        }
        const before =
          input.newConnectionProfile && effective
            ? {
                ...effective,
                localApiTokenEncrypted: null,
                localApiTokenMask: null,
                connectorTokenEncrypted: null,
                connectorTokenMask: null
              }
            : effective;
        let browserOptions = input.browserOptions ?? storedBrowserOptions(before?.browserOptions);
        const proxyId =
          input.proxyId === undefined
            ? serverDefaultProxyId(before?.browserOptions)
            : input.proxyId;
        if (input.proxyId) {
          const proxy = await this.proxies.findInTransaction(tx, input.proxyId);
          if (!proxy || !proxy.active || !proxy.countryCode || !proxy.kind)
            throw new BadRequestException('请选择代理 IP 管理中的启用代理');
          const connection = rechargeProxyConnection(
            this.encryption.decrypt(proxy.urlEncrypted)!,
            proxy.connectionMode,
            proxyProtocol(proxy.protocol)
          );
          if (browserOptions.proxyMode !== connection.mode || input.proxyType !== connection.type)
            throw new BadRequestException('所选代理模式或协议已变化，请刷新代理目录后重新选择');
          browserOptions = {
            ...browserOptions,
            staticHost: connection.mode === 'static' ? connection.host : '',
            staticPort: connection.mode === 'static' ? connection.port : 8080
          };
        }
        const staticProxyCredentialsEncrypted = input.clearStaticProxyCredentials
          ? null
          : input.staticProxyCredentials
            ? this.encryption.encrypt(JSON.stringify(input.staticProxyCredentials))
            : (before?.staticProxyCredentialsEncrypted ?? null);
        const localApiTokenEncrypted = input.localApiToken
          ? this.encryption.encrypt(input.localApiToken)
          : (before?.localApiTokenEncrypted ?? null);
        const connectorTokenEncrypted = input.connectorToken
          ? this.encryption.encrypt(input.connectorToken)
          : (before?.connectorTokenEncrypted ?? null);
        const dynamicProxyUrlEncrypted = input.dynamicProxyUrl
          ? this.encryption.encrypt(input.dynamicProxyUrl)
          : (before?.dynamicProxyUrlEncrypted ?? null);
        if (
          (!input.serverMode &&
            (!localApiTokenEncrypted || (!input.directMode && !connectorTokenEncrypted))) ||
          (!connectionDraft &&
            browserOptions.proxyMode === 'dynamic' &&
            !proxyId &&
            !dynamicProxyUrlEncrypted)
        ) {
          throw new BadRequestException('请填写连接密钥及当前代理模式所需的配置');
        }
        if (input.serverMode && !proxyId && browserOptions.proxyMode === 'dynamic') {
          const extractionUrl = this.encryption.decrypt(dynamicProxyUrlEncrypted);
          if (!extractionUrl || new URL(extractionUrl).protocol !== 'https:')
            throw new BadRequestException('服务器动态 IP 提取链接必须使用 HTTPS');
        }
        const configuration = {
          connectorUrl: input.connectorUrl,
          localApiUrl: input.localApiUrl,
          localApiTokenEncrypted,
          localApiTokenMask: input.localApiToken
            ? maskSecret(input.localApiToken)
            : (before?.localApiTokenMask ?? null),
          connectorTokenEncrypted,
          connectorTokenMask: input.connectorToken
            ? maskSecret(input.connectorToken)
            : (before?.connectorTokenMask ?? null),
          groupName: input.groupName,
          tagName: input.tagName,
          proxyType: input.proxyType,
          browserOptions: toV2JsonDocument({
            ...browserOptions,
            ...accountCopyMetadata(before?.browserOptions),
            serverDefaultProxyId: proxyId
          }),
          staticProxyCredentialsEncrypted,
          dynamicProxyUrlEncrypted,
          dynamicProxyUrlMask: input.dynamicProxyUrl
            ? maskUrl(input.dynamicProxyUrl)
            : (before?.dynamicProxyUrlMask ?? null)
        };
        let updated: Awaited<ReturnType<RechargeSettingsRepository['effective']>>;
        if (!input.serverMode && (input.newConnectionProfile || selected)) {
          const profile = await this.repository.saveProfile(tx, {
            id: input.newConnectionProfile ? randomUUID() : String(selected),
            ownerId: operator.id,
            name:
              input.connectionProfileName ??
              (effective && 'connectionProfileName' in effective
                ? String(effective.connectionProfileName)
                : undefined) ??
              '连接配置',
            configuration: toV2JsonDocument(configuration),
            create: input.newConnectionProfile === true,
            expectedUpdatedAt: input.expectedUpdatedAt
          });
          // Persist only this operator's preferred connection. Keep the original
          // connection's parameters intact so switching back restores its own values.
          await this.repository.upsert(tx, operator.id, {
            browserOptions: toV2JsonDocument({
              ...object(base?.browserOptions ?? {}),
              selectedConnectionProfileId: profile.id
            })
          });
          updated = {
            ...configuration,
            ownerId: operator.id,
            createdAt: profile.createdAt,
            updatedAt: profile.updatedAt,
            connectionProfileId: profile.id,
            connectionProfileName: profile.name
          };
        } else {
          updated = await this.repository.upsert(tx, operator.id, {
            ...configuration,
            updatedAt: new Date(Math.max(Date.now(), (base?.updatedAt?.getTime() ?? 0) + 1)),
            browserOptions: toV2JsonDocument({
              ...object(configuration.browserOptions ?? {}),
              selectedConnectionProfileId: input.serverMode
                ? (object(base?.browserOptions ?? {}).selectedConnectionProfileId ?? null)
                : null
            })
          });
        }
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.auto_recharge.bitbrowser_settings.update',
          objectType: 'recharge_browser_settings',
          objectId: updated?.connectionProfileId ?? operator.id,
          beforeData: before ? toV2JsonDocument(this.auditSnapshot(before)) : undefined,
          afterData: toV2JsonDocument(this.auditSnapshot(updated!)),
          remark: input.serverMode
            ? '更新服务器充值代理设置'
            : input.directMode
              ? '更新比特浏览器网页直连设置'
              : '更新本机比特浏览器自动充值设置'
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
    return {
      ...this.response(row),
      connectionProfiles: await this.repository.listProfiles(operator.id)
    };
  }

  async runtime(
    ownerId: string,
    selectedProxy = false,
    directMode = false,
    profileId?: string | null
  ) {
    const base = await this.repository.find(ownerId);
    const selected =
      profileId === undefined
        ? object(base?.browserOptions ?? {}).selectedConnectionProfileId
        : profileId;
    const row = selected ? await this.repository.effective(ownerId, String(selected)) : base;
    if (row && (!row.groupName?.trim() || !row.tagName?.trim()))
      throw new ServiceUnavailableException(
        '该连接已保存，请先补全当前比特账号的窗口分组和标签并检测连接'
      );
    const localApiToken = this.encryption.decrypt(row?.localApiTokenEncrypted);
    const connectorToken = directMode ? '' : this.encryption.decrypt(row?.connectorTokenEncrypted);
    let browserOptions = storedBrowserOptions(row?.browserOptions);
    const proxyId = serverDefaultProxyId(row?.browserOptions);
    let dynamicProxyUrl =
      !proxyId && !selectedProxy && browserOptions.proxyMode === 'dynamic'
        ? this.encryption.decrypt(row?.dynamicProxyUrlEncrypted)
        : '';
    if (
      !row ||
      !localApiToken ||
      (!directMode && !connectorToken) ||
      (!selectedProxy && !proxyId && browserOptions.proxyMode === 'dynamic' && !dynamicProxyUrl)
    ) {
      throw new ServiceUnavailableException('请先完成比特浏览器设置');
    }
    const credentials =
      !proxyId && !selectedProxy && browserOptions.proxyMode === 'static'
        ? this.encryption.decrypt(row.staticProxyCredentialsEncrypted)
        : '';
    let staticProxyCredentials = credentials
      ? validateStaticCredentials(JSON.parse(credentials))
      : undefined;
    let proxyType = row.proxyType;
    if (!selectedProxy && proxyId) {
      const proxy = await this.proxies.find(proxyId);
      if (!proxy || !proxy.active || !proxy.countryCode || !proxy.kind)
        throw new ServiceUnavailableException('默认代理 IP 已停用或不存在，请重新选择');
      const connection = rechargeProxyConnection(
        this.encryption.decrypt(proxy.urlEncrypted)!,
        proxy.connectionMode,
        proxyProtocol(proxy.protocol)
      );
      proxyType = connection.type;
      dynamicProxyUrl = connection.mode === 'dynamic' ? connection.extractionUrl : '';
      browserOptions = {
        ...browserOptions,
        proxyMode: connection.mode,
        staticHost: connection.mode === 'static' ? connection.host : '',
        staticPort: connection.mode === 'static' ? connection.port : 8080
      };
      staticProxyCredentials =
        connection.mode === 'static' && connection.username
          ? { username: connection.username, password: connection.password }
          : undefined;
    }
    return {
      ...row,
      connectionMetadata: {
        connection_profile_id: selected ?? null,
        connection_profile_name:
          'connectionProfileName' in row ? String(row.connectionProfileName) : '原连接配置',
        connection_api_key: hash(canonicalLocalUrl(row.localApiUrl) + '\0' + localApiToken),
        ...(directMode
          ? {}
          : {
              connection_connector_key: hash(
                canonicalLocalUrl(normalizeV2RechargeConnectorUrl(row.connectorUrl)) +
                  '\0' +
                  connectorToken
              ),
              connection_snapshot_encrypted: this.encryption.encrypt(
                JSON.stringify({
                  connectorUrl: row.connectorUrl,
                  connectorToken
                })
              )
            })
      },
      proxyType,
      browserOptions,
      staticProxyCredentials,
      localApiToken,
      connectorToken: directMode ? '' : connectorToken!,
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

  connectionAccess(snapshot: unknown) {
    if (typeof snapshot !== 'string') throw new ServiceUnavailableException('原任务连接配置未保存');
    const value = object(JSON.parse(this.encryption.decrypt(snapshot)!));
    if (typeof value.connectorUrl !== 'string' || typeof value.connectorToken !== 'string')
      throw new ServiceUnavailableException('原任务连接配置无效');
    return { connectorUrl: value.connectorUrl, connectorToken: value.connectorToken };
  }

  private response(row: Awaited<ReturnType<RechargeSettingsRepository['effective']>>) {
    return {
      connectionProfileId: row && 'connectionProfileId' in row ? row.connectionProfileId : null,
      connectionProfileName:
        row && 'connectionProfileName' in row ? row.connectionProfileName : '原连接配置',
      proxyId: serverDefaultProxyId(row?.browserOptions),
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
    connectionProfileId?: string;
    connectionProfileName?: string;
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
      connectionProfileId: row.connectionProfileId ?? null,
      connectionProfileName: row.connectionProfileName ?? '原连接配置',
      proxyId: serverDefaultProxyId(row.browserOptions),
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
