export type V2SensitiveAccessMode = 'denied' | 'direct' | 'approval_required' | 'admin_bypass';

export type V2SensitiveAccessRequestStatus = 'pending' | 'approved' | 'rejected';

export interface V2SensitiveAccessContext {
  module: string;
  fieldName: string;
  objectType: string;
  objectId: string;
}

export interface V2SensitiveAccessPolicy extends Omit<V2SensitiveAccessContext, 'objectId'> {
  permissionCode: string;
  label: string;
  mode: V2SensitiveAccessMode;
}

export interface V2SensitiveAccessUserSnapshot {
  id: string;
  username: string;
  displayName: string;
}

export interface V2SensitiveAccessRequest extends V2SensitiveAccessContext {
  id: string;
  requesterId: string;
  requester: V2SensitiveAccessUserSnapshot;
  approverId: string | null;
  approver: V2SensitiveAccessUserSnapshot | null;
  fieldLabel: string;
  permissionCode: string;
  targetLabel: string;
  reason: string;
  status: V2SensitiveAccessRequestStatus;
  decisionNote: string | null;
  approvedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface V2SensitiveAccessRequestList {
  items: V2SensitiveAccessRequest[];
  total: number;
  page: number;
  pageSize: number;
}

export interface V2SensitiveAccessApprovalSummary {
  pendingCount: number;
  items: V2SensitiveAccessRequest[];
  generatedAt: string;
}
