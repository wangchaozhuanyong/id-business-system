import { computed, reactive, ref } from 'vue';
import type {
  V2FinanceHistoryBackfillPreview,
  V2FinanceHistoryConfirmationPreview
} from '@apple-business/shared';
import { getApiErrorMessage } from '@/api/client';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { idBusinessV2FinanceApi } from './api';
import { isMeaningfulHistoryStatement } from './financeLedgerPresentation';

export type HistoryDrawerMode = 'confirm' | 'reopen';

export function useFinanceHistory({ refresh }: { refresh: () => Promise<unknown> }) {
  const historyDrawerVisible = ref(false);
  const historyDrawerMode = ref<HistoryDrawerMode>('confirm');
  const historySubmitting = ref(false);
  const historyConfirmationLoading = ref(false);
  const historyConfirmationPreview = ref<V2FinanceHistoryConfirmationPreview | null>(null);
  const historyChecklist = reactive({
    financeAccountsConfirmed: false,
    supplierBalancesConfirmed: false,
    historicalExpensesConfirmed: false
  });
  const historyNote = ref('');
  const historyReopenReason = ref('');
  const historyDrawerDirty = computed(() =>
    historyDrawerMode.value === 'reopen'
      ? Boolean(historyReopenReason.value)
      : Boolean(
          historyNote.value ||
          historyChecklist.financeAccountsConfirmed ||
          historyChecklist.supplierBalancesConfirmed ||
          historyChecklist.historicalExpensesConfirmed
        )
  );
  const historyConfirmationDisabledReason = computed(() => {
    if (historyDrawerMode.value === 'reopen') {
      return isMeaningfulHistoryStatement(historyReopenReason.value)
        ? ''
        : '请填写至少 6 个字符的重新核对原因';
    }
    if (!historyConfirmationPreview.value) return '请先加载历史确认预览';
    if (!historyConfirmationPreview.value.canConfirm) return '当前历史状态不允许确认';
    if (
      !historyChecklist.financeAccountsConfirmed ||
      !historyChecklist.supplierBalancesConfirmed ||
      !historyChecklist.historicalExpensesConfirmed
    ) {
      return '请逐项完成三项历史数据核对';
    }
    return isMeaningfulHistoryStatement(historyNote.value)
      ? ''
      : '请填写至少 6 个字符的实际核对结论';
  });
  const historyPreviewVisible = ref(false);
  const historyPreviewLoading = ref(false);
  const historyPreview = ref<V2FinanceHistoryBackfillPreview | null>(null);
  const historyPreviewConfirmDisabledReason = computed(() => {
    if (!historyPreview.value) return '请先加载回填预览';
    if (!historyPreview.value.canBackfill) return '当前历史状态不允许再次回填';
    return '';
  });

  async function openHistoryBackfillPreview() {
    historyPreviewLoading.value = true;
    try {
      historyPreview.value = await idBusinessV2FinanceApi.previewHistoryBackfill();
      historyPreviewVisible.value = true;
    } catch (cause) {
      ElMessage.error(getApiErrorMessage(cause));
    } finally {
      historyPreviewLoading.value = false;
    }
  }

  async function runHistoryBackfill() {
    if (!historyPreview.value?.canBackfill) {
      return showWarning('请先完成历史回填预览');
    }
    historySubmitting.value = true;
    try {
      const result = await idBusinessV2FinanceApi.backfillHistory(
        historyPreview.value.fingerprint,
        historyPreview.value.asOf
      );
      historyPreviewVisible.value = false;
      historyPreview.value = null;
      ElMessage.success(`历史回填完成：${result.summary.orders} 个订单`);
      await refresh();
    } catch (cause) {
      ElMessage.error(getApiErrorMessage(cause));
    } finally {
      historySubmitting.value = false;
    }
  }

  async function openHistoryConfirmation() {
    historyDrawerMode.value = 'confirm';
    historyNote.value = '';
    historyChecklist.financeAccountsConfirmed = false;
    historyChecklist.supplierBalancesConfirmed = false;
    historyChecklist.historicalExpensesConfirmed = false;
    historyConfirmationPreview.value = null;
    historyConfirmationLoading.value = true;
    try {
      historyConfirmationPreview.value = await idBusinessV2FinanceApi.previewHistoryConfirmation();
      historyDrawerVisible.value = true;
    } catch (cause) {
      ElMessage.error(getApiErrorMessage(cause));
    } finally {
      historyConfirmationLoading.value = false;
    }
  }

  function openHistoryReopen() {
    historyDrawerMode.value = 'reopen';
    historyReopenReason.value = '';
    historyDrawerVisible.value = true;
  }

  async function submitHistoryDrawer() {
    if (historyConfirmationDisabledReason.value) {
      return showWarning(historyConfirmationDisabledReason.value);
    }
    historySubmitting.value = true;
    try {
      if (historyDrawerMode.value === 'reopen') {
        await idBusinessV2FinanceApi.reopenHistoryConfirmation(historyReopenReason.value.trim());
        ElMessage.success('已重新开启历史数据核对');
      } else {
        const preview = historyConfirmationPreview.value!;
        await idBusinessV2FinanceApi.confirmHistory({
          ...historyChecklist,
          previewFingerprint: preview.fingerprint,
          note: historyNote.value.trim()
        });
        ElMessage.success('历史数据完整性已确认');
      }
      historyDrawerVisible.value = false;
      await refresh();
    } catch (cause) {
      ElMessage.error(getApiErrorMessage(cause));
    } finally {
      historySubmitting.value = false;
    }
  }

  return {
    historyDrawerVisible,
    historyDrawerMode,
    historySubmitting,
    historyConfirmationLoading,
    historyConfirmationPreview,
    historyChecklist,
    historyNote,
    historyReopenReason,
    historyDrawerDirty,
    historyConfirmationDisabledReason,
    historyPreviewVisible,
    historyPreviewLoading,
    historyPreview,
    historyPreviewConfirmDisabledReason,
    openHistoryBackfillPreview,
    runHistoryBackfill,
    openHistoryConfirmation,
    openHistoryReopen,
    submitHistoryDrawer
  };
}

function showWarning(message: string) {
  ElMessage.warning(message);
}
