<template>
  <AppButton
    size="small"
    variant="ghost"
    :disabled="disabled || !account.openingCard?.id"
    @click="open"
    >删除卡</AppButton
  >
  <V2ConfirmDialog
    v-model="dialogOpen"
    title="删除开通银行卡"
    message=""
    confirm-text="删除卡"
    :confirm-loading="deleting"
    :confirm-disabled="query.phase.value !== 'ready' || !query.data.value"
    danger
    @confirm="remove"
  >
    <V2AsyncRegion
      skeleton="form"
      :phase="query.phase.value"
      :error="query.error.value ? getApiErrorMessage(query.error.value) : ''"
      loading-title="正在核对银行卡关联"
      @retry="query.refresh"
    >
      <template v-if="query.data.value">
        <p>
          确认从银行卡资料中删除 {{ query.data.value.label }}（{{
            query.data.value.numberSummary || `尾号 ${query.data.value.last4}`
          }}）？
        </p>
        <p>
          此卡关联 {{ query.data.value.linkedAccountCount }} 个账号、{{
            query.data.value.orderCount
          }}
          笔订单。账号及付款历史保留；其他关联账号也会显示银行卡已删除。
        </p>
      </template>
    </V2AsyncRegion>
    <p v-if="error" class="bank-recharge-error" role="alert">{{ error }}</p>
  </V2ConfirmDialog>
</template>
<script setup lang="ts">
import { ref } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2ConfirmDialog from '@/v2/components/V2ConfirmDialog.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import { useV2ModuleQuery, createV2QueryKey } from '@/v2/composables/useV2Query';
import { getApiErrorMessage } from '@/api/client';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { bankRechargeApi, type BankChatgptAccount } from './bank-recharge-api';
const props = defineProps<{ account: BankChatgptAccount; disabled: boolean }>();
const emit = defineEmits<{ deleted: [] }>();
const dialogOpen = ref(false),
  deleting = ref(false),
  error = ref('');
const query = useV2ModuleQuery({
  moduleKey: 'chatgpt-accounts',
  scope: 'auto-recharge',
  enabled: () => dialogOpen.value,
  key: () => createV2QueryKey({ action: 'opening-card-deletion', id: props.account.id }),
  query: () => bankRechargeApi.openingCardDeletion(props.account.id)
});
function open() {
  error.value = '';
  dialogOpen.value = true;
  void query.refresh();
}
async function remove() {
  if (deleting.value || !query.data.value || query.phase.value !== 'ready') return;
  deleting.value = true;
  error.value = '';
  try {
    await bankRechargeApi.deleteOpeningCard(props.account.id, query.data.value);
    dialogOpen.value = false;
    ElMessage.success('银行卡已删除，账号和付款历史已保留');
    emit('deleted');
  } catch (cause) {
    error.value = getApiErrorMessage(cause);
  } finally {
    deleting.value = false;
  }
}
</script>
