<template>
  <AppButton variant="soft" @click="open = true">复制后缀</AppButton>
  <V2FormDrawer
    v-model="open"
    retain-draft
    title="账号复制后缀"
    description="复制账号资料时，在买家查询码后另起一行追加以下内容。留空则不追加。"
    :confirm-loading="saving"
    :dirty="suffix !== original"
    @confirm="save"
  >
    <V2AsyncRegion
      skeleton="inline"
      :phase="query.phase.value"
      :error="query.error.value ? getApiErrorMessage(query.error.value) : ''"
      loading-title="正在加载复制后缀"
      error-title="后缀加载失败"
      @retry="query.refresh"
    >
      <el-form label-position="left" label-width="100px" require-asterisk-position="right">
        <el-form-item label="复制后缀"
          ><el-input
            v-model="suffix"
            type="textarea"
            :rows="6"
            maxlength="5000"
            show-word-limit
            placeholder="可填写查询入口、说明等内容，支持换行"
            aria-label="账号复制后缀内容"
        /></el-form-item>
      </el-form>
    </V2AsyncRegion>
    <p v-if="error" class="bank-recharge-error" role="alert">{{ error }}</p>
  </V2FormDrawer>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import { useV2SessionDraft } from '@/v2/composables/useV2SessionDraft';
import { primeV2Query, useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { getApiErrorMessage } from '@/api/client';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { bankRechargeApi } from './bank-recharge-api';

const open = ref(false);
const error = ref('');
const { suffix, original, initialized, saving } = useV2SessionDraft(
  'chatgpt-account-copy-suffix',
  () => ({
    suffix: ref(''),
    original: ref(''),
    initialized: ref(false),
    saving: ref(false)
  })
);
const query = useV2ModuleQuery({
  moduleKey: 'chatgpt-accounts',
  scope: 'auto-recharge',
  key: 'chatgpt-account-copy-settings',
  trackRouteData: false,
  enabled: () => open.value,
  query: ({ signal }) => bankRechargeApi.accountCopySettings({ signal })
});
watch(
  query.data,
  (data) => {
    if (!saving.value && data && (!initialized.value || suffix.value === original.value)) {
      suffix.value = original.value = data.suffix;
      initialized.value = true;
    }
  },
  { immediate: true }
);
async function save() {
  if (saving.value) return;
  if (!query.data.value) {
    error.value = '请先加载已有后缀设置，避免覆盖';
    return;
  }
  saving.value = true;
  error.value = '';
  try {
    const submittedSuffix = suffix.value;
    const result = await bankRechargeApi.updateAccountCopySettings(submittedSuffix);
    primeV2Query({ scope: 'auto-recharge', key: 'chatgpt-account-copy-settings', data: result });
    if (suffix.value === submittedSuffix) suffix.value = result.suffix;
    original.value = result.suffix;
    open.value = false;
    ElMessage.success('复制后缀已保存');
  } catch (reason) {
    error.value = getApiErrorMessage(reason);
  } finally {
    saving.value = false;
  }
}
</script>
