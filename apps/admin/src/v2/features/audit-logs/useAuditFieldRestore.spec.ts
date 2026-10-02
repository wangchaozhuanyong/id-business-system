import { effectScope, nextTick, ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { V2AuditLogRecord, V2AuditRestorePreview, V2AuditRestoreResult } from './contracts';

const mocks = vi.hoisted(() => ({
  query: {} as Record<string, unknown>,
  restore: vi.fn(),
  success: vi.fn()
}));
vi.mock('@/auth/sessionCoordinator', () => ({
  sessionCoordinator: {
    identityEpoch: { value: 0 },
    subscribeIdentityChange: () => {}
  }
}));
vi.mock('@/api/client', () => ({ getApiErrorMessage: (error: Error) => error.message }));
vi.mock('@/v2/services/elementPlusMessage', () => ({ ElMessage: { success: mocks.success } }));
vi.mock('@/v2/composables/useV2Query', () => ({
  createV2QueryKey: (value: unknown) => JSON.stringify(value),
  useV2ModuleQuery: () => mocks.query
}));
vi.mock('./api', () => ({ v2AuditLogsApi: { restoreFields: mocks.restore } }));
import { clearV2SessionDrafts } from '@/v2/composables/useV2SessionDraft';
import { useAuditFieldRestore } from './useAuditFieldRestore';

const source: V2AuditLogRecord = {
  id: 'audit-a',
  action: 'id_business_v2.customer.update',
  module: 'id_business_v2_customers',
  createdAt: '2026-10-02T01:00:00Z'
};
const preview: V2AuditRestorePreview = {
  auditId: source.id,
  objectId: 'customer',
  objectLabel: '客户',
  canRestore: true,
  blockers: [],
  previewFingerprint: 'a'.repeat(64),
  fields: [
    { key: 'name', label: '客户名称', currentValue: '新名称', restoreValue: '旧名称' },
    { key: 'remark', label: '备注', currentValue: '新备注', restoreValue: null }
  ]
};
let data = ref<V2AuditRestorePreview>();
beforeEach(() => {
  clearV2SessionDrafts();
  vi.clearAllMocks();
  data = ref();
  mocks.query = {
    data,
    phase: ref('ready'),
    error: ref(),
    isInitialLoading: ref(false),
    isRefreshing: ref(false),
    isParameterTransition: ref(false),
    refresh: vi.fn().mockResolvedValue(undefined)
  };
});
async function open() {
  const scope = effectScope();
  const recovery = scope.run(() => useAuditFieldRestore(vi.fn().mockResolvedValue(undefined)))!;
  recovery.open(source);
  data.value = preview;
  await nextTick();
  return { scope, recovery };
}

describe('ordinary restoration drafts and confirmations', () => {
  it('selects only eligible fields and rejects attempts to select the conflicting name', async () => {
    const { scope, recovery } = await open();
    recovery.open({ ...source, id: 'conflicting-option' });
    data.value = {
      ...preview,
      auditId: 'conflicting-option',
      fields: preview.fields.map((field) => ({
        ...field,
        ...(field.key === 'name' ? { blockedReason: '原名称已被占用' } : {})
      }))
    };
    await nextTick();
    expect(recovery.form.fields).toEqual(['remark']);
    recovery.selectField('name', true);
    expect(recovery.form.fields).toEqual(['remark']);
    recovery.form.reason = '只恢复备注';
    expect(recovery.disabledReason.value).toBe('');
    mocks.restore.mockResolvedValue({ message: '已恢复' });
    await recovery.submit();
    expect(mocks.restore).toHaveBeenCalledWith(
      'conflicting-option',
      expect.objectContaining({ fields: ['remark'] })
    );
    scope.stop();
  });
  it('retains the selection and reason on reopening and after page destruction', async () => {
    const { scope, recovery } = await open();
    recovery.selectField('remark', false);
    recovery.form.reason = '只纠正名称';
    recovery.visible.value = false;
    scope.stop();
    const nextScope = effectScope();
    const next = nextScope.run(() => useAuditFieldRestore(vi.fn().mockResolvedValue(undefined)))!;
    next.open(source);
    await nextTick();
    expect(next.form.fields).toEqual(['name']);
    expect(next.form.reason).toBe('只纠正名称');
    nextScope.stop();
  });
  it('keeps drafts separate for different operation records', async () => {
    const { scope, recovery } = await open();
    recovery.form.reason = '第一条';
    recovery.open({ ...source, id: 'audit-b' });
    recovery.form.reason = '第二条';
    recovery.open(source);
    expect(recovery.form.reason).toBe('第一条');
    scope.stop();
  });
  it('does not replace the original preview when a later response has a newer version', async () => {
    const { scope, recovery } = await open();
    recovery.form.reason = '原资料核对';
    data.value = { ...preview, previewFingerprint: 'b'.repeat(64) };
    await nextTick();
    expect(recovery.disabledReason.value).toContain('资料已变化');
    await recovery.submit();
    expect(mocks.restore).not.toHaveBeenCalled();
    scope.stop();
  });
  it('preserves user input after a failed save and allows retry', async () => {
    const { scope, recovery } = await open();
    recovery.form.reason = '按原资料更正';
    mocks.restore.mockRejectedValue(new Error('合成写入失败'));
    await recovery.submit();
    expect(recovery.submitError.value).toBe('合成写入失败');
    expect(recovery.form.reason).toBe('按原资料更正');
    expect(recovery.visible.value).toBe(true);
    expect(recovery.submitting.value).toBe(false);
    scope.stop();
  });
  it('clears only the submitted snapshot and never clears later input', async () => {
    const { scope, recovery } = await open();
    recovery.form.reason = '已提交';
    let resolve!: (value: V2AuditRestoreResult) => void;
    mocks.restore.mockImplementation(
      () =>
        new Promise<V2AuditRestoreResult>((done) => {
          resolve = done;
        })
    );
    const save = recovery.submit();
    recovery.form.reason = '响应返回前补充的内容';
    resolve({
      auditId: 'new',
      sourceAuditId: source.id,
      objectId: 'customer',
      restoredFields: ['name', 'remark'],
      message: '恢复成功'
    });
    await save;
    recovery.open(source);
    expect(recovery.form.reason).toBe('响应返回前补充的内容');
    scope.stop();
  });
});
