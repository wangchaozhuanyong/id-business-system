import { describe, expect, it } from 'vitest';
import {
  buildAuditRestoreReason,
  createRecycleItemFromAuditRestoreRequest,
  readAuditRestoreRouteRequest,
  readGovernanceTab,
  routeRestoreRequestKey
} from './data-governance-route';

describe('data governance route helpers', () => {
  it('reads supported governance tabs and falls back to the overview', () => {
    expect(readGovernanceTab('recycle')).toBe('recycle');
    expect(readGovernanceTab('jobs')).toBe('jobs');
    expect(readGovernanceTab('unsupported')).toBe('overview');
    expect(readGovernanceTab(['recycle', 'jobs'])).toBe('recycle');
  });

  it('accepts audit restore route evidence only for recycle-bin entities', () => {
    const request = readAuditRestoreRouteRequest({
      restoreEntity: 'order',
      restoreId: 'order-1',
      restoreLabel: '软删除 V2 订单：O-1001',
      sourceAuditId: 'audit-1',
      sourceAuditAction: 'id_business_v2.order.delete',
      sourceAuditAt: '2026-08-07T00:00:00.000Z',
      sourceAuditOperator: 'operator01'
    });

    expect(request).toEqual({
      entity: 'order',
      id: 'order-1',
      label: '软删除 V2 订单：O-1001',
      sourceAuditId: 'audit-1',
      sourceAuditAction: 'id_business_v2.order.delete',
      sourceAuditAt: '2026-08-07T00:00:00.000Z',
      sourceAuditOperator: 'operator01'
    });
    expect(routeRestoreRequestKey(request!)).toBe('order:order-1:audit-1');
    expect(
      readAuditRestoreRouteRequest({ restoreEntity: 'gift_card', restoreId: 'card-1' })
    ).toBeNull();
    expect(readAuditRestoreRouteRequest({ restoreEntity: 'order' })).toBeNull();
  });

  it('builds a restore draft that preserves audit evidence without inventing backup evidence', () => {
    const request = readAuditRestoreRouteRequest({
      restoreEntity: 'account',
      restoreId: 'account-1',
      restoreLabel: '删除 V2 ID：ap***@example.com',
      sourceAuditId: 'audit-2',
      sourceAuditAction: 'id_business_v2.account.delete',
      sourceAuditAt: '2026-08-07T00:00:00.000Z',
      sourceAuditOperator: 'operator02'
    })!;
    const item = createRecycleItemFromAuditRestoreRequest(request);
    const reason = buildAuditRestoreReason(request, item);

    expect(item).toMatchObject({
      id: 'account-1',
      entity: 'account',
      label: '删除 V2 ID：ap***@example.com',
      restoreReadiness: 'review_required'
    });
    expect(reason).toContain('操作审计 audit-2');
    expect(reason).toContain('id_business_v2.account.delete');
    expect(reason).toContain('ID 资料 删除 V2 ID');
    expect(reason).toContain('operator02');
  });
});
