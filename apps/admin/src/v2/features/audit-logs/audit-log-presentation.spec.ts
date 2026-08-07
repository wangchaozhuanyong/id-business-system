import { describe, expect, it } from 'vitest';
import {
  auditUserLabel,
  buildOperationAuditRestoreRouteQuery,
  formatAuditJson,
  getOperationAuditRestoreCandidate,
  operationObjectLabel
} from './audit-log-presentation';

describe('audit log presentation', () => {
  it('renders an explicit system actor when a user no longer exists', () => {
    expect(auditUserLabel(null)).toBe('系统或未知员工');
    expect(auditUserLabel({ id: 'user-1', username: 'operator01', displayName: '运营一号' })).toBe(
      'operator01'
    );
  });

  it('formats structured details without inventing missing values', () => {
    expect(formatAuditJson({ status: 'completed' })).toBe('{\n  "status": "completed"\n}');
    expect(formatAuditJson(null)).toBe('—');
  });

  it('keeps object type and immutable object id together', () => {
    expect(
      operationObjectLabel({
        id: 'audit-1',
        module: 'orders',
        action: 'update',
        objectType: 'order',
        objectId: 'order-1',
        createdAt: '2026-07-30T00:00:00.000Z'
      })
    ).toBe('order / order-1');
  });

  it('only exposes restore entry points for supported soft-delete audit rows', () => {
    const deleteRow = {
      id: 'audit-delete-1',
      module: 'id_business_v2_customers',
      action: 'id_business_v2.customer.delete',
      objectType: 'id_business_v2_customer',
      objectId: 'customer-1',
      remark: '删除 V2 客户：测试客户',
      createdAt: '2026-08-07T00:00:00.000Z',
      user: { id: 'user-1', username: 'operator01', displayName: '运营一号' }
    };

    expect(getOperationAuditRestoreCandidate(deleteRow)).toEqual({
      entity: 'customer',
      id: 'customer-1',
      label: '删除 V2 客户：测试客户'
    });
    expect(buildOperationAuditRestoreRouteQuery(deleteRow)).toMatchObject({
      tab: 'recycle',
      restoreEntity: 'customer',
      restoreId: 'customer-1',
      sourceAuditId: 'audit-delete-1',
      sourceAuditOperator: 'operator01'
    });
    expect(
      getOperationAuditRestoreCandidate({
        ...deleteRow,
        action: 'id_business_v2.customer.update'
      })
    ).toBeNull();
    expect(
      getOperationAuditRestoreCandidate({
        ...deleteRow,
        objectType: 'id_business_v2_order'
      })
    ).toBeNull();
  });
});
