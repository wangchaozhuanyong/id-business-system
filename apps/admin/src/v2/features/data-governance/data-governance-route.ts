import type { V2GovernanceRecycleEntity, V2GovernanceRecycleItem } from './contracts';
import { recycleEntityLabels } from './data-governance-presentation';

export type V2GovernanceTab = 'overview' | 'recycle' | 'jobs';

export interface V2AuditRestoreRouteRequest {
  entity: V2GovernanceRecycleEntity;
  id: string;
  label: string;
  sourceAuditId: string;
  sourceAuditAction: string;
  sourceAuditAt: string;
  sourceAuditOperator: string;
}

const GOVERNANCE_TABS: readonly V2GovernanceTab[] = ['overview', 'recycle', 'jobs'];
const RESTORE_ENTITIES: readonly V2GovernanceRecycleEntity[] = [
  'account',
  'customer',
  'option',
  'order'
];

function readQueryString(value: unknown, maxLength: number) {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (typeof candidate !== 'string') return '';
  return candidate.trim().slice(0, maxLength);
}

export function readGovernanceTab(value: unknown): V2GovernanceTab {
  const tab = readQueryString(value, 32);
  return GOVERNANCE_TABS.includes(tab as V2GovernanceTab) ? (tab as V2GovernanceTab) : 'overview';
}

export function readAuditRestoreRouteRequest(
  query: Record<string, unknown>
): V2AuditRestoreRouteRequest | null {
  const entity = readQueryString(query.restoreEntity, 32);
  const id = readQueryString(query.restoreId, 80);
  if (!RESTORE_ENTITIES.includes(entity as V2GovernanceRecycleEntity) || !id) return null;
  return {
    entity: entity as V2GovernanceRecycleEntity,
    id,
    label: readQueryString(query.restoreLabel, 160) || id,
    sourceAuditId: readQueryString(query.sourceAuditId, 80),
    sourceAuditAction: readQueryString(query.sourceAuditAction, 160),
    sourceAuditAt: readQueryString(query.sourceAuditAt, 64),
    sourceAuditOperator: readQueryString(query.sourceAuditOperator, 120)
  };
}

export function routeRestoreRequestKey(request: V2AuditRestoreRouteRequest) {
  return `${request.entity}:${request.id}:${request.sourceAuditId}`;
}

export function createRecycleItemFromAuditRestoreRequest(
  request: V2AuditRestoreRouteRequest
): V2GovernanceRecycleItem {
  return {
    id: request.id,
    entity: request.entity,
    label: request.label || request.id,
    deletedAt: request.sourceAuditAt,
    restoreReadiness: 'review_required'
  };
}

export function buildAuditRestoreReason(
  request: V2AuditRestoreRouteRequest,
  item: Pick<V2GovernanceRecycleItem, 'label'>
) {
  const parts = [
    request.sourceAuditId
      ? `从操作审计 ${request.sourceAuditId} 发起恢复。`
      : '从操作审计发起恢复。',
    request.sourceAuditAction ? `原动作：${request.sourceAuditAction}。` : '',
    `目标：${recycleEntityLabels[request.entity]} ${item.label || request.id}（${request.id}）。`,
    request.sourceAuditAt ? `原操作时间：${request.sourceAuditAt}。` : '',
    request.sourceAuditOperator ? `原操作人：${request.sourceAuditOperator}。` : '',
    '请补充误删原因、核对结果和恢复目的。'
  ];
  return parts.filter(Boolean).join('\n').slice(0, 1_000);
}
