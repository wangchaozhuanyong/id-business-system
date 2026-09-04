import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  StartV2RelaySubscriptionAuthorizationResult,
  V2RelayJob
} from '@apple-business/shared';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  toV2JsonDocument
} from '../runtime/public-api';
import type { CompleteIdBusinessV2RelaySubscriptionAuthorizationDto } from './dto/id-business-v2-relay-script.dto';
import { IdBusinessV2RelayScriptService } from './id-business-v2-relay-script.service';
import {
  idBusinessV2RelayCompletedSteps,
  toIdBusinessV2RelayJob
} from './id-business-v2-relay-script.support';
import { IdBusinessV2RelayScriptRepository } from './persistence/id-business-v2-relay-script.repository';
import type { IdBusinessV2RelayJsonInput } from './persistence/id-business-v2-relay-script.repository';
import { IdBusinessV2RelayCloudBridgeClient } from './providers/id-business-v2-relay-cloudbridge.client';

const AUTHORIZATION_TTL_MS = 15 * 60 * 1000;
const JOB_LEASE_MS = 3 * 60 * 1000;

interface PendingAuthorization {
  expiresAt: string;
  sessionId: string;
  stateHash: string;
  state: string;
}

@Injectable()
export class IdBusinessV2RelaySubscriptionAuthService {
  constructor(
    private readonly repository: IdBusinessV2RelayScriptRepository,
    private readonly transactionManager: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService,
    private readonly encryption: FieldEncryptionService,
    private readonly relay: IdBusinessV2RelayScriptService,
    private readonly cloudBridge: IdBusinessV2RelayCloudBridgeClient
  ) {}

  async start(
    jobId: string,
    operator?: AuthenticatedUser,
    requestId = 'workspace-relay-subscription-auth-start'
  ): Promise<StartV2RelaySubscriptionAuthorizationResult> {
    const userId = this.requireAdmin(operator);
    const job = await this.requireSubscriptionJob(jobId, userId);
    if (job.status === 'completed') throw new BadRequestException('该订阅号部署已完成');
    const connection = await this.relay.requireCloudBridgeConnection(userId);
    const value = await this.relay.withCloudBridgeSession(connection, (accessToken) =>
      this.cloudBridge.generateAntigravityAuthUrl(job.proxyId, accessToken)
    );
    const authorizationUrl = this.authorizationUrl(value.auth_url);
    const sessionId = this.string(value.session_id, '中转站没有返回授权会话', 4096);
    const state = this.string(value.state, '中转站没有返回授权状态', 4096);
    const expiresAt = new Date(Date.now() + AUTHORIZATION_TTL_MS);
    const stateHash = this.encryption.hash(state);
    if (!stateHash) throw new ServiceUnavailableException('订阅号授权状态加密失败');
    const pending: PendingAuthorization = {
      expiresAt: expiresAt.toISOString(),
      sessionId,
      state,
      stateHash
    };
    const encrypted = this.encryption.encrypt(JSON.stringify(pending));
    if (!encrypted) throw new ServiceUnavailableException('订阅号授权状态加密失败');
    await this.transactionManager.execute(
      async (tx) => {
        await this.repository.updateJob(
          job.id,
          {
            lastErrorCode: null,
            lastErrorMessage: null,
            modeSecretEncrypted: encrypted,
            status: 'action_required'
          },
          tx
        );
        await this.audit.append(tx, {
          userId,
          module: 'id_business_v2',
          action: 'id_business_v2.workspace_relay.subscription_authorization_start',
          objectType: 'id_business_v2_relay_job',
          objectId: job.id,
          afterData: toV2JsonDocument({ deploymentKey: job.deploymentKey, expiresAt }),
          remark: `已启动订阅号授权：${job.deploymentKey}`
        });
      },
      { changedScopes: ['workspace'], operator, requestId, retryMode: 'none' }
    );
    return { authorizationUrl, expiresAt: expiresAt.toISOString() };
  }

  async complete(
    jobId: string,
    dto: CompleteIdBusinessV2RelaySubscriptionAuthorizationDto,
    operator?: AuthenticatedUser,
    requestId = 'workspace-relay-subscription-auth-complete'
  ): Promise<V2RelayJob> {
    const userId = this.requireAdmin(operator);
    const initialJob = await this.requireSubscriptionJob(jobId, userId);
    const leaseId = randomUUID();
    const now = new Date();
    const acquired = await this.repository.acquireJobLease(
      initialJob.id,
      userId,
      leaseId,
      now,
      new Date(now.getTime() + JOB_LEASE_MS)
    );
    if (!acquired) throw new ConflictException('该部署任务正在执行，请勿重复提交');
    try {
      const job = await this.requireSubscriptionJob(jobId, userId);
      if (!job.modeSecretEncrypted) throw new BadRequestException('请先启动订阅号授权');
      const pending = this.pending(job.modeSecretEncrypted);
      if (new Date(pending.expiresAt).getTime() <= Date.now())
        throw new BadRequestException('订阅号授权已过期，请重新启动');
      const callback = this.callback(dto.callbackUrl);
      if (callback.searchParams.get('error')) throw new BadRequestException('用户未完成订阅号授权');
      const state = this.string(callback.searchParams.get('state'), '授权回调缺少 state', 4096);
      const code = this.string(callback.searchParams.get('code'), '授权回调缺少 code', 4096);
      if (this.encryption.hash(state) !== pending.stateHash || state !== pending.state)
        throw new BadRequestException('订阅号授权状态不匹配，请重新授权');
      const connection = await this.relay.requireCloudBridgeConnection(userId);
      const tokenInfo = await this.relay.withCloudBridgeSession(connection, (accessToken) =>
        this.cloudBridge.exchangeAntigravityCode(
          { code, proxyId: job.proxyId, sessionId: pending.sessionId, state },
          accessToken
        )
      );
      const authorizedEmail = String(tokenInfo.email || '')
        .trim()
        .toLowerCase();
      if (!job.googleEmail || authorizedEmail !== job.googleEmail.toLowerCase())
        throw new BadRequestException('授权的 Google 账号与部署任务不一致');
      const account = await this.relay.withCloudBridgeSession(connection, (accessToken) =>
        this.cloudBridge.createAntigravityAccount({
          accessToken,
          accountLabel: job.accountLabel,
          deploymentKey: job.deploymentKey,
          googleEmail: job.googleEmail as string,
          modelMapping: this.mapping(job.modelMapping),
          proxyId: job.proxyId,
          settings: this.record(job.settings),
          targetGroupId: job.targetGroupId,
          tokenInfo
        })
      );
      const accountId = Number(account.id);
      if (!Number.isInteger(accountId) || accountId <= 0)
        throw new ServiceUnavailableException('中转站没有返回账号 ID');
      return await this.transactionManager.execute(
        async (tx) => {
          const completedSteps = Array.from(
            new Set([...idBusinessV2RelayCompletedSteps(job.completedSteps), 'authorize_account'])
          );
          const updated = await this.repository.updateJob(
            job.id,
            {
              cloudBridgeAccountId: accountId,
              completedSteps: completedSteps as IdBusinessV2RelayJsonInput,
              lastErrorCode: null,
              lastErrorMessage: null,
              modeSecretEncrypted: null,
              status: 'running'
            },
            tx
          );
          await this.audit.append(tx, {
            userId,
            module: 'id_business_v2',
            action: 'id_business_v2.workspace_relay.subscription_authorization_complete',
            objectType: 'id_business_v2_relay_job',
            objectId: job.id,
            afterData: toV2JsonDocument({ accountId, deploymentKey: job.deploymentKey }),
            remark: `已完成订阅号授权：${job.deploymentKey}`
          });
          return toIdBusinessV2RelayJob(updated);
        },
        { changedScopes: ['workspace'], operator, requestId, retryMode: 'none' }
      );
    } finally {
      await this.repository.releaseJobLease(jobId, leaseId);
    }
  }

  private async requireSubscriptionJob(id: string, userId: string) {
    const job = await this.repository.findJobByIdAndUser(id, userId);
    if (!job) throw new NotFoundException('中转脚本任务不存在');
    if (job.mode !== 'antigravity_subscription')
      throw new BadRequestException('该任务不是 Gemini 订阅号模式');
    return job;
  }

  private pending(value: string): PendingAuthorization {
    try {
      const result = JSON.parse(this.encryption.decrypt(value) || '') as PendingAuthorization;
      if (!result.expiresAt || !result.sessionId || !result.state || !result.stateHash)
        throw new Error('invalid');
      return result;
    } catch {
      throw new ServiceUnavailableException('订阅号授权状态无法解密');
    }
  }

  private callback(value: unknown) {
    const raw = this.string(value, '请粘贴完整的授权回调地址', 8192);
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new BadRequestException('授权回调地址格式不正确');
    }
    if (
      url.protocol !== 'http:' ||
      !['localhost', '127.0.0.1'].includes(url.hostname) ||
      url.pathname !== '/callback'
    )
      throw new BadRequestException('请粘贴 Google 返回的 localhost 授权回调地址');
    return url;
  }

  private authorizationUrl(value: unknown) {
    const raw = this.string(value, '中转站没有返回授权地址', 4096);
    try {
      const url = new URL(raw);
      if (url.protocol !== 'https:' || url.hostname !== 'accounts.google.com') throw new Error();
      return url.toString();
    } catch {
      throw new ServiceUnavailableException('中转站返回了不可信的 Google 授权地址');
    }
  }

  private mapping(value: unknown) {
    const source = this.record(value);
    const mapping = Object.fromEntries(
      Object.entries(source)
        .map(([model, target]) => [model, String(target ?? '')])
        .filter(([model, target]) => model.startsWith('gemini-') && target.startsWith('gemini-'))
    );
    if (!Object.keys(mapping).length) throw new BadRequestException('任务缺少模型映射');
    return mapping;
  }

  private record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private string(value: unknown, message: string, max: number) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max)
      throw new BadRequestException(message);
    return value.trim();
  }

  private requireAdmin(operator?: AuthenticatedUser) {
    if (!operator?.id) throw new BadRequestException('无法识别当前操作人');
    if (!operator.roles.includes('admin'))
      throw new ForbiddenException('只有管理员可以使用中转脚本');
    return operator.id;
  }
}
