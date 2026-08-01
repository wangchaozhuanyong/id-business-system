import { describe, expect, it } from 'vitest';
import { auditUserLabel, formatAuditJson, operationObjectLabel } from './audit-log-presentation';

describe('audit log presentation', () => {
  it('renders an explicit system actor when a user no longer exists', () => {
    expect(auditUserLabel(null)).toBe('系统或未知员工');
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
    ).toBe('order / order-1');
  });
});
