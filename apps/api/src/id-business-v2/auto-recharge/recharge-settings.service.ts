import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  toV2JsonDocument
} from '../runtime/public-api';
import { RechargeSettingsRepository } from './persistence/recharge-settings.repository';
import { validateRechargeBitBrowserSettings } from './recharge-settings-validation';

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

@Injectable()
export class RechargeSettingsService {
  constructor(
    private readonly repository: RechargeSettingsRepository,
    private readonly encryption: FieldEncryptionService,
    private readonly transactions: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService
  ) {}

  async get(operator: AuthenticatedUser) {
    return this.response(await this.repository.find(operator.id));
  }

  async update(value: unknown, operator: AuthenticatedUser) {
    const input = validateRechargeBitBrowserSettings(value);
    const row = await this.transactions.execute(
      async (tx) => {
        const before = await this.repository.findInTransaction(tx, operator.id);
        const localApiTokenEncrypted = input.localApiToken
          ? this.encryption.encrypt(input.localApiToken)
          : before?.localApiTokenEncrypted;
        const connectorTokenEncrypted = input.connectorToken
          ? this.encryption.encrypt(input.connectorToken)
          : before?.connectorTokenEncrypted;
        const dynamicProxyUrlEncrypted = input.dynamicProxyUrl
          ? this.encryption.encrypt(input.dynamicProxyUrl)
          : before?.dynamicProxyUrlEncrypted;
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
          remark: '更新本机比特浏览器自动充值设置'
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

  async runtime(ownerId: string) {
    const row = await this.repository.find(ownerId);
    const localApiToken = this.encryption.decrypt(row?.localApiTokenEncrypted);
    const connectorToken = this.encryption.decrypt(row?.connectorTokenEncrypted);
    const dynamicProxyUrl = this.encryption.decrypt(row?.dynamicProxyUrlEncrypted);
    if (!row || !localApiToken || !connectorToken || !dynamicProxyUrl) {
      throw new ServiceUnavailableException('请先完成比特浏览器设置');
    }
    return { ...row, localApiToken, connectorToken, dynamicProxyUrl };
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
  }) {
    return {
      connectorUrl: row.connectorUrl,
      localApiUrl: row.localApiUrl,
      localApiTokenMask: row.localApiTokenMask,
      connectorTokenMask: row.connectorTokenMask,
      groupName: row.groupName,
      tagName: row.tagName,
      proxyType: row.proxyType,
      dynamicProxyUrlMask: row.dynamicProxyUrlMask
    };
  }
}
