<template>
  <V2FormDrawer
    v-model="open"
    retain-draft
    title="批量导入 ChatGPT 账号"
    description="按所选资料格式粘贴 ChatGPT 账号。邮箱必填，密码选填，整批校验后保存。"
    confirm-text="导入账号"
    size="min(680px, 96vw)"
    :confirm-loading="importing"
    :dirty="Boolean(importText.trim())"
    @confirm="importAccounts"
  >
    <ChatgptAccountImportFields v-model="importText" v-model:format="importFormat" />
    <p v-if="error" class="bank-recharge-error" role="alert">{{ error }}</p>
  </V2FormDrawer>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import { useV2SessionDraft } from '@/v2/composables/useV2SessionDraft';
import { getApiErrorMessage } from '@/api/client';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { bankRechargeApi } from './bank-recharge-api';
import {
  parseChatgptAccountImport,
  type ChatgptAccountImportFormat
} from './chatgpt-account-import';
import ChatgptAccountImportFields from './ChatgptAccountImportFields.vue';

const open = defineModel<boolean>({ required: true });
const emit = defineEmits<{ imported: [] }>();
const { importText, importFormat, importing } = useV2SessionDraft(
  'chatgpt-accounts-import',
  () => ({
    importText: ref(''),
    importFormat: ref<ChatgptAccountImportFormat>('without_password'),
    importing: ref(false)
  })
);
const error = ref('');
async function importAccounts() {
  if (importing.value) return;
  error.value = '';
  try {
    const submittedText = importText.value;
    const rows = parseChatgptAccountImport(submittedText, importFormat.value);
    importing.value = true;
    const result = await bankRechargeApi.importAccounts(rows);
    if (importText.value === submittedText) importText.value = '';
    open.value = false;
    ElMessage.success(`已导入 ${result.imported} 个 ChatGPT 账号`);
    emit('imported');
  } catch (reason) {
    error.value = getApiErrorMessage(reason);
  } finally {
    importing.value = false;
  }
}
</script>
