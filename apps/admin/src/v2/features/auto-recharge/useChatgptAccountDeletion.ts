import { ref, type Ref } from 'vue';
import { ElMessage } from 'element-plus';
import { getApiErrorMessage } from '@/api/client';
import { bankRechargeApi, type BankChatgptAccount } from './bank-recharge-api';
export function useChatgptAccountDeletion(
  working: Ref<boolean>,
  operationError: Ref<string>,
  refresh: () => Promise<unknown>
) {
  const deleteOpen = ref(false);
  const deleting = ref<BankChatgptAccount | null>(null);
  const deleteError = ref('');
  function openDelete(account: BankChatgptAccount) {
    deleting.value = account;
    operationError.value = '';
    deleteError.value = '';
    deleteOpen.value = true;
  }
  async function confirmDelete() {
    if (!deleting.value || working.value) return;
    working.value = true;
    operationError.value = '';
    try {
      await bankRechargeApi.deleteAccount(deleting.value.id);
      deleteOpen.value = false;
      deleting.value = null;
      ElMessage.success('账号已删除');
      await refresh();
    } catch (error) {
      deleteError.value = getApiErrorMessage(error);
    } finally {
      working.value = false;
    }
  }
  return { deleteOpen, deleting, deleteError, openDelete, confirmDelete };
}
