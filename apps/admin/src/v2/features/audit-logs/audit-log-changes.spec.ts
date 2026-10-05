import { describe, expect, it } from 'vitest';
import {
  auditChangeValue,
  operationAuditChanges,
  operationChangeNotice,
  operationRestoreExplanation,
  supportsAuditFieldRestore
} from './audit-log-changes';
import type { V2AuditLogRecord } from './contracts';

const row: V2AuditLogRecord = {
  id: 'audit-1',
  module: 'id_business_v2',
  action: 'id_business_v2.customer.update',
  objectType: 'id_business_v2_customer',
  objectId: 'customer-1',
  createdAt: '2026-10-02T06:30:00.000Z'
};

describe('readable audit changes', () => {
  it.each(['archive', 'unarchive'])(
    'shows %s real snapshots without receipt hashes or fictitious status changes',
    (action) => {
      const archivedAt = '2026-10-05T02:00:00.000Z';
      const changes = operationAuditChanges({
        ...row,
        action: `id_business_v2.order.${action}`,
        objectType: 'id_business_v2_order',
        beforeData: {
          archivedAt: action === 'archive' ? null : archivedAt,
          updatedAt: '2026-10-05T01:00:00.000Z',
          status: 'completed'
        },
        afterData: {
          archivedAt: action === 'archive' ? archivedAt : null,
          updatedAt: '2026-10-05T03:00:00.000Z',
          status: 'completed',
          outcome: { id: 'order-a', archivedAt, idempotentReplay: false },
          archiveCommand: {
            idempotencyKey: 'synthetic-key',
            requestHash: 'synthetic-receipt-hash'
          },
          reason: '整理订单列表',
          dataPreserved: true
        }
      });
      expect(changes.map((change) => change.key)).toEqual([
        'archivedAt',
        'reason',
        'dataPreserved'
      ]);
      expect(changes.find((change) => change.key === 'dataPreserved')).toMatchObject({
        label: '关联账务与资料已保留',
        after: '是'
      });
      expect(JSON.stringify(changes)).not.toMatch(
        /synthetic-receipt-hash|synthetic-key|idempotentReplay|状态/
      );
      expect(
        operationAuditChanges({ ...row, afterData: { outcome: { amount: '25.50' } } })[0].key
      ).toBe('outcome.amount');
    }
  );
  it('shows only recorded changes and keeps money decimal text intact', () => {
    expect(
      operationAuditChanges({
        ...row,
        beforeData: { name: '旧客户', status: 'enabled', amount: '100.0000', updatedAt: 'old' },
        afterData: { name: '新客户', status: 'enabled', amount: '100.1234', updatedAt: 'new' }
      })
    ).toEqual([
      { key: 'name', label: '名称', before: '旧客户', after: '新客户' },
      { key: 'amount', label: '金额', before: '100.0000', after: '100.1234' }
    ]);
  });
  it('compares nested data independently of JSON property order', () => {
    expect(
      operationAuditChanges({
        ...row,
        beforeData: { customer: { name: '张三', id: 'one' } },
        afterData: { customer: { id: 'one', name: '李四' } }
      })
    ).toEqual([{ key: 'customer.name', label: '客户 · 名称', before: '张三', after: '李四' }]);
    expect(
      operationAuditChanges({
        ...row,
        beforeData: { tags: [{ name: '甲', code: 'a' }] },
        afterData: { tags: [{ code: 'a', name: '甲' }] }
      })
    ).toEqual([]);
  });
  it('distinguishes missing historical fields from explicitly empty fields', () => {
    const changes = operationAuditChanges({
      ...row,
      beforeData: { name: '甲' },
      afterData: { name: '乙', remark: null }
    });
    expect(changes[1]).toMatchObject({ label: '备注', before: '未记录', after: '未填写' });
    expect(operationChangeNotice({ ...row, afterData: { name: '乙' } })).toContain(
      '未记录的旧值无法从日志找回'
    );
    expect(operationChangeNotice(row)).toContain('没有保存字段明细');
  });
  it('protects credential values even if an older payload was not redacted', () => {
    const result = operationAuditChanges({
      ...row,
      beforeData: { password: 'old-test', secretEncrypted: 'old-test' },
      afterData: { password: 'new-test', secretEncrypted: 'new-test' }
    });
    expect(result).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain('old-test');
    expect(JSON.stringify(result)).not.toContain('new-test');
    expect(result.every((change) => change.before === '内容已保护，不显示原值')).toBe(true);
    expect(auditChangeValue('[REDACTED]', 'anything')).toBe('内容已保护，不显示原值');
  });
  it('formats the screenshot exchange-rate record in Chinese and local time', () => {
    expect(auditChangeValue('combined_p2p', 'source')).toBe('交易平台综合报价');
    expect(auditChangeValue('2026-10-02T06:30:00.000Z', 'capturedAt')).toBe('2026/10/02 14:30:00');
    expect(auditChangeValue('disabled', 'status')).toBe('停用');
    expect(auditChangeValue(true, 'autoEnabled')).toBe('是');
    expect(auditChangeValue('unrecognized_internal_status', 'status')).toBe('其他状态或类型');
  });
  it('keeps unknown fields without showing database keys and does not invent names', () => {
    expect(operationAuditChanges({ ...row, afterData: { internal_new_key: 3 } })).toEqual([
      { key: 'internal_new_key', label: '其他资料 1', before: '未记录', after: '3' }
    ]);
    expect(auditChangeValue('11111111-1111-4111-8111-111111111111', 'customerId')).toBe(
      '关联记录（尾号 11111111）'
    );
  });
  it('describes safe recovery boundaries for deletes, edits and financial actions', () => {
    expect(
      operationRestoreExplanation({ ...row, action: 'id_business_v2.customer.delete' }, true)
    ).toContain('另一名管理员审批');
    expect(operationRestoreExplanation({ ...row, action: 'employee.delete' }, false)).toContain(
      '不能在这里还原员工登录账号'
    );
    expect(
      operationRestoreExplanation({ ...row, action: 'id_business_v2.quick_action.delete' }, false)
    ).toContain('暂未接入');
    expect(
      operationRestoreExplanation(
        { ...row, action: 'id_business_v2.finance_journal.reverse' },
        false
      )
    ).toContain('金额和账务不能从日志直接还原');
    expect(operationRestoreExplanation(row, false)).toContain('若资料后来被修改');
  });
  it('offers ordinary restoration only for matching supported operation and object types', () => {
    expect(supportsAuditFieldRestore(row)).toBe(true);
    expect(supportsAuditFieldRestore({ ...row, action: 'employee.update' })).toBe(false);
    expect(supportsAuditFieldRestore({ ...row, objectType: 'id_business_v2_account' })).toBe(false);
    expect(supportsAuditFieldRestore({ ...row, objectId: null })).toBe(false);
  });
  it('shows restoration reasons in Chinese without exposing the source database identifier', () => {
    const changes = operationAuditChanges({
      ...row,
      beforeData: { name: '新名称' },
      afterData: {
        name: '旧名称',
        restoredFromAuditId: 'source',
        restoredFieldLabels: ['客户名称'],
        restoreReason: '录入错误'
      }
    });
    expect(changes.map((field) => field.label)).toEqual(['名称', '恢复项目', '恢复原因']);
    expect(JSON.stringify(changes)).not.toContain('restoredFromAuditId');
  });
});
