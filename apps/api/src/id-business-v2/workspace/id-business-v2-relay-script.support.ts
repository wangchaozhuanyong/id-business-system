import type { IdBusinessV2RelayJob } from '@prisma/client';
import { HttpStatus } from '@nestjs/common';
import { ApiHttpException } from '../../common/errors/api-http.exception';
import { IdBusinessV2RelayRemoteError } from './providers/id-business-v2-relay-http';
import {
  V2_RELAY_JOB_STEPS,
  V2_RELAY_JOB_STEPS_BY_MODE,
  type V2RelayDeploymentMode,
  type V2RelayJob,
  type V2RelayJobStep
} from '@apple-business/shared';

export interface IdBusinessV2RelayProgress {
  availableModels?: string[];
  grantedRoles?: string[];
  projectOperation?: string;
  projectNumber?: string;
  serviceAccountEmail?: string;
  serviceOperation?: string;
  testedModels?: string[];
}

export function idBusinessV2RelayOptionsError(error: IdBusinessV2RelayRemoteError) {
  // 中转站会话失效不代表当前 ID 系统会话失效，不能返回本地认证的 401/403。
  if (error.status === 401) {
    return new ApiHttpException(
      HttpStatus.BAD_GATEWAY,
      'RELAY_CLOUDBRIDGE_RECONNECT_REQUIRED',
      '中转站登录已失效，自动续期未成功。请到“连接设置”重新连接中转站管理员账号。',
      { retryable: false }
    );
  }
  if (error.status === 403) {
    return new ApiHttpException(
      HttpStatus.BAD_GATEWAY,
      'RELAY_CLOUDBRIDGE_PERMISSION_DENIED',
      '中转站拒绝访问部署选项。请到“连接设置”重新连接有管理权限的中转站账号。',
      { retryable: false }
    );
  }
  if (error.status === 429) {
    return new ApiHttpException(
      HttpStatus.TOO_MANY_REQUESTS,
      'RELAY_CLOUDBRIDGE_RATE_LIMITED',
      '中转站请求过于频繁，请稍后重新加载部署选项。'
    );
  }
  if (error.code === 'REMOTE_TIMEOUT') {
    return new ApiHttpException(
      HttpStatus.GATEWAY_TIMEOUT,
      'RELAY_CLOUDBRIDGE_TIMEOUT',
      '读取中转站部署选项超时，请稍后重新加载。'
    );
  }
  const retryable =
    error.code === 'REMOTE_UNAVAILABLE' || (error.status !== undefined && error.status >= 500);
  return new ApiHttpException(
    HttpStatus.BAD_GATEWAY,
    'RELAY_CLOUDBRIDGE_OPTIONS_UNAVAILABLE',
    retryable
      ? '暂时无法读取中转站部署选项，请稍后重新加载。'
      : '中转站部署选项接口返回异常，请联系管理员检查中转站接口。',
    { retryable }
  );
}

export function idBusinessV2RelayJobSteps(mode: V2RelayDeploymentMode): V2RelayJobStep[] {
  return [...V2_RELAY_JOB_STEPS_BY_MODE[mode]];
}

export function idBusinessV2RelayProgress(value: unknown): IdBusinessV2RelayProgress {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as IdBusinessV2RelayProgress)
    : {};
}

export function idBusinessV2RelayModelMapping(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('任务缺少模型映射');
  const mapping = Object.fromEntries(
    Object.keys(value)
      .filter((model) => model.startsWith('gemini-'))
      .map((model) => [model, model])
  );
  if (!Object.keys(mapping).length) throw new Error('任务缺少模型映射');
  return mapping;
}

export function idBusinessV2RelayProjectNumber(value: Record<string, unknown>) {
  const number =
    String(value.name ?? '')
      .split('/')
      .pop() ?? '';
  if (!/^\d+$/.test(number)) throw new Error('无法取得 Google Project Number');
  return number;
}

export function idBusinessV2RelaySafeErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : '中转脚本执行失败';
  return message
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[已隐藏]')
    .slice(0, 500);
}

export function idBusinessV2RelaySettings(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function idBusinessV2RelayPositiveNumber(value: unknown, fallback: number) {
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized > 0 ? normalized : fallback;
}

export function idBusinessV2RelayCompletedSteps(value: unknown): V2RelayJobStep[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (step): step is V2RelayJobStep =>
      typeof step === 'string' && V2_RELAY_JOB_STEPS.includes(step as V2RelayJobStep)
  );
}

export function toIdBusinessV2RelayJob(row: IdBusinessV2RelayJob): V2RelayJob {
  const completedSteps = idBusinessV2RelayCompletedSteps(row.completedSteps);
  const steps = idBusinessV2RelayJobSteps(row.mode);
  const mapping =
    row.modelMapping && typeof row.modelMapping === 'object' && !Array.isArray(row.modelMapping)
      ? row.modelMapping
      : {};
  return {
    accountLabel: row.accountLabel,
    cloudBridgeAccountId: row.cloudBridgeAccountId,
    completedSteps,
    createdAt: row.createdAt.toISOString(),
    deploymentKey: row.deploymentKey,
    currentStep:
      row.status === 'completed'
        ? null
        : (steps.find((step) => !completedSteps.includes(step)) ?? null),
    id: row.id,
    lastErrorMessage: row.lastErrorMessage,
    mode: row.mode,
    models: Object.keys(mapping).filter((model) => model.startsWith('gemini-')),
    projectDisplayName: row.projectDisplayName,
    projectId: row.projectId,
    status: row.status,
    totalSteps: steps.length,
    updatedAt: row.updatedAt.toISOString()
  };
}
