import { describe, expect, it } from 'vitest';
import { buildAuditRestorePreview, getAuditRestoreConfig } from './audit-field-restore-preview';
import type { AuditRestoreSource, AuditRestoreState } from './audit-field-restore.types';

const version = new Date('2026-10-02T01:00:00.000Z');
const source: AuditRestoreSource = {
  id: 'audit',
  action: 'id_business_v2.customer.update',
  objectType: 'id_business_v2_customer',
  objectId: 'customer',
  beforeData: { id: 'customer', name: '旧名称', remark: null },
  afterData: { id: 'customer', name: '新名称', remark: '新备注', updatedAt: version.toISOString() }
};
const current: AuditRestoreState = {
  id: 'customer',
  name: '新名称',
  remark: '新备注',
  updatedAt: version,
  deletedAt: null
};
const preview = (log = source, state: AuditRestoreState | null = current) =>
  buildAuditRestorePreview(log, getAuditRestoreConfig(log), state, 'admin');

describe('ordinary field restore preview', () => {
  it('preserves null as a recorded old value and offers only the supported fields', () => {
    expect(preview()).toMatchObject({
      canRestore: true,
      fields: [
        { key: 'name', restoreValue: '旧名称', currentValue: '新名称' },
        { key: 'remark', restoreValue: null, currentValue: '新备注' }
      ]
    });
  });
  it.each(['id_business_v2.order.update', 'employee.update', 'id_business_v2.finance.update'])(
    'rejects unsupported operation %s',
    (action) => {
      expect(() => getAuditRestoreConfig({ ...source, action })).toThrow(/不支持/);
    }
  );
  it('rejects a mismatched object type', () => {
    expect(() =>
      getAuditRestoreConfig({ ...source, objectType: 'id_business_v2_account' })
    ).toThrow();
  });
  it('never invents missing old values', () => {
    expect(preview({ ...source, beforeData: {} })).toMatchObject({ canRestore: false, fields: [] });
  });
  it('requires a trustworthy source version', () => {
    expect(
      preview({ ...source, afterData: { name: '新名称', remark: '新备注' } }).blockers.join(' ')
    ).toContain('缺少有效');
  });
  it('blocks a later edit even when the field has been edited back to the same value', () => {
    expect(
      preview(source, { ...current, updatedAt: new Date(version.getTime() + 1) }).canRestore
    ).toBe(false);
  });
  it('blocks deleted or missing records', () => {
    expect(preview(source, null).canRestore).toBe(false);
    expect(preview(source, { ...current, deletedAt: version }).canRestore).toBe(false);
  });
  it('blocks frozen accounts and system options', () => {
    expect(preview(source, { ...current, lossReportedAt: version }).canRestore).toBe(false);
    expect(preview(source, { ...current, isSystem: true }).canRestore).toBe(false);
  });
  it('blocks inconsistent content or source identifiers', () => {
    expect(preview(source, { ...current, name: '后来修改' }).canRestore).toBe(false);
    expect(preview({ ...source, beforeData: { id: 'other', name: '旧名称' } }).canRestore).toBe(
      false
    );
  });
  it('binds the preview to the administrator, source and current version', () => {
    const first = preview().previewFingerprint;
    expect(
      buildAuditRestorePreview(source, getAuditRestoreConfig(source), current, 'other')
        .previewFingerprint
    ).not.toBe(first);
    expect(preview({ ...source, id: 'other' }).previewFingerprint).not.toBe(first);
  });
  it('blocks confirmation when every field is unavailable and binds field availability to the preview', () => {
    const config = getAuditRestoreConfig(source);
    const partiallyBlocked = buildAuditRestorePreview(source, config, current, 'admin', [], {
      name: '名称冲突'
    });
    expect(partiallyBlocked.canRestore).toBe(true);
    expect(partiallyBlocked.previewFingerprint).not.toBe(preview().previewFingerprint);
    const allBlocked = buildAuditRestorePreview(source, config, current, 'admin', [], {
      name: '名称冲突',
      remark: '备注不可恢复'
    });
    expect(allBlocked.canRestore).toBe(false);
    expect(allBlocked.blockers).toEqual(['名称冲突', '备注不可恢复']);
    expect(allBlocked.previewFingerprint).not.toBe(partiallyBlocked.previewFingerprint);
  });
  it('never offers financial or sensitive fields from a mixed ID modification', () => {
    const log = {
      ...source,
      action: 'id_business_v2.account.update',
      objectType: 'id_business_v2_account',
      beforeData: { remark: '旧备注', currentBalance: '1.0000', password: '[REDACTED]' },
      afterData: {
        remark: '新备注',
        currentBalance: '2.0000',
        password: '[REDACTED]',
        updatedAt: version.toISOString()
      }
    };
    expect(preview(log, { ...current, name: undefined }).fields.map((field) => field.key)).toEqual([
      'remark'
    ]);
  });
});
