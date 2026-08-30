import { describe, expect, it } from 'vitest';
import {
  auditAccessReasonLabel,
  auditActionLabel,
  auditFieldLabel,
  auditModuleLabel,
  auditRemarkLabel,
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
    ).toBe('订单 / order-1');
  });

  it('maps internal audit values to Chinese presentation labels', () => {
    expect(auditModuleLabel('auth')).toBe('认证与登录');
    expect(auditModuleLabel('unknown_internal_module')).toBe('其他业务模块');
    expect(auditActionLabel('change_password_failed')).toBe('修改密码失败');
    expect(auditActionLabel('id_business_v2.order.update')).toBe('订单 · 更新');
    expect(auditActionLabel('unknown.action_value')).toBe('其他业务操作');
    expect(auditFieldLabel('password')).toBe('密码');
    expect(auditFieldLabel('internal_secret')).toBe('受保护字段');
  });

  it('translates known English notes and hides uncontrolled English-only values', () => {
    expect(auditRemarkLabel('User logged in', 'login')).toBe('用户登录成功');
    expect(auditRemarkLabel('Unknown internal message', 'employee.update')).toBe(
      '已记录“更新员工账户”'
    );
    expect(auditRemarkLabel('人工核对完成', 'employee.update')).toBe('人工核对完成');
    expect(auditAccessReasonLabel('customer verification')).toBe('已登记访问原因');
    expect(auditAccessReasonLabel('客户核对')).toBe('客户核对');
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
