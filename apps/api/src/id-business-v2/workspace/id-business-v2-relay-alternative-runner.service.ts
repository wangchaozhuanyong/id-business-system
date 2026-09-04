import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { IdBusinessV2RelayJob } from '@prisma/client';
import type { V2RelayJobStatus, V2RelayJobStep } from '@apple-business/shared';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { IdBusinessV2RelayScriptService } from './id-business-v2-relay-script.service';
import type { IdBusinessV2RelayProgress } from './id-business-v2-relay-script.support';
import type { IdBusinessV2RelayJobUpdate } from './persistence/id-business-v2-relay-script.repository';
import { IdBusinessV2RelayCloudBridgeClient } from './providers/id-business-v2-relay-cloudbridge.client';
import { IdBusinessV2RelayGeminiClient } from './providers/id-business-v2-relay-gemini.client';

interface AlternativeStepResult {
  completed: boolean;
  extra?: IdBusinessV2RelayJobUpdate;
  progress: IdBusinessV2RelayProgress;
  status?: V2RelayJobStatus;
}

@Injectable()
export class IdBusinessV2RelayAlternativeRunnerService {
  constructor(
    private readonly encryption: FieldEncryptionService,
    private readonly relay: IdBusinessV2RelayScriptService,
    private readonly cloudBridge: IdBusinessV2RelayCloudBridgeClient,
    private readonly gemini: IdBusinessV2RelayGeminiClient
  ) {}

  async execute(
    job: IdBusinessV2RelayJob,
    connection: Parameters<IdBusinessV2RelayScriptService['withCloudBridgeSession']>[0],
    step: V2RelayJobStep,
    progress: IdBusinessV2RelayProgress
  ): Promise<AlternativeStepResult> {
    if (job.mode === 'gemini_api') return this.geminiApi(job, connection, step, progress);
    if (job.mode === 'antigravity_subscription')
      return this.subscription(job, connection, step, progress);
    throw new BadRequestException('部署模式不正确');
  }

  private async geminiApi(
    job: IdBusinessV2RelayJob,
    connection: Parameters<IdBusinessV2RelayScriptService['withCloudBridgeSession']>[0],
    step: V2RelayJobStep,
    progress: IdBusinessV2RelayProgress
  ): Promise<AlternativeStepResult> {
    const models = Object.keys(this.mapping(job.modelMapping));
    const apiKey = this.secret(job.modeSecretEncrypted, 'Gemini API Key');
    if (step === 'verify_provider_models') {
      await this.gemini.assertModelsAvailable(apiKey, models);
      return { completed: true, progress };
    }
    if (step === 'test_provider_text') {
      await this.gemini.testText(apiKey, 'gemini-3.7-flash');
      return { completed: true, progress };
    }
    if (step === 'test_provider_tts') {
      await this.gemini.testTts(apiKey, 'gemini-3.1-flash-tts-preview');
      return { completed: true, progress };
    }
    if (step === 'create_cloudbridge_account') {
      const account = await this.relay.withCloudBridgeSession(connection, (accessToken) =>
        this.cloudBridge.createGeminiApiKeyAccount({
          accessToken,
          accountLabel: job.accountLabel,
          apiKey,
          deploymentKey: job.deploymentKey,
          modelMapping: this.mapping(job.modelMapping),
          proxyId: job.proxyId,
          settings: this.record(job.settings)
        })
      );
      const accountId = this.accountId(account.id);
      await this.relay.withCloudBridgeSession(connection, (accessToken) =>
        this.cloudBridge.setSchedulable(accountId, false, accessToken)
      );
      return { completed: true, extra: { cloudBridgeAccountId: accountId }, progress };
    }
    if (step === 'test_models') return this.testNextModel(job, connection, progress);
    if (step === 'attach_group') {
      await this.attach(
        job,
        connection,
        this.positiveNumber(this.record(job.settings).priority, 99)
      );
      return {
        completed: true,
        extra: { modeSecretEncrypted: null, status: 'completed' },
        progress,
        status: 'completed'
      };
    }
    throw new BadRequestException('当前步骤不属于 AI Studio API Key 模式');
  }

  private async subscription(
    job: IdBusinessV2RelayJob,
    connection: Parameters<IdBusinessV2RelayScriptService['withCloudBridgeSession']>[0],
    step: V2RelayJobStep,
    progress: IdBusinessV2RelayProgress
  ): Promise<AlternativeStepResult> {
    if (step === 'authorize_account') {
      return { completed: false, progress, status: 'action_required' };
    }
    if (!job.cloudBridgeAccountId) throw new Error('任务缺少中转站订阅账号');
    if (step === 'set_privacy') {
      const value = await this.relay.withCloudBridgeSession(connection, (accessToken) =>
        this.cloudBridge.setAntigravityPrivacy(job.cloudBridgeAccountId as number, accessToken)
      );
      if (this.record(value.extra).privacy_mode !== 'privacy_set')
        throw new Error('Antigravity 隐私设置未生效');
      return { completed: true, progress };
    }
    if (step === 'sync_models') {
      const catalog = await this.relay.withCloudBridgeSession(connection, (accessToken) =>
        this.cloudBridge.syncAntigravityModels(job.cloudBridgeAccountId as number, accessToken)
      );
      const availableModels = Array.isArray(catalog.models)
        ? catalog.models.filter((model): model is string => typeof model === 'string')
        : [];
      const mapping = this.mapping(job.modelMapping);
      const missing = Object.entries(mapping)
        .filter(([, target]) => !availableModels.includes(target))
        .map(([model]) => model);
      if (missing.length) throw new Error(`参考映射中的模型当前不可用：${missing.join('、')}`);
      if (mapping['gemini-3.7-flash'] !== 'gemini-3.7-flash-high')
        throw new Error('实时目录缺少 gemini-3.7-flash-high 必需映射');
      return { completed: true, progress: { ...progress, availableModels } };
    }
    if (step === 'configure_models') {
      await this.relay.withCloudBridgeSession(connection, (accessToken) =>
        this.cloudBridge.configureAntigravityAccount(
          job.cloudBridgeAccountId as number,
          this.mapping(job.modelMapping),
          this.record(job.settings),
          accessToken
        )
      );
      return { completed: true, progress };
    }
    if (step === 'test_models') return this.testNextModel(job, connection, progress);
    if (step === 'attach_group') {
      const priority = this.positiveNumber(this.record(job.settings).priority, 1);
      await this.attach(job, connection, priority);
      return { completed: true, extra: { status: 'completed' }, progress, status: 'completed' };
    }
    throw new BadRequestException('当前步骤不属于 Gemini 订阅号模式');
  }

  private async testNextModel(
    job: IdBusinessV2RelayJob,
    connection: Parameters<IdBusinessV2RelayScriptService['withCloudBridgeSession']>[0],
    progress: IdBusinessV2RelayProgress
  ): Promise<AlternativeStepResult> {
    if (!job.cloudBridgeAccountId) throw new Error('任务缺少中转站账号');
    const models = Object.keys(this.mapping(job.modelMapping));
    const testedModels = Array.from(new Set(progress.testedModels ?? [])).filter((model) =>
      models.includes(model)
    );
    const model = models.find((candidate) => !testedModels.includes(candidate));
    if (!model) return { completed: true, progress: { ...progress, testedModels } };
    if (!this.isImageModel(model)) {
      await this.relay.withCloudBridgeSession(connection, (accessToken) =>
        this.cloudBridge.testAccount(job.cloudBridgeAccountId as number, model, accessToken)
      );
    }
    const nextProgress = { ...progress, testedModels: [...testedModels, model] };
    return {
      completed: nextProgress.testedModels.length === models.length,
      progress: nextProgress
    };
  }

  private attach(
    job: IdBusinessV2RelayJob,
    connection: Parameters<IdBusinessV2RelayScriptService['withCloudBridgeSession']>[0],
    priority: number
  ) {
    if (!job.cloudBridgeAccountId) throw new Error('任务缺少中转站账号');
    return this.relay.withCloudBridgeSession(connection, (accessToken) =>
      this.cloudBridge.attachGroup(
        job.cloudBridgeAccountId as number,
        job.targetGroupId,
        accessToken,
        priority
      )
    );
  }

  private mapping(value: unknown): Record<string, string> {
    const source = this.record(value);
    const mapping = Object.fromEntries(
      Object.entries(source)
        .map(([model, target]) => [model, String(target ?? '')])
        .filter(([model, target]) => model.startsWith('gemini-') && target.startsWith('gemini-'))
    );
    if (!Object.keys(mapping).length) throw new Error('任务缺少模型映射');
    return mapping;
  }

  private secret(value: string | null, field: string) {
    if (!value) throw new Error(`任务缺少${field}`);
    try {
      const decrypted = this.encryption.decrypt(value);
      if (!decrypted) throw new Error('empty');
      return decrypted;
    } catch {
      throw new ServiceUnavailableException(`${field}暂时无法解密`);
    }
  }

  private accountId(value: unknown) {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) throw new Error('中转站没有返回账号 ID');
    return id;
  }

  private record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private positiveNumber(value: unknown, fallback: number) {
    const normalized = Number(value);
    return Number.isFinite(normalized) && normalized > 0 ? normalized : fallback;
  }

  private isImageModel(model: string) {
    const normalized = model.toLowerCase();
    return normalized.includes('image') || normalized.includes('imagen');
  }
}
