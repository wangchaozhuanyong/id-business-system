export type V2GovernanceRecycleEntity = 'account' | 'customer' | 'option' | 'order';
export type V2GovernanceJobType = 'recycle_restore' | 'exchange_rate_cleanup';
export type V2GovernanceJobStatus =
  | 'pending_approval'
  | 'approved'
  | 'running'
  | 'succeeded'
  | 'partially_succeeded'
  | 'failed'
  | 'rejected'
  | 'cancelled';
export type V2GovernanceItemStatus = 'pending' | 'processing' | 'succeeded' | 'skipped' | 'failed';

export interface V2GovernanceUser {
  id: string;
  username: string;
  displayName: string;
}

export interface V2GovernanceOverview {
  approvalReadiness: {
    activeAdminCount: number;
    eligibleApproverCount: number;
    ready: boolean;
    blockedReason: string | null;
  };
  recycleBin: {
    total: number;
    byEntity: Record<V2GovernanceRecycleEntity, number>;
    recentItems: Array<{
      id: string;
      entity: V2GovernanceRecycleEntity;
      label: string;
      deletedAt: string;
    }>;
  };
  capabilities: Array<{
    key: string;
    title: string;
    status: 'available' | 'blocked' | 'unknown';
    detail: string;
  }>;
  existingRetention: {
    scope: 'exchange_rate_history_only';
    configured: boolean;
    lastAuditedRunAt: string | null;
    evidenceStatus: 'observed' | 'not_observed';
  };
  safety: {
    restoreEnabled: boolean;
    cleanupEnabled: boolean;
    generalHardDeleteEnabled: false;
    approvalWorkflowConfigured: boolean;
  };
  proposedWorkflow: string[];
  generatedAt: string;
  timezone: 'Asia/Kuala_Lumpur';
}

export interface V2GovernanceRecycleItem {
  id: string;
  entity: V2GovernanceRecycleEntity;
  label: string;
  deletedAt: string;
  restoreReadiness: 'review_required';
}

export interface V2GovernanceRecycleList {
  items: V2GovernanceRecycleItem[];
  total: number;
  page: number;
  pageSize: number;
  byEntity: Record<V2GovernanceRecycleEntity, number>;
}

export interface V2GovernanceApproval {
  id: string;
  decision: 'approved' | 'rejected';
  reason: string;
  previewHash: string;
  decidedAt: string;
  approver: V2GovernanceUser;
}

export interface V2GovernanceJob {
  id: string;
  jobNo: string;
  type: V2GovernanceJobType;
  status: V2GovernanceJobStatus;
  reason: string;
  backupEvidence: string;
  previewHash: string;
  previewSummary: Record<string, unknown>;
  requestedByUserId: string;
  executedByUserId: string | null;
  totalItems: number;
  succeededItems: number;
  skippedItems: number;
  failedItems: number;
  approvedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  requestedBy: V2GovernanceUser;
  executedBy: V2GovernanceUser | null;
  approval: V2GovernanceApproval | null;
}

export interface V2GovernanceJobItem {
  id: string;
  sequence: number;
  entityType: V2GovernanceRecycleEntity | 'exchange_rate_run';
  entityId: string;
  safeLabel: string;
  sourceDeletedAt: string | null;
  eligibility: Record<string, unknown>;
  status: V2GovernanceItemStatus;
  resultCode: string | null;
  resultMessage: string | null;
  resultAuditLogId: string | null;
  processedAt: string | null;
}

export interface V2GovernanceCheckpoint {
  id: string;
  batchNo: number;
  status: 'running' | 'completed' | 'failed';
  cursorSequence: number;
  attemptedItems: number;
  succeededItems: number;
  skippedItems: number;
  failedItems: number;
  errorCode: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface V2GovernanceJobDetail extends V2GovernanceJob {
  items: V2GovernanceJobItem[];
  checkpoints: V2GovernanceCheckpoint[];
}

export interface V2GovernanceJobList {
  items: V2GovernanceJob[];
  total: number;
  page: number;
  pageSize: number;
}

export interface V2GovernanceRecycleQuery {
  page: number;
  pageSize: number;
  entity?: V2GovernanceRecycleEntity;
}

export interface V2GovernanceJobQuery {
  page: number;
  pageSize: number;
  type?: V2GovernanceJobType;
  status?: V2GovernanceJobStatus;
}

export interface V2GovernanceRestorePreviewInput {
  items: Array<{ entity: V2GovernanceRecycleEntity; id: string }>;
  reason: string;
  backupEvidence: string;
  idempotencyKey: string;
}

export interface V2GovernanceCleanupPreviewInput {
  olderThanDays: number;
  reason: string;
  backupEvidence: string;
  idempotencyKey: string;
}

export interface V2GovernanceExecutionResult {
  idempotentReplay: boolean;
  checkpoint: V2GovernanceCheckpoint;
  job: V2GovernanceJobDetail;
}
