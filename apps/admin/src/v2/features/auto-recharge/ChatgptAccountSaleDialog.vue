<template>
  <V2ConfirmDialog
    :model-value="true"
    :title="title"
    message=""
    :confirm-text="title"
    :confirm-loading="saving"
    :confirm-disabled="!canChangeChatgptAccountSale(account)"
    @update:model-value="!$event && emit('close')"
    @confirm="save"
  >
    <p>{{ account.emailMasked }}</p>
    <p v-if="nextStatus === 'sold'">
      确认将此账号标记为已出售吗？标记后进入已出售清单，不再列入待用账号，仍可充值和续费。
    </p>
    <p v-else>确认将此账号改为未出售吗？标记后退出已出售清单，是否列入待用账号仍按订阅情况判断。</p>
    <p v-if="error" class="bank-recharge-error" role="alert">{{ error }}</p>
  </V2ConfirmDialog>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import V2ConfirmDialog from '@/v2/components/V2ConfirmDialog.vue';
import { getApiErrorMessage } from '@/api/client';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { bankRechargeApi, type BankChatgptAccount } from './bank-recharge-api';
import { canChangeChatgptAccountSale } from './chatgpt-account-inventory';

const props = defineProps<{ account: BankChatgptAccount }>();
const emit = defineEmits<{ close: []; completed: []; failed: [] }>();
const saving = ref(false);
const error = ref('');
const nextStatus = computed(() => (props.account.saleStatus === 'sold' ? 'unsold' : 'sold'));
const title = computed(() => (nextStatus.value === 'sold' ? '标记已出售' : '改为未出售'));

async function save() {
  if (saving.value || !canChangeChatgptAccountSale(props.account)) return;
  saving.value = true;
  error.value = '';
  try {
    // 使用打开确认框时的行快照，刷新列表不得静默替换待确认版本。
    await bankRechargeApi.updateAccount(props.account.id, {
      saleStatus: nextStatus.value,
      expectedUpdatedAt: props.account.updatedAt
    });
    ElMessage.success(nextStatus.value === 'sold' ? '账号已标记出售' : '账号已改为未出售');
    emit('completed');
    emit('close');
  } catch (cause) {
    error.value = getApiErrorMessage(cause);
    emit('failed');
  } finally {
    saving.value = false;
  }
}
</script>
