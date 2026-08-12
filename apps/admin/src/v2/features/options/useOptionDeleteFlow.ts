import { computed, ref, watch, type Ref } from 'vue';
import { getApiErrorMessage } from '@/api/client';
import { isApiError } from '@/api/apiError';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { idBusinessV2OptionsApi } from './api';
import type { V2Option, V2OptionDeletePreview } from './contracts';

interface OptionDeleteFlowInput {
  items: Ref<V2Option[]>;
  currentPage: Ref<number>;
  refresh: () => void;
}

export function useOptionDeleteFlow(input: OptionDeleteFlowInput) {
  const deleteDialogVisible = ref(false);
  const deleting = ref(false);
  const deletingItem = ref<V2Option | null>(null);
  const deletePreview = ref<V2OptionDeletePreview | null>(null);
  const deletePreviewLoading = ref(false);
  let deletePreviewRequestId = 0;

  const deleteConfirmDisabledReason = computed(() => {
    if (deletePreviewLoading.value) return '正在核对关联数据';
    if (!deletePreview.value) return '删除预览不可用';
    return deletePreview.value.blockingReasons.join('；');
  });
  const deleteImpactRows = computed(() => {
    const impact = deletePreview.value?.impact;
    if (!impact) return [];
    return [
      { label: '连带业务', value: impact.dependentServiceCount },
      { label: '关联 ID', value: impact.accountReferenceCount },
      { label: '关联客户', value: impact.customerReferenceCount },
      { label: '关联礼品卡', value: impact.giftCardReferenceCount },
      { label: '关联订单', value: impact.orderReferenceCount },
      { label: '关联开通', value: impact.activationReferenceCount },
      { label: '供应商钱包', value: impact.supplierWalletCount },
      { label: '财务开支', value: impact.financeExpenseCount }
    ].filter((item) => item.value > 0);
  });

  async function openDelete(item: V2Option) {
    if (item.isSystem) return;
    const requestId = ++deletePreviewRequestId;
    deletingItem.value = item;
    deletePreview.value = null;
    deleteDialogVisible.value = true;
    deletePreviewLoading.value = true;
    try {
      const preview = await idBusinessV2OptionsApi.getDeletePreview(item.id);
      if (requestId === deletePreviewRequestId && deletingItem.value?.id === item.id) {
        deletePreview.value = preview;
      }
    } catch (error) {
      if (requestId !== deletePreviewRequestId) return;
      ElMessage.error(getApiErrorMessage(error));
      deleteDialogVisible.value = false;
      deletingItem.value = null;
    } finally {
      if (requestId === deletePreviewRequestId) deletePreviewLoading.value = false;
    }
  }

  async function confirmDelete() {
    if (!deletingItem.value || !deletePreview.value?.canDelete) return;
    deleting.value = true;
    try {
      await idBusinessV2OptionsApi.remove(deletingItem.value.id, deletePreview.value.fingerprint);
      ElMessage.success('选项已删除');
      deleteDialogVisible.value = false;
      deletingItem.value = null;
      deletePreview.value = null;
      if (input.items.value.length === 1 && input.currentPage.value > 1) {
        input.currentPage.value -= 1;
      }
      input.refresh();
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
      if (isApiError(error) && error.kind === 'conflict' && deletingItem.value) {
        await openDelete(deletingItem.value);
      }
    } finally {
      deleting.value = false;
    }
  }

  watch(deleteDialogVisible, (visible) => {
    if (visible) return;
    deletePreviewRequestId += 1;
    deletePreviewLoading.value = false;
    deletePreview.value = null;
    if (!deleting.value) deletingItem.value = null;
  });

  function getDeleteTitle(item: V2Option) {
    return item.isSystem ? '系统固定选项不能删除' : '删除选项';
  }

  function getDeleteMessage(item: V2Option | null) {
    if (!item) return '确认删除该选项？';
    const cascadeNotice =
      item.childCount > 0 && (item.type === 'country' || item.type === 'business_category')
        ? '系统会同时删除关联的开通业务；已有 ID、订单和历史账目仍保留原始名称。'
        : '已有业务记录会保留原始关联，但后续不能再选择该选项。';
    return `确认删除“${item.name}”？${cascadeNotice}`;
  }

  return {
    deleteDialogVisible,
    deleting,
    deletingItem,
    deletePreview,
    deletePreviewLoading,
    deleteConfirmDisabledReason,
    deleteImpactRows,
    openDelete,
    confirmDelete,
    getDeleteTitle,
    getDeleteMessage
  };
}
