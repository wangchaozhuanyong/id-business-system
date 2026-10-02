import { describe, expect, it, vi } from 'vitest';
import { IdBusinessV2AuditRestoreService } from './id-business-v2-audit-restore.service';

describe('ordinary restoration input and role boundary', () => {
  const repository = { findSource: vi.fn() };
  const service = new IdBusinessV2AuditRestoreService(
    repository as never,
    {} as never,
    {} as never
  );
  const admin = {
    id: 'admin',
    username: 'admin',
    displayName: '管理员',
    roles: ['admin'],
    permissions: []
  };
  it('requires an administrator independently of route guards', async () => {
    await expect(service.preview('audit')).rejects.toThrow(/只有管理员/);
    await expect(service.restore('audit', {}, { ...admin, roles: ['employee'] })).rejects.toThrow(
      /只有管理员/
    );
  });
  it.each([
    { reason: '' },
    { reason: 'x'.repeat(501) },
    { reason: '更正', fields: [] },
    { reason: '更正', fields: ['name', 'name'] },
    { reason: '更正', fields: ['name'], previewFingerprint: 'invalid' }
  ])('rejects incomplete confirmations before accessing data', async (input) => {
    repository.findSource.mockClear();
    await expect(service.restore('audit', input as never, admin)).rejects.toThrow();
    expect(repository.findSource).not.toHaveBeenCalled();
  });
});

describe('field-level option name conflicts', () => {
  it('blocks the name but restores an independently selected remark with audit evidence', async () => {
    const updatedAt = new Date('2026-10-02T01:00:00.000Z');
    const source = {
      id: 'source',
      action: 'id_business_v2.option.update',
      objectType: 'id_business_v2_option',
      objectId: 'option',
      beforeData: { name: '原名称', remark: '原备注' },
      afterData: { name: '新名称', remark: '新备注', updatedAt: updatedAt.toISOString() }
    };
    const current = {
      id: 'option',
      name: '新名称',
      remark: '新备注',
      updatedAt,
      deletedAt: null,
      type: 'customer_tag',
      isSystem: false
    };
    const repository = {
      findSource: vi.fn(async () => source),
      findCurrent: vi.fn(async () => current),
      findOptionNameConflict: vi.fn(async () => ({ id: 'other' })),
      restore: vi.fn(async (_tx, _entity, _current, patch, _actor, nextVersion) => ({
        ...current,
        ...patch,
        updatedAt: nextVersion
      }))
    };
    const audit = {
      append: vi.fn<(...args: unknown[]) => Promise<{ id: string }>>(async () => ({
        id: 'recovery-audit'
      }))
    };
    const transactions = {
      execute: async (callback: (tx: unknown, context: { businessTime: Date }) => unknown) =>
        callback({}, { businessTime: new Date() })
    };
    const service = new IdBusinessV2AuditRestoreService(
      repository as never,
      transactions as never,
      audit as never
    );
    const admin = {
      id: 'admin',
      username: 'admin',
      displayName: '管理员',
      roles: ['admin'],
      permissions: []
    };
    const preview = await service.preview(source.id, admin);
    expect(preview.canRestore).toBe(true);
    expect(preview.fields.find((field) => field.key === 'name')?.blockedReason).toContain(
      '不能恢复名称'
    );
    expect(preview.fields.find((field) => field.key === 'remark')?.blockedReason).toBeUndefined();
    await expect(
      service.restore(
        source.id,
        { fields: ['name'], reason: '只恢复名称', previewFingerprint: preview.previewFingerprint },
        admin
      )
    ).rejects.toThrow('不能恢复名称');
    await service.restore(
      source.id,
      { fields: ['remark'], reason: '只恢复备注', previewFingerprint: preview.previewFingerprint },
      admin
    );
    expect(repository.restore).toHaveBeenCalledWith(
      expect.anything(),
      'option',
      current,
      { remark: '原备注' },
      admin.id,
      expect.any(Date)
    );
    expect(audit.append.mock.calls[0][1]).toMatchObject({
      afterData: {
        name: '新名称',
        remark: '原备注',
        restoredFieldLabels: ['备注'],
        restoredFromAuditId: 'source'
      }
    });
  });
});
