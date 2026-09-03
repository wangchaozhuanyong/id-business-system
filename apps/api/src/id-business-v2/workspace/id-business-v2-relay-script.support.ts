import type { IdBusinessV2RelayJob } from '@prisma/client';
import { V2_RELAY_JOB_STEPS, type V2RelayJob, type V2RelayJobStep } from '@apple-business/shared';

export interface IdBusinessV2RelayProgress {
  grantedRoles?: string[];
  projectOperation?: string;
  projectNumber?: string;
  serviceAccountEmail?: string;
  serviceOperation?: string;
  testedModels?: string[];
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
  return {
    accountLabel: row.accountLabel,
    cloudBridgeAccountId: row.cloudBridgeAccountId,
    completedSteps,
    createdAt: row.createdAt.toISOString(),
    currentStep:
      row.status === 'completed'
        ? null
        : (V2_RELAY_JOB_STEPS.find((step) => !completedSteps.includes(step)) ?? null),
    id: row.id,
    lastErrorMessage: row.lastErrorMessage,
    projectDisplayName: row.projectDisplayName,
    projectId: row.projectId,
    status: row.status,
    updatedAt: row.updatedAt.toISOString()
  };
}
