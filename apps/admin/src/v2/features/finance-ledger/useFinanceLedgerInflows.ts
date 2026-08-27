import { computed, reactive, ref, shallowRef, type ComputedRef } from 'vue';
import type {
  V2FinanceAccount,
  V2FinanceInflow,
  V2FinanceInflowNature
} from '@apple-business/shared';
import { getApiErrorMessage } from '@/api/client';
import { ensureV2BusinessNowInput, getV2BusinessNowInput } from '@/v2/runtime/businessClock';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { isV2UnsignedDecimal } from '@/v2/utils/decimal';
import { toV2DateTimeInput, v2DateTimeInputToIso } from '@/v2/utils/dateTime';
import { idBusinessV2FinanceApi } from './api';

interface FinanceLedgerInflowsInput {
  accounts: ComputedRef<V2FinanceAccount[]>;
}

export function useFinanceLedgerInflows(input: FinanceLedgerInflowsInput) {
  const inflowDrawerVisible = ref(false);
  const inflowSubmitting = ref(false);
  const editingInflow = ref<V2FinanceInflow | null>(null);
  const inflowCorrectionReason = ref('');
  const inflowReceiptFile = shallowRef<File | null>(null);
  const inflowReceiptInputKey = ref(0);
  const inflowInitialSnapshot = ref('');
  const receiptDownloadingId = ref('');
  const inflowForm = reactive({
    nature: 'operating_income' as V2FinanceInflowNature,
    categoryOptionId: '',
    financeAccountId: '',
    amount: '',
    occurredAt: getV2BusinessNowInput(),
    fxRateToCny: '',
    manualRateReason: '',
    payer: '',
    externalReference: '',
    receiptAttachmentId: '',
    remark: ''
  });
  const selectedInflowAccount = computed(() =>
    input.accounts.value.find((item) => item.id === inflowForm.financeAccountId)
  );
  const inflowDirty = computed(
    () => inflowDrawerVisible.value && inflowSnapshot() !== inflowInitialSnapshot.value
  );

  async function openInflow(inflow?: V2FinanceInflow) {
    const businessNow = inflow ? null : await ensureV2BusinessNowInput();
    if (!inflow && !businessNow) {
      ElMessage.error('无法读取服务器北京时间，请稍后重试');
      return;
    }
    editingInflow.value = inflow ?? null;
    inflowCorrectionReason.value = '';
    inflowReceiptFile.value = null;
    inflowReceiptInputKey.value += 1;
    Object.assign(inflowForm, {
      nature: inflow?.nature ?? 'operating_income',
      categoryOptionId: inflow?.categoryOptionId ?? '',
      financeAccountId: inflow?.financeAccountId ?? '',
      amount: inflow?.amountOriginal ?? '',
      occurredAt: inflow?.occurredAt ? toV2DateTimeInput(inflow.occurredAt) : businessNow,
      fxRateToCny: '',
      manualRateReason: '',
      payer: inflow?.payer ?? '',
      externalReference: inflow?.externalReference ?? '',
      receiptAttachmentId: inflow?.receiptAttachmentId ?? '',
      remark: inflow?.remark ?? ''
    });
    inflowInitialSnapshot.value = inflowSnapshot();
    inflowDrawerVisible.value = true;
  }

  function selectInflowReceipt(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      input.value = '';
      return showWarning('收款凭证不能超过 5 MB');
    }
    if (!['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      input.value = '';
      return showWarning('收款凭证仅支持 PDF、JPG、PNG 或 WebP 文件');
    }
    inflowReceiptFile.value = file;
  }

  function clearSelectedInflowReceipt() {
    inflowReceiptFile.value = null;
    inflowReceiptInputKey.value += 1;
  }

  async function submitInflow() {
    const account = selectedInflowAccount.value;
    if (!account) return showWarning('请选择收款账户');
    if (inflowForm.nature === 'operating_income' && !inflowForm.categoryOptionId) {
      return showWarning('请选择收入分类');
    }
    if (inflowForm.nature !== 'operating_income' && inflowForm.payer.trim().length < 2) {
      return showWarning(
        inflowForm.nature === 'capital_contribution' ? '请填写出资人' : '请填写出借人'
      );
    }
    if (!isV2UnsignedDecimal(inflowForm.amount, { allowZero: false, decimalPlaces: 4 })) {
      return showWarning('收入金额必须大于 0');
    }
    if (!inflowForm.occurredAt) return showWarning('请选择发生时间');
    if (inflowForm.externalReference.trim().length < 2) {
      return showWarning('请填写至少 2 个字符的收款流水号');
    }
    if (!inflowReceiptFile.value && !inflowForm.receiptAttachmentId) {
      return showWarning('请上传收款凭证');
    }
    if (editingInflow.value && !inflowCorrectionReason.value.trim()) {
      return showWarning('请填写更正原因');
    }
    if (
      account.currency !== 'CNY' &&
      inflowForm.fxRateToCny &&
      !inflowForm.manualRateReason.trim()
    ) {
      return showWarning('填写人工汇率时必须说明原因');
    }
    inflowSubmitting.value = true;
    try {
      const payload = {
        nature: inflowForm.nature,
        categoryOptionId:
          inflowForm.nature === 'operating_income' ? inflowForm.categoryOptionId : undefined,
        financeAccountId: account.id,
        amount: inflowForm.amount,
        currency: account.currency,
        occurredAt: v2DateTimeInputToIso(inflowForm.occurredAt),
        fxRateToCny: inflowForm.fxRateToCny || undefined,
        manualRateReason: inflowForm.manualRateReason.trim() || undefined,
        payer: inflowForm.payer.trim() || undefined,
        externalReference: inflowForm.externalReference.trim(),
        receiptAttachmentId: inflowForm.receiptAttachmentId || undefined,
        remark: inflowForm.remark.trim() || undefined,
        idempotencyKey: globalThis.crypto.randomUUID()
      };
      if (editingInflow.value) {
        await idBusinessV2FinanceApi.correctInflow(
          editingInflow.value.id,
          {
            ...payload,
            reason: inflowCorrectionReason.value.trim()
          },
          inflowReceiptFile.value
        );
      } else {
        await idBusinessV2FinanceApi.createInflow(payload, inflowReceiptFile.value);
      }
      inflowDrawerVisible.value = false;
      inflowReceiptFile.value = null;
      ElMessage.success(editingInflow.value ? '原流水已冲销，正确收入已重新入账' : '收入已入账');
    } catch (cause) {
      ElMessage.error(getApiErrorMessage(cause));
    } finally {
      inflowSubmitting.value = false;
    }
  }

  async function viewInflowReceipt(inflow: V2FinanceInflow) {
    if (!inflow.receiptAttachment) return showWarning('该收入记录没有可查看的收款凭证');
    receiptDownloadingId.value = inflow.id;
    try {
      const blob = await idBusinessV2FinanceApi.downloadInflowReceipt(inflow.id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (cause) {
      ElMessage.error(getApiErrorMessage(cause));
    } finally {
      receiptDownloadingId.value = '';
    }
  }

  function inflowSnapshot() {
    const file = inflowReceiptFile.value;
    return JSON.stringify({
      nature: inflowForm.nature,
      categoryOptionId: inflowForm.categoryOptionId,
      financeAccountId: inflowForm.financeAccountId,
      amount: inflowForm.amount,
      occurredAt: inflowForm.occurredAt,
      fxRateToCny: inflowForm.fxRateToCny,
      manualRateReason: inflowForm.manualRateReason,
      payer: inflowForm.payer,
      externalReference: inflowForm.externalReference,
      receiptAttachmentId: inflowForm.receiptAttachmentId,
      receiptFile: file
        ? { name: file.name, size: file.size, type: file.type, lastModified: file.lastModified }
        : null,
      remark: inflowForm.remark,
      correctionReason: inflowCorrectionReason.value
    });
  }

  return {
    inflowDrawerVisible,
    inflowSubmitting,
    editingInflow,
    inflowCorrectionReason,
    inflowReceiptFile,
    inflowReceiptInputKey,
    receiptDownloadingId,
    inflowForm,
    selectedInflowAccount,
    inflowDirty,
    openInflow,
    selectInflowReceipt,
    clearSelectedInflowReceipt,
    submitInflow,
    viewInflowReceipt
  };
}

function showWarning(message: string) {
  ElMessage.warning(message);
}
