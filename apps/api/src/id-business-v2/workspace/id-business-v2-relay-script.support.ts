import type { IdBusinessV2RelayJob } from '@prisma/client';
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
