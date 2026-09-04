import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException
} from '@nestjs/common';
import type { IdBusinessV2RelayJob } from '@prisma/client';
import type { V2RelayJob, V2RelayJobStatus, V2RelayJobStep } from '@apple-business/shared';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { randomUUID } from 'node:crypto';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  toV2JsonDocument
} from '../runtime/public-api';
import { IdBusinessV2RelayScriptService } from './id-business-v2-relay-script.service';
import { IdBusinessV2RelayAlternativeRunnerService } from './id-business-v2-relay-alternative-runner.service';
import {
  type IdBusinessV2RelayProgress,
  idBusinessV2RelayCompletedSteps,
  idBusinessV2RelayJobSteps,
  idBusinessV2RelayModelMapping,
  idBusinessV2RelayProgress,
  idBusinessV2RelayProjectNumber,
  idBusinessV2RelayPositiveNumber,
  idBusinessV2RelaySafeErrorMessage,
  idBusinessV2RelaySettings,
  toIdBusinessV2RelayJob
} from './id-business-v2-relay-script.support';
import {
  IdBusinessV2RelayScriptRepository,
  type IdBusinessV2RelayJobUpdate,
  type IdBusinessV2RelayJsonInput
} from './persistence/id-business-v2-relay-script.repository';
import { IdBusinessV2RelayCloudBridgeClient } from './providers/id-business-v2-relay-cloudbridge.client';
import { IdBusinessV2RelayGoogleCloudClient } from './providers/id-business-v2-relay-google-cloud.client';
import { IdBusinessV2RelayRemoteError } from './providers/id-business-v2-relay-http';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB_LEASE_MS = 3 * 60 * 1000;
@Injectable()
export class IdBusinessV2RelayJobRunnerService {
  constructor(
    private readonly repository: IdBusinessV2RelayScriptRepository,
    private readonly transactionManager: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService,
    private readonly encryption: FieldEncryptionService,
    private readonly relay: IdBusinessV2RelayScriptService,
    private readonly alternativeRunner: IdBusinessV2RelayAlternativeRunnerService,
    private readonly googleCloud: IdBusinessV2RelayGoogleCloudClient,
    private readonly cloudBridge: IdBusinessV2RelayCloudBridgeClient
  ) {}

  async runNextStep(
    jobIdInput: unknown,
    operator?: AuthenticatedUser,
    requestId = 'workspace-relay-job-run'
  ): Promise<V2RelayJob> {
    const userId = this.requireAdmin(operator);
    const jobId = this.normalizeId(jobIdInput);
    let job = await this.repository.findJobByIdAndUser(jobId, userId);
    if (!job) throw new NotFoundException('中转脚本任务不存在');
    if (job.status === 'completed') return toIdBusinessV2RelayJob(job);
    const leaseId = randomUUID();
    const now = new Date();
    const acquired = await this.repository.acquireJobLease(
      job.id,
      userId,
      leaseId,
      now,
      new Date(now.getTime() + JOB_LEASE_MS)
    );
    if (!acquired) throw new ConflictException('该部署任务正在执行，请勿重复提交');
    try {
      job = (await this.repository.findJobByIdAndUser(jobId, userId)) ?? job;
      const connection =
        job.mode === 'vertex'
          ? await this.relay.requireVertexConnection(userId)
          : await this.relay.requireCloudBridgeConnection(userId);
      const completed = idBusinessV2RelayCompletedSteps(job.completedSteps);
      const step = idBusinessV2RelayJobSteps(job.mode).find(
        (candidate) => !completed.includes(candidate)
      );
      if (!step) return this.markCompleted(job, operator, requestId);
      try {
        job = await this.executeStep(job, connection, step, operator, requestId);
        return toIdBusinessV2RelayJob(job);
      } catch (error) {
        const cloudBridgeAccountId = job.cloudBridgeAccountId;
        if (cloudBridgeAccountId) {
          await this.relay
            .withCloudBridgeSession(connection, (token) =>
              this.cloudBridge.setSchedulable(cloudBridgeAccountId, false, token)
            )
            .catch(() => undefined);
        }
        return this.markFailed(job, step, error, operator, requestId);
      }
    } finally {
      await this.repository.releaseJobLease(jobId, leaseId);
    }
  }

  private async executeStep(
    job: IdBusinessV2RelayJob,
    connection: NonNullable<
      Awaited<ReturnType<IdBusinessV2RelayScriptRepository['findConnectionByUser']>>
    >,
    step: V2RelayJobStep,
    operator: AuthenticatedUser | undefined,
    requestId: string
  ) {
    const progress = idBusinessV2RelayProgress(job.progress);
    if (job.mode !== 'vertex') {
      const result = await this.alternativeRunner.execute(job, connection, step, progress);
      if (result.completed) {
        return this.completeStep(job, step, result.progress, operator, requestId, result.extra);
      }
      return this.updateProgress(job, result.progress, operator, requestId, step, result.status);
    }
    if (step === 'create_project') {
      return this.createProject(job, connection, progress, operator, requestId);
    }
    if (step === 'link_billing') {
      await this.googleCloud.linkBilling(
        job.projectId as string,
        job.billingAccount as string,
        await this.relay.googleAccessToken(connection)
      );
      return this.completeStep(job, step, progress, operator, requestId);
    }
    if (step === 'enable_services') {
      return this.enableServices(job, connection, progress, operator, requestId);
    }
    if (step === 'create_service_account') {
      return this.createServiceAccount(job, connection, progress, operator, requestId);
    }
    if (step === 'grant_permissions') {
      return this.grantPermissions(job, connection, progress, operator, requestId);
    }
    if (step === 'create_service_account_key') {
      return this.createServiceAccountKey(job, connection, progress, operator, requestId);
    }
    if (step === 'create_cloudbridge_account') {
      return this.createCloudBridgeAccount(job, connection, progress, operator, requestId);
    }
    if (step === 'test_models') {
      return this.testNextModel(job, connection, progress, operator, requestId);
    }
    return this.attachGroup(job, connection, progress, operator, requestId);
  }

  private async createProject(
    job: IdBusinessV2RelayJob,
    connection: Parameters<IdBusinessV2RelayScriptService['googleAccessToken']>[0],
    progress: IdBusinessV2RelayProgress,
    operator: AuthenticatedUser | undefined,
    requestId: string
  ) {
    const token = await this.relay.googleAccessToken(connection);
    if (progress.projectOperation) {
      const operation = await this.googleCloud.getResourceManagerOperation(
        progress.projectOperation,
        token
      );
      const response = this.googleCloud.assertOperationComplete(operation);
      if (!response)
        return this.updateProgress(job, progress, operator, requestId, 'create_project');
      return this.completeStep(
        job,
        'create_project',
        {
          ...progress,
          projectOperation: undefined,
          projectNumber: idBusinessV2RelayProjectNumber(response)
        },
        operator,
        requestId
      );
    }
    try {
      const operation = await this.googleCloud.createProject(
        job.projectId as string,
        job.projectDisplayName as string,
        token
      );
      if (operation.done) {
        const response = this.googleCloud.assertOperationComplete(operation) ?? {};
        return this.completeStep(
          job,
          'create_project',
          {
            ...progress,
            projectNumber: idBusinessV2RelayProjectNumber(response)
          },
          operator,
          requestId
        );
      }
      if (!operation.name) throw new Error('Google 创建项目没有返回操作标识');
      return this.updateProgress(
        job,
        { ...progress, projectOperation: operation.name },
        operator,
        requestId,
        'create_project'
      );
    } catch (error) {
      if (!(error instanceof IdBusinessV2RelayRemoteError) || error.status !== 409) throw error;
      const existing = await this.googleCloud.getProject(job.projectId as string, token);
      if (existing.state !== 'ACTIVE') {
        throw new Error('同名 Google 项目存在，但当前不是可用状态', { cause: error });
      }
      return this.completeStep(
        job,
        'create_project',
        {
          ...progress,
          projectNumber: idBusinessV2RelayProjectNumber(existing)
        },
        operator,
        requestId
      );
    }
  }

  private async enableServices(
    job: IdBusinessV2RelayJob,
    connection: Parameters<IdBusinessV2RelayScriptService['googleAccessToken']>[0],
    progress: IdBusinessV2RelayProgress,
    operator: AuthenticatedUser | undefined,
    requestId: string
  ) {
    if (!progress.projectNumber) throw new Error('任务缺少 Google Project Number');
    const token = await this.relay.googleAccessToken(connection);
    if (progress.serviceOperation) {
      const operation = await this.googleCloud.getServiceUsageOperation(
        progress.serviceOperation,
        token
      );
      const response = this.googleCloud.assertOperationComplete(operation);
      if (!response)
        return this.updateProgress(job, progress, operator, requestId, 'enable_services');
      return this.completeStep(
        job,
        'enable_services',
        {
          ...progress,
          serviceOperation: undefined
        },
        operator,
        requestId
      );
    }
    const operation = await this.googleCloud.startEnableServices(progress.projectNumber, token);
    if (operation.done) {
      this.googleCloud.assertOperationComplete(operation);
      return this.completeStep(job, 'enable_services', progress, operator, requestId);
    }
    if (!operation.name) throw new Error('Google 启用 API 没有返回操作标识');
    return this.updateProgress(
      job,
      { ...progress, serviceOperation: operation.name },
      operator,
      requestId,
      'enable_services'
    );
  }

  private async createServiceAccount(
    job: IdBusinessV2RelayJob,
    connection: Parameters<IdBusinessV2RelayScriptService['googleAccessToken']>[0],
    progress: IdBusinessV2RelayProgress,
    operator: AuthenticatedUser | undefined,
    requestId: string
  ) {
    const token = await this.relay.googleAccessToken(connection);
    let account: Record<string, unknown>;
    try {
      account = await this.googleCloud.createServiceAccount(job.projectId as string, token);
    } catch (error) {
      if (!(error instanceof IdBusinessV2RelayRemoteError) || error.status !== 409) throw error;
      account = await this.googleCloud.getServiceAccount(job.projectId as string, token);
    }
    const email = typeof account.email === 'string' ? account.email : '';
    if (!email.endsWith(`@${job.projectId}.iam.gserviceaccount.com`)) {
      throw new Error('Google 服务账号邮箱格式无效');
    }
    return this.completeStep(
      job,
      'create_service_account',
      {
        ...progress,
        serviceAccountEmail: email
      },
      operator,
      requestId
    );
  }

  private async grantPermissions(
    job: IdBusinessV2RelayJob,
    connection: Parameters<IdBusinessV2RelayScriptService['googleAccessToken']>[0],
    progress: IdBusinessV2RelayProgress,
    operator: AuthenticatedUser | undefined,
    requestId: string
  ) {
    if (!progress.serviceAccountEmail) throw new Error('任务缺少 Google 服务账号');
    const token = await this.relay.googleAccessToken(connection);
    const member = `serviceAccount:${progress.serviceAccountEmail}`;
    const grantedRoles = Array.from(new Set(progress.grantedRoles ?? []));
    const role = grantedRoles.includes('roles/aiplatform.user')
      ? 'roles/serviceusage.serviceUsageConsumer'
      : 'roles/aiplatform.user';
    await this.googleCloud.grantProjectRole(job.projectId as string, member, role, token);
    const nextProgress = { ...progress, grantedRoles: [...grantedRoles, role] };
    return role === 'roles/serviceusage.serviceUsageConsumer'
      ? this.completeStep(job, 'grant_permissions', nextProgress, operator, requestId)
      : this.updateProgress(job, nextProgress, operator, requestId, 'grant_permissions');
  }

  private async createServiceAccountKey(
    job: IdBusinessV2RelayJob,
    connection: Parameters<IdBusinessV2RelayScriptService['googleAccessToken']>[0],
    progress: IdBusinessV2RelayProgress,
    operator: AuthenticatedUser | undefined,
    requestId: string
  ) {
    if (!progress.serviceAccountEmail) throw new Error('任务缺少 Google 服务账号');
    const value = await this.googleCloud.createServiceAccountKey(
      progress.serviceAccountEmail,
      await this.relay.googleAccessToken(connection)
    );
    const encrypted = this.encryption.encrypt(JSON.stringify(value));
    if (!encrypted) throw new ServiceUnavailableException('Google 服务账号密钥加密失败');
    return this.completeStep(job, 'create_service_account_key', progress, operator, requestId, {
      serviceAccountKeyEncrypted: encrypted
    });
  }

  private async createCloudBridgeAccount(
    job: IdBusinessV2RelayJob,
    connection: Parameters<IdBusinessV2RelayScriptService['withCloudBridgeSession']>[0],
    progress: IdBusinessV2RelayProgress,
    operator: AuthenticatedUser | undefined,
    requestId: string
  ) {
    if (!progress.serviceAccountEmail || !job.serviceAccountKeyEncrypted) {
      throw new Error('任务缺少服务账号密钥');
    }
    const serviceAccount = JSON.parse(
      this.decrypt(job.serviceAccountKeyEncrypted, 'Google 服务账号密钥')
    ) as Record<string, unknown>;
    const account = await this.relay.withCloudBridgeSession(connection, (accessToken) =>
      this.cloudBridge.createVertexAccount({
        accessToken,
        accountLabel: job.accountLabel,
        clientEmail: progress.serviceAccountEmail as string,
        creditExpiresAt: job.creditExpiresAt,
        location: job.location ?? 'global',
        modelMapping: idBusinessV2RelayModelMapping(job.modelMapping),
        projectId: job.projectId as string,
        proxyId: job.proxyId,
        serviceAccountJson: serviceAccount,
        settings: idBusinessV2RelaySettings(job.settings)
      })
    );
    const accountId = Number(account.id);
    if (!Number.isInteger(accountId) || accountId <= 0) throw new Error('中转站没有返回账号 ID');
    return this.completeStep(job, 'create_cloudbridge_account', progress, operator, requestId, {
      cloudBridgeAccountId: accountId
    });
  }

  private async testNextModel(
    job: IdBusinessV2RelayJob,
    connection: Parameters<IdBusinessV2RelayScriptService['withCloudBridgeSession']>[0],
    progress: IdBusinessV2RelayProgress,
    operator: AuthenticatedUser | undefined,
    requestId: string
  ) {
    if (!job.cloudBridgeAccountId) throw new Error('任务缺少中转站账号');
    const models = Object.keys(idBusinessV2RelayModelMapping(job.modelMapping));
    const testedModels = Array.from(new Set(progress.testedModels ?? [])).filter((model) =>
      models.includes(model)
    );
    const model = models.find((candidate) => !testedModels.includes(candidate));
    if (!model)
      return this.completeStep(
        job,
        'test_models',
        { ...progress, testedModels },
        operator,
        requestId
      );
    await this.relay.withCloudBridgeSession(connection, (accessToken) =>
      this.cloudBridge.testAccount(job.cloudBridgeAccountId as number, model, accessToken)
    );
    const nextProgress = { ...progress, testedModels: [...testedModels, model] };
    return nextProgress.testedModels.length === models.length
      ? this.completeStep(job, 'test_models', nextProgress, operator, requestId)
      : this.updateProgress(job, nextProgress, operator, requestId, 'test_models');
  }

  private async attachGroup(
    job: IdBusinessV2RelayJob,
    connection: Parameters<IdBusinessV2RelayScriptService['withCloudBridgeSession']>[0],
    progress: IdBusinessV2RelayProgress,
    operator: AuthenticatedUser | undefined,
    requestId: string
  ) {
    if (!job.cloudBridgeAccountId) throw new Error('任务缺少中转站账号');
    await this.relay.withCloudBridgeSession(connection, (accessToken) =>
      this.cloudBridge.attachGroup(
        job.cloudBridgeAccountId as number,
        job.targetGroupId,
        accessToken,
        idBusinessV2RelayPositiveNumber(idBusinessV2RelaySettings(job.settings).priority, 99)
      )
    );
    return this.completeStep(job, 'attach_group', progress, operator, requestId, {
      serviceAccountKeyEncrypted: null,
      status: 'completed'
    });
  }

  private async markCompleted(
    job: IdBusinessV2RelayJob,
    operator: AuthenticatedUser | undefined,
    requestId: string
  ) {
    const updated = await this.transactionManager.execute(
      async (tx) => {
        const result = await this.repository.updateJob(job.id, { status: 'completed' }, tx);
        await this.appendAudit(result, 'job_complete', null, '中转脚本任务已完成', tx);
        return result;
      },
      { changedScopes: ['workspace'], operator, requestId, retryMode: 'none' }
    );
    return toIdBusinessV2RelayJob(updated);
  }

  private async markFailed(
    job: IdBusinessV2RelayJob,
    step: V2RelayJobStep,
    error: unknown,
    operator: AuthenticatedUser | undefined,
    requestId: string
  ) {
    const code = error instanceof IdBusinessV2RelayRemoteError ? error.code : 'RELAY_STEP_FAILED';
    const message = idBusinessV2RelaySafeErrorMessage(error);
    const failed = await this.transactionManager.execute(
      async (tx) => {
        const updated = await this.repository.updateJob(
          job.id,
          {
            lastErrorCode: code,
            lastErrorMessage: message,
            status: 'failed'
          },
          tx
        );
        await this.appendAudit(updated, 'job_step_failed', step, '中转脚本步骤执行失败', tx, code);
        return updated;
      },
      {
        changedScopes: ['workspace'],
        operator,
        requestId: `${requestId}-${step}-failed`,
        retryMode: 'none'
      }
    );
    return toIdBusinessV2RelayJob(failed);
  }

  private async completeStep(
    job: IdBusinessV2RelayJob,
    step: V2RelayJobStep,
    progress: IdBusinessV2RelayProgress,
    operator: AuthenticatedUser | undefined,
    requestId: string,
    extra: IdBusinessV2RelayJobUpdate = {}
  ) {
    const completedSteps = Array.from(
      new Set([...idBusinessV2RelayCompletedSteps(job.completedSteps), step])
    );
    return this.transactionManager.execute(
      async (tx) => {
        const updated = await this.repository.updateJob(
          job.id,
          {
            ...extra,
            completedSteps: completedSteps as IdBusinessV2RelayJsonInput,
            lastErrorCode: null,
            lastErrorMessage: null,
            progress: progress as IdBusinessV2RelayJsonInput,
            status: extra.status ?? 'running'
          },
          tx
        );
        await this.appendAudit(updated, 'job_step_complete', step, '中转脚本已完成步骤', tx);
        return updated;
      },
      {
        changedScopes: ['workspace'],
        operator,
        requestId: `${requestId}-${step}`,
        retryMode: 'none'
      }
    );
  }

  private updateProgress(
    job: IdBusinessV2RelayJob,
    progress: IdBusinessV2RelayProgress,
    operator: AuthenticatedUser | undefined,
    requestId: string,
    step: V2RelayJobStep,
    status: V2RelayJobStatus = 'running'
  ) {
    return this.transactionManager.execute(
      async (tx) => {
        const updated = await this.repository.updateJob(
          job.id,
          {
            lastErrorCode: null,
            lastErrorMessage: null,
            progress: progress as IdBusinessV2RelayJsonInput,
            status
          },
          tx
        );
        await this.appendAudit(updated, 'job_progress', step, '中转脚本正在执行步骤', tx);
        return updated;
      },
      {
        changedScopes: ['workspace'],
        operator,
        requestId: `${requestId}-${step}-progress`,
        retryMode: 'none'
      }
    );
  }

  private appendAudit(
    job: IdBusinessV2RelayJob,
    action: string,
    step: V2RelayJobStep | null,
    remark: string,
    tx: Parameters<V2TransactionalAuditService['append']>[0],
    code?: string
  ) {
    return this.audit.append(tx, {
      userId: job.userId,
      module: 'id_business_v2',
      action: `id_business_v2.workspace_relay.${action}`,
      objectType: 'id_business_v2_relay_job',
      objectId: job.id,
      afterData: toV2JsonDocument({
        code,
        deploymentKey: job.deploymentKey,
        mode: job.mode,
        status: job.status,
        step
      }),
      remark: step ? `${remark}：${step}` : `${remark}：${job.deploymentKey}`
    });
  }

  private decrypt(value: string, field: string) {
    try {
      const decrypted = this.encryption.decrypt(value);
      if (!decrypted) throw new Error('empty');
      return decrypted;
    } catch {
      throw new ServiceUnavailableException(`${field}暂时无法解密`);
    }
  }

  private requireAdmin(operator?: AuthenticatedUser) {
    if (!operator?.id) throw new BadRequestException('无法识别当前操作人');
    if (!operator.roles.includes('admin'))
      throw new ForbiddenException('只有管理员可以使用中转脚本');
    return operator.id;
  }

  private normalizeId(value: unknown) {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value))
      throw new BadRequestException('任务标识无效');
    return value;
  }
}
