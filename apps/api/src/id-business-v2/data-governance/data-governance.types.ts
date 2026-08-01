import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/auth.types';

export type GovernanceJobType = 'recycle_restore' | 'exchange_rate_cleanup';
export type GovernanceJobStatus =
  | 'pending_approval'
  | 'approved'
  | 'running'
  | 'succeeded'
  | 'partially_succeeded'
  | 'failed'
  | 'rejected'
  | 'cancelled';
export type GovernanceEntityType =
  'account' | 'customer' | 'option' | 'order' | 'exchange_rate_run';
export type GovernanceApprovalDecision = 'approved' | 'rejected';
export type RecycleEntity = Extract<
  GovernanceEntityType,
  'account' | 'customer' | 'option' | 'order'
>;

export interface RestorePreviewItemInput {
  entity: RecycleEntity | string;
  id: string;
}

export interface CreateRestoreGovernanceJobDto {
  items?: RestorePreviewItemInput[];
  reason?: string;
  backupEvidence?: string;
  idempotencyKey?: string;
}

export interface CreateCleanupGovernanceJobDto {
  olderThanDays?: number | string;
  reason?: string;
  backupEvidence?: string;
  idempotencyKey?: string;
}

export interface DecideGovernanceJobDto {
  decision?: GovernanceApprovalDecision | string;
  reason?: string;
}

export interface ExecuteGovernanceJobDto {
  batchSize?: number | string;
  idempotencyKey?: string;
}

export interface GovernanceEligibility {
  eligible: boolean;
  code: string;
  detail: string;
  originalUniqueKey?: string;
  expectedStatus?: string;
  cutoff?: string;
  snapshotId?: string | null;
}

export interface GovernancePreviewItem {
  sequence: number;
  entityType: GovernanceEntityType;
  entityId: string;
  safeLabel: string;
  sourceDeletedAt: Date | null;
  eligibility: GovernanceEligibility;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{8,160}$/;
const RECYCLE_ENTITIES = new Set<RecycleEntity>(['account', 'customer', 'option', 'order']);
const JOB_TYPES = new Set<GovernanceJobType>(['recycle_restore', 'exchange_rate_cleanup']);
const JOB_STATUSES = new Set<GovernanceJobStatus>([
  'pending_approval',
  'approved',
  'running',
  'succeeded',
  'partially_succeeded',
  'failed',
  'rejected',
  'cancelled'
]);

export function requireOperator(operator?: AuthenticatedUser) {
  if (!operator?.id) throw new UnauthorizedException('登录状态已失效，请重新登录');
  return operator;
}

export function normalizeUuid(value: unknown, label = '记录') {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!UUID_PATTERN.test(normalized)) throw new BadRequestException(`${label} ID 格式无效`);
  return normalized;
}

export function normalizeRequiredText(
  value: unknown,
  label: string,
  options: { min: number; max: number }
) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (normalized.length < options.min || normalized.length > options.max) {
    throw new BadRequestException(`${label}长度必须为 ${options.min}-${options.max} 个字符`);
  }
  return normalized;
}

export function normalizeIdempotencyKey(value: unknown) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!IDEMPOTENCY_PATTERN.test(normalized)) {
    throw new BadRequestException('幂等键必须为 8-160 位字母、数字或 . _ : -');
  }
  return normalized;
}

export function parseInteger(
  value: unknown,
  label: string,
  fallback: number,
  min: number,
  max: number
) {
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new BadRequestException(`${label}必须为 ${min}-${max} 的整数`);
  }
  return parsed;
}

export function parseRecycleEntity(value: unknown, optional = false): RecycleEntity | undefined {
  if ((value === undefined || value === '') && optional) return undefined;
  if (typeof value !== 'string' || !RECYCLE_ENTITIES.has(value as RecycleEntity)) {
    throw new BadRequestException('回收站类型无效');
  }
  return value as RecycleEntity;
}

export function parseJobType(value: unknown): GovernanceJobType | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !JOB_TYPES.has(value as GovernanceJobType)) {
    throw new BadRequestException('治理任务类型无效');
  }
  return value as GovernanceJobType;
}

export function parseJobStatus(value: unknown): GovernanceJobStatus | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !JOB_STATUSES.has(value as GovernanceJobStatus)) {
    throw new BadRequestException('治理任务状态无效');
  }
  return value as GovernanceJobStatus;
}

export function parseDecision(value: unknown): GovernanceApprovalDecision {
  if (value !== 'approved' && value !== 'rejected') {
    throw new BadRequestException('审批决定必须为 approved 或 rejected');
  }
  return value;
}
