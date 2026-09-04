import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException
} from '@nestjs/common';
import type { IdBusinessV2RelayDeploymentMode } from '@prisma/client';
import type { V2RelayJob } from '@apple-business/shared';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  toV2JsonDocument
} from '../runtime/public-api';
import type { CreateIdBusinessV2RelayJobDto } from './dto/id-business-v2-relay-script.dto';
import { IdBusinessV2RelayScriptService } from './id-business-v2-relay-script.service';
import { toIdBusinessV2RelayJob } from './id-business-v2-relay-script.support';
import { IdBusinessV2RelayScriptRepository } from './persistence/id-business-v2-relay-script.repository';
import { IdBusinessV2RelayCloudBridgeClient } from './providers/id-business-v2-relay-cloudbridge.client';
import { IdBusinessV2RelayGoogleCloudClient } from './providers/id-business-v2-relay-google-cloud.client';

const MODES = ['antigravity_subscription', 'gemini_api', 'vertex'] as const;
const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const DEPLOYMENT_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{2,79}$/;
const BILLING_ACCOUNT_PATTERN = /^billingAccounts\/[A-Z0-9-]{6,60}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GEMINI_API_MODELS = ['gemini-3.7-flash', 'gemini-3.1-flash-tts-preview'] as const;

type SubscriptionReference = Awaited<
  ReturnType<IdBusinessV2RelayCloudBridgeClient['listSubscriptionReferences']>
>[number];

@Injectable()
export class IdBusinessV2RelayJobCreationService {
  constructor(
    private readonly repository: IdBusinessV2RelayScriptRepository,
    private readonly transactionManager: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService,
    private readonly encryption: FieldEncryptionService,
    private readonly relay: IdBusinessV2RelayScriptService,
    private readonly cloudBridge: IdBusinessV2RelayCloudBridgeClient,
    private readonly googleCloud: IdBusinessV2RelayGoogleCloudClient
  ) {}

  async createJob(
    dto: CreateIdBusinessV2RelayJobDto,
    operator?: AuthenticatedUser,
    requestId = 'workspace-relay-job-create'
  ): Promise<V2RelayJob> {
    const userId = this.requireAdmin(operator);
    const mode = this.mode(dto.mode);
    const accountLabel = this.string(dto.accountLabel, '请输入账号标记', 80);
    const deploymentKey = this.string(dto.deploymentKey, '请输入部署任务标识', 80).toLowerCase();
    if (!DEPLOYMENT_KEY_PATTERN.test(deploymentKey))
      throw new BadRequestException('部署任务标识只能使用小写字母、数字、短横线或下划线');
    const targetGroupId = this.positiveInteger(dto.targetGroupId, '请选择目标分组');
    const proxyId = this.optionalPositiveInteger(dto.proxyId, '代理节点不正确');
    const creditExpiresAt = mode === 'vertex' ? this.optionalDate(dto.creditExpiresAt) : null;
    const connection =
      mode === 'vertex'
        ? await this.relay.requireVertexConnection(userId)
        : await this.relay.requireCloudBridgeConnection(userId);
    if (mode === 'vertex') await this.assertBillingAccount(dto, connection);

    const modeData = await this.relay.withCloudBridgeSession(connection, async (accessToken) => {
      const platform = mode === 'antigravity_subscription' ? 'antigravity' : 'gemini';
      const [groups, proxies] = await Promise.all([
        this.cloudBridge.listGroups(accessToken, platform),
        this.cloudBridge.listProxies(accessToken)
      ]);
      if (!groups.some((group) => Number(group.id) === targetGroupId && group.status === 'active'))
        throw new BadRequestException('目标分组不存在、未启用或平台不匹配');
      if (
        proxyId &&
        !proxies.some((proxy) => Number(proxy.id) === proxyId && proxy.status === 'active')
      )
        throw new BadRequestException('代理节点不存在或未启用');
      if (mode === 'vertex') return this.vertexData(dto, accessToken);
      if (mode === 'antigravity_subscription') return this.subscriptionData(dto, accessToken);
      return this.geminiApiData(dto);
    });

    try {
      const row = await this.transactionManager.execute(
        async (tx) => {
          const created = await this.repository.createJob(tx, {
            accountLabel,
            billingAccount: modeData.billingAccount,
            completedSteps: [],
            creditExpiresAt,
            deploymentKey,
            googleEmail: modeData.googleEmail,
            location: modeData.location,
            mode,
            modeSecretEncrypted: modeData.modeSecretEncrypted,
            modelMapping: modeData.modelMapping,
            progress: {},
            projectDisplayName: modeData.projectDisplayName,
            projectId: modeData.projectId,
            proxyId,
            referenceAccountId: modeData.referenceAccountId,
            settings: modeData.settings,
            status: 'draft',
            targetGroupId,
            userId
          });
          await this.audit.append(tx, {
            userId,
            module: 'id_business_v2',
            action: 'id_business_v2.workspace_relay.job_create',
            objectType: 'id_business_v2_relay_job',
            objectId: created.id,
            afterData: toV2JsonDocument({
              accountLabel,
              deploymentKey,
              mode,
              models: Object.keys(modeData.modelMapping),
              targetGroupId
            }),
            remark: `已创建中转脚本任务：${deploymentKey}`
          });
          return created;
        },
        { changedScopes: ['workspace'], operator, requestId, retryMode: 'none' }
      );
      return toIdBusinessV2RelayJob(row);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002')
        throw new ConflictException('该部署任务标识已经存在');
      throw error;
    }
  }

  private async vertexData(dto: CreateIdBusinessV2RelayJobDto, accessToken: string) {
    const projectId = this.string(dto.projectId, '请输入 Google Project ID', 30).toLowerCase();
    if (!PROJECT_ID_PATTERN.test(projectId))
      throw new BadRequestException('Google Project ID 格式不正确');
    const projectDisplayName = this.string(dto.projectDisplayName, '请输入项目显示名称', 80);
    const billingAccount = this.string(dto.billingAccount, '请选择结算账号', 80);
    if (!BILLING_ACCOUNT_PATTERN.test(billingAccount))
      throw new BadRequestException('结算账号格式不正确');
    const location =
      dto.location === undefined ? 'global' : this.string(dto.location, '请输入 Vertex 区域', 40);
    if (!/^[a-z0-9-]{2,40}$/.test(location)) throw new BadRequestException('Vertex 区域格式不正确');
    const referenceAccountId = this.positiveInteger(
      dto.referenceAccountId,
      '请选择 Vertex 参考账号'
    );
    const references = await this.cloudBridge.listVertexReferences(accessToken);
    const reference = references.find((item) => item.id === referenceAccountId);
    if (!reference) throw new BadRequestException('Vertex 参考账号不存在或没有模型映射');
    return {
      billingAccount,
      googleEmail: null,
      location,
      modeSecretEncrypted: null,
      modelMapping: reference.modelMapping,
      projectDisplayName,
      projectId,
      referenceAccountId,
      settings: this.schedulingSettings(dto, {
        concurrency: reference.concurrency,
        loadFactor: reference.loadFactor,
        priority: 99,
        rateMultiplier: reference.rateMultiplier
      })
    };
  }

  private async subscriptionData(dto: CreateIdBusinessV2RelayJobDto, accessToken: string) {
    const googleEmail = this.string(dto.googleEmail, '请输入 Google 订阅账号', 254).toLowerCase();
    if (!EMAIL_PATTERN.test(googleEmail)) throw new BadRequestException('Google 账号格式不正确');
    const referenceAccountId = this.positiveInteger(dto.referenceAccountId, '请选择订阅号参考账号');
    const reference = (await this.cloudBridge.listSubscriptionReferences(accessToken)).find(
      (item) => item.id === referenceAccountId
    );
    if (!reference) throw new BadRequestException('订阅号参考账号不存在或没有模型映射');
    const modelMapping = this.selectSubscriptionModels(dto.selectedModels, reference);
    return {
      billingAccount: null,
      googleEmail,
      location: null,
      modeSecretEncrypted: null,
      modelMapping,
      projectDisplayName: null,
      projectId: null,
      referenceAccountId,
      settings: this.schedulingSettings(dto, {
        allowOverages: reference.allowOverages,
        concurrency: reference.concurrency,
        loadFactor: reference.loadFactor,
        mixedScheduling: reference.mixedScheduling,
        priority: 1,
        rateMultiplier: reference.rateMultiplier
      })
    };
  }

  private async assertBillingAccount(
    dto: CreateIdBusinessV2RelayJobDto,
    connection: Parameters<IdBusinessV2RelayScriptService['googleAccessToken']>[0]
  ) {
    const billingAccount = this.string(dto.billingAccount, '请选择结算账号', 80);
    if (!BILLING_ACCOUNT_PATTERN.test(billingAccount))
      throw new BadRequestException('结算账号格式不正确');
    const token = await this.relay.googleAccessToken(connection);
    const accounts = await this.googleCloud.listBillingAccounts(token);
    if (!accounts.some((account) => account.name === billingAccount))
      throw new BadRequestException('结算账号不存在或当前不可用');
  }

  private geminiApiData(dto: CreateIdBusinessV2RelayJobDto) {
    const apiKey = this.string(dto.apiKey, '请输入 Gemini API Key', 500);
    const encrypted = this.encryption.encrypt(apiKey);
    if (!encrypted) throw new ServiceUnavailableException('Gemini API Key 加密失败');
    return {
      billingAccount: null,
      googleEmail: null,
      location: null,
      modeSecretEncrypted: encrypted,
      modelMapping: Object.fromEntries(GEMINI_API_MODELS.map((model) => [model, model])),
      projectDisplayName: null,
      projectId: null,
      referenceAccountId: null,
      settings: this.schedulingSettings(dto, {
        concurrency: 1,
        loadFactor: 20,
        priority: 99,
        rateMultiplier: 1
      })
    };
  }

  private selectSubscriptionModels(value: unknown, reference: SubscriptionReference) {
    const selected =
      value === undefined
        ? reference.models
        : Array.isArray(value)
          ? value.filter((model): model is string => typeof model === 'string')
          : [];
    const unique = Array.from(new Set(selected));
    if (!unique.length || unique.some((model) => !reference.models.includes(model)))
      throw new BadRequestException('订阅号模型选择不正确');
    const mapping = Object.fromEntries(
      unique.map((model) => [model, reference.modelMapping[model]]).filter((entry) => entry[1])
    );
    if (mapping['gemini-3.7-flash'] !== 'gemini-3.7-flash-high')
      throw new BadRequestException('参考账号缺少 gemini-3.7-flash 到 high 的必需映射');
    return mapping;
  }

  private mode(value: unknown): IdBusinessV2RelayDeploymentMode {
    if (typeof value !== 'string' || !MODES.includes(value as (typeof MODES)[number]))
      throw new BadRequestException('请选择部署模式');
    return value as IdBusinessV2RelayDeploymentMode;
  }

  private string(value: unknown, message: string, max: number) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max)
      throw new BadRequestException(message);
    return value.trim();
  }

  private positiveInteger(value: unknown, message: string) {
    const result = Number(value);
    if (!Number.isInteger(result) || result <= 0) throw new BadRequestException(message);
    return result;
  }

  private optionalPositiveInteger(value: unknown, message: string) {
    return value === undefined || value === null || value === ''
      ? null
      : this.positiveInteger(value, message);
  }

  private optionalDate(value: unknown) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
      throw new BadRequestException('到期日格式不正确');
    const result = new Date(`${value}T23:59:59.000Z`);
    if (Number.isNaN(result.getTime())) throw new BadRequestException('到期日格式不正确');
    return result;
  }

  private schedulingSettings(
    dto: CreateIdBusinessV2RelayJobDto,
    defaults: {
      allowOverages?: boolean;
      concurrency?: number;
      loadFactor?: number;
      mixedScheduling?: boolean;
      priority?: number;
      rateMultiplier?: number;
    }
  ) {
    return {
      allowOverages: this.boolean(dto.allowOverages, defaults.allowOverages ?? false),
      concurrency: this.number(dto.accountConcurrency, defaults.concurrency ?? 1, true, 1000),
      loadFactor: this.number(dto.accountLoadFactor, defaults.loadFactor ?? 1, false, 10_000),
      mixedScheduling: this.boolean(dto.mixedScheduling, defaults.mixedScheduling ?? false),
      priority: this.number(dto.accountPriority, defaults.priority ?? 1, true, 9999),
      rateMultiplier: this.number(
        dto.accountRateMultiplier,
        defaults.rateMultiplier ?? 1,
        false,
        1000
      )
    };
  }

  private number(value: unknown, fallback: number, integer: boolean, max: number) {
    if (value === undefined || value === null || value === '') return fallback;
    const result = Number(value);
    if (
      !Number.isFinite(result) ||
      result <= 0 ||
      result > max ||
      (integer && !Number.isInteger(result))
    )
      throw new BadRequestException('账号调度参数格式不正确');
    return result;
  }

  private boolean(value: unknown, fallback: boolean) {
    if (value === undefined || value === null) return fallback;
    if (typeof value !== 'boolean') throw new BadRequestException('账号调度开关格式不正确');
    return value;
  }

  private requireAdmin(operator?: AuthenticatedUser) {
    if (!operator?.id) throw new BadRequestException('无法识别当前操作人');
    if (!operator.roles.includes('admin'))
      throw new ForbiddenException('只有管理员可以使用中转脚本');
    return operator.id;
  }
}
