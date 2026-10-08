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
  operationObjectLabel,
  operationAuditChanges
} from './audit-log-presentation';

describe('audit log presentation', () => {
  it('归档与恢复使用独立中文审计名称，不混用删除资料恢复', () => {
    expect(auditActionLabel('id_business_v2.order.archive')).toBe('归档订单');
    expect(auditActionLabel('id_business_v2.order.unarchive')).toBe('恢复归档订单');
    expect(auditFieldLabel('archivedAt')).toBe('归档时间');
    expect(
      getOperationAuditRestoreCandidate({
        id: 'archive-audit',
        module: 'id_business_v2',
        action: 'id_business_v2.order.archive',
        objectType: 'id_business_v2_order',
        objectId: 'synthetic-order',
        createdAt: '2026-10-05T00:00:00Z'
      })
    ).toBeNull();
  });
  it('人工验证与等待确认审计使用明确中文名称', () => {
    expect(auditActionLabel('id_business_v2.auto_recharge.handoff')).toBe('操作原付款验证窗口');
    expect(auditActionLabel('id_business_v2.auto_recharge.server.quote_verified')).toBe(
      '核实报价并等待本人确认'
    );
  });
  it('充值邮箱读码审计使用明确中文操作名', () => {
    expect(auditActionLabel('id_business_v2.auto_recharge.email_code.prepare')).toBe(
      '准备登录邮箱验证'
    );
    expect(auditActionLabel('id_business_v2.auto_recharge.email_code.read')).toBe(
      '读取登录验证邮件'
    );
    expect(auditActionLabel('id_business_v2.auto_recharge.email_code.received')).toBe(
      '确认登录验证邮件已接受'
    );
  });
  it('注册状态修正审计显示中文操作和前后状态', () => {
    const row = {
      id: 'audit-1',
      module: 'id_business_v2',
      action: 'id_business_v2.auto_registration.mark_unregistered',
      objectType: 'registration_mailbox',
      objectId: 'alias-1',
      createdAt: '2026-10-03T08:00:00Z',
      beforeData: { registered: true },
      afterData: { registered: false }
    };
    expect(auditActionLabel(row.action)).toContain('标记未注册');
    expect(operationObjectLabel(row)).toContain('注册邮箱');
    expect(operationAuditChanges(row)).toEqual([
      { key: 'registered', label: '注册状态', before: '已注册', after: '未注册' }
    ]);
  });
  it('renders an explicit system actor when a user no longer exists', () => {
    expect(auditUserLabel(null)).toBe('系统自动执行');
    expect(auditUserLabel({ id: 'user-1', username: 'operator01', displayName: '运营一号' })).toBe(
      '运营一号（operator01）'
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
    ).toBe('订单（记录尾号 order-1）');
  });

  it('maps internal audit values to Chinese presentation labels', () => {
    expect(auditModuleLabel('auth')).toBe('认证与登录');
    expect(auditModuleLabel('unknown_internal_module')).toBe('其他业务模块');
    expect(auditActionLabel('change_password_failed')).toBe('修改密码失败');
    expect(auditActionLabel('auth.password.rehash')).toBe('升级密码保护');
    expect(auditActionLabel('id_business_v2.order.update')).toBe('订单 · 更新');
    expect(auditActionLabel('unknown.action_value')).toBe('其他业务操作');
    expect(auditFieldLabel('password')).toBe('密码');
    expect(auditFieldLabel('internal_secret')).toBe('受保护字段');
  });

  it('注册创建审计展示固定年龄与中文字段名', () => {
    expect(
      operationAuditChanges({
        id: 'age-audit',
        module: 'id_business_v2',
        action: 'id_business_v2.auto_registration.create',
        objectType: 'registration_job',
        objectId: 'synthetic-job',
        createdAt: '2026-10-03T08:00:00Z',
        afterData: { registrationAge: 21 }
      })
    ).toEqual([{ key: 'registrationAge', label: '注册年龄', before: '未记录', after: '21' }]);
  });

  it('退役后历史注册审计仍展示中文阶段及未知阶段的受控文案', () => {
    const row = {
      id: 'historical-registration-audit',
      module: 'id_business_v2',
      action: 'id_business_v2.auto_registration.update',
      objectType: 'registration_job',
      objectId: 'synthetic-job',
      createdAt: '2026-10-03T08:00:00Z',
      beforeData: { step: 'mfa' },
      afterData: { step: 'mfa_verified' }
    };
    expect(operationAuditChanges(row)).toEqual([
      expect.objectContaining({ before: '设置双重验证', after: '双重验证已核实' })
    ]);
    expect(
      operationAuditChanges({ ...row, afterData: { step: 'unexpected_internal_step' } })
    ).toEqual([expect.objectContaining({ after: '阶段待核对' })]);
  });

  it('translates known English notes and hides uncontrolled English-only values', () => {
    expect(auditRemarkLabel('User logged in', 'login')).toBe('用户登录成功');
    expect(
      auditRemarkLabel(
        'Upgraded password hash work factor after authentication',
        'auth.password.rehash'
      )
    ).toBe('登录验证通过，已升级密码保护');
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
      label: '客户 · 测试客户'
    });
    expect(buildOperationAuditRestoreRouteQuery(deleteRow)).toMatchObject({
      tab: 'recycle',
      restoreEntity: 'customer',
      restoreId: 'customer-1',
      sourceAuditId: 'audit-delete-1',
      sourceAuditOperator: '运营一号（operator01）'
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
