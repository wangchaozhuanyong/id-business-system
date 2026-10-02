import type { V2DataScope } from '@apple-business/shared';
import type { IdBusinessV2OptionType } from '@prisma/client';

export type AuditRestoreEntity = 'customer' | 'account' | 'option';
export type AuditRestoreField = 'name' | 'remark' | 'sortOrder';
export type AuditRestoreValue = string | number | null;

export interface AuditRestoreConfig {
  entity: AuditRestoreEntity;
  objectType: string;
  module: string;
  scope: V2DataScope;
  label: string;
  fields: readonly AuditRestoreField[];
}

export interface AuditRestoreSource {
  id: string;
  action: string;
  objectType: string | null;
  objectId: string | null;
  beforeData: unknown;
  afterData: unknown;
}

export interface AuditRestoreState {
  id: string;
  name?: string;
  appleIdMasked?: string;
  remark: string | null;
  sortOrder?: number;
  updatedAt: Date;
  deletedAt: Date | null;
  lossReportedAt?: Date | null;
  isSystem?: boolean;
  type?: IdBusinessV2OptionType;
  parentId?: string | null;
  countryOptionId?: string | null;
}

export interface AuditRestoreFieldPreview {
  key: AuditRestoreField;
  label: string;
  currentValue: AuditRestoreValue;
  restoreValue: AuditRestoreValue;
  blockedReason?: string;
}

export interface AuditRestorePreview {
  auditId: string;
  objectId: string;
  objectLabel: string;
  canRestore: boolean;
  blockers: string[];
  previewFingerprint: string;
  fields: AuditRestoreFieldPreview[];
}

export interface RestoreAuditFieldsDto {
  previewFingerprint?: string;
  fields?: AuditRestoreField[];
  reason?: string;
}

export type AuditRestorePatch = Partial<Record<AuditRestoreField, AuditRestoreValue>>;
