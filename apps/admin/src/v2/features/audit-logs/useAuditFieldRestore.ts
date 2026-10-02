import { computed, ref, watch } from 'vue';
import { getApiErrorMessage } from '@/api/client';
import { useV2FormDraft } from '@/v2/composables/useV2SessionDraft';
import { createV2QueryKey, useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { v2AuditLogsApi } from './api';
import type { V2AuditLogRecord, V2AuditRestoreField } from './contracts';

export function useAuditFieldRestore(refreshLogs: () => Promise<unknown>) {
  const visible = ref(false);
  const selected = ref<V2AuditLogRecord | null>(null);
  const submitting = ref(false);
  const submitError = ref('');
  const draft = useV2FormDraft('audit-logs/field-restore', () => ({
    fields: [] as V2AuditRestoreField[],
    reason: ''
  }));
  const previewQuery = useV2ModuleQuery({
    moduleKey: 'audit-logs',
    scope: 'audit-logs',
    trackRouteData: false,
    enabled: () => visible.value && Boolean(selected.value),
    key: () => createV2QueryKey({ operation: 'field-restore-preview', id: selected.value?.id }),
    query: ({ signal }) => v2AuditLogsApi.restorePreview(selected.value!.id, { signal })
  });
  const preview = computed(() =>
    previewQuery.data.value?.auditId === selected.value?.id ? previewQuery.data.value : undefined
  );
  const previewError = computed(() =>
    previewQuery.error.value ? getApiErrorMessage(previewQuery.error.value) : ''
  );
  watch(preview, (value) => {
    if (!value || draft.version.value !== undefined) return;
    draft.version.value = value.previewFingerprint;
    if (!draft.form.fields.length)
      draft.form.fields = value.fields
        .filter((field) => !field.blockedReason)
        .map((field) => field.key);
  });
  const disabledReason = computed(() => {
    if (previewQuery.isInitialLoading.value || previewQuery.isRefreshing.value)
      return '正在核对当前资料';
    if (!preview.value || previewError.value) return '请先完成资料核对';
    if (!preview.value.canRestore) return preview.value.blockers.join(' ');
    if (draft.version.value !== preview.value.previewFingerprint)
      return '资料已变化，请重新核对后到原页面更正';
    if (!draft.form.fields.length) return '请选择需要恢复的项目';
    const blockedField = preview.value.fields.find(
      (field) => draft.form.fields.includes(field.key) && field.blockedReason
    );
    if (blockedField) return blockedField.blockedReason!;
    if (!draft.form.reason.trim()) return '请填写恢复原因';
    return '';
  });
  function open(item: V2AuditLogRecord) {
    if (submitting.value) return false;
    selected.value = item;
    draft.open(item.id);
    submitError.value = '';
    visible.value = true;
    void previewQuery.refresh();
    return true;
  }
  async function submit() {
    const source = selected.value;
    if (!source || submitting.value || disabledReason.value || !draft.version.value) return;
    const input = {
      fields: [...draft.form.fields],
      reason: draft.form.reason.trim(),
      previewFingerprint: draft.version.value
    };
    const clearSubmitted = draft.beginSave();
    submitting.value = true;
    submitError.value = '';
    try {
      const result = await v2AuditLogsApi.restoreFields(source.id, input);
      clearSubmitted();
      if (selected.value?.id === source.id) visible.value = false;
      ElMessage.success(result.message);
      await refreshLogs();
    } catch (error) {
      submitError.value = getApiErrorMessage(error);
      await previewQuery.refresh();
    } finally {
      submitting.value = false;
    }
  }
  function selectField(key: V2AuditRestoreField, selected: boolean) {
    if (
      submitting.value ||
      !preview.value?.canRestore ||
      !preview.value.fields.some(
        (field) => field.key === key && (!selected || !field.blockedReason)
      )
    )
      return;
    if (selected) draft.form.fields = [...new Set([...draft.form.fields, key])];
    else draft.form.fields = draft.form.fields.filter((field) => field !== key);
  }
  return {
    visible,
    selected,
    form: draft.form,
    submitting,
    submitError,
    preview,
    previewError,
    previewPhase: previewQuery.phase,
    previewPreviousData: previewQuery.isParameterTransition,
    dirty: computed(() => JSON.stringify(draft.form) !== draft.original.value),
    disabledReason,
    open,
    submit,
    selectField,
    refreshPreview: previewQuery.refresh
  };
}
