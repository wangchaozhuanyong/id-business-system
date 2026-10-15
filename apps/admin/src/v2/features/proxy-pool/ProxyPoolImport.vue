<template>
  <V2FormDrawer
    :model-value="modelValue"
    retain-draft
    title="批量导入代理"
    confirm-text="导入代理"
    :confirm-loading="saving"
    :dirty="Boolean(text.trim())"
    @update:model-value="$emit('update:modelValue', $event)"
    @confirm="save"
  >
    <el-form
      label-position="left"
      label-width="110px"
      require-asterisk-position="right"
      @submit.prevent="save"
    >
      <ProxyPoolFields v-model="fields" />
      <el-form-item label="代理列表" required
        ><el-input
          v-model="text"
          type="textarea"
          :rows="10"
          :maxlength="1024000"
          autocomplete="off"
          placeholder="每行一条代理地址或提取链接，最多 500 条"
      /></el-form-item>
      <p>以上国家、属性和备注应用于本批代理。重复链接自动跳过。</p>
    </el-form>
    <p v-if="message" :role="failed ? 'alert' : 'status'">{{ message }}</p>
  </V2FormDrawer>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { sessionCoordinator } from '@/auth/sessionCoordinator';
import { getApiErrorMessage } from '@/api/client';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import { useV2FormDraft } from '@/v2/composables/useV2SessionDraft';
import { proxyPoolApi } from './api';
import { parseProxyCountry, protocolForProxyLink } from './options';
import ProxyPoolFields, { type ProxyPoolForm } from './ProxyPoolFields.vue';
const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [boolean]; saved: [] }>();
const draft = useV2FormDraft<ProxyPoolForm>('proxy-pool/import', () => ({
  countryCode: '',
  kind: '',
  protocol: 'http',
  connectionMode: 'direct',
  remark: ''
}));
const fields = computed({
  get: () => draft.form,
  set: (value) => Object.assign(draft.form, value)
});
// 导入内容含代理凭据，关闭或身份改变时清除，不纳入会话草稿。
const text = ref('');
let active = true;
function clearSensitiveInput() {
  text.value = '';
}
const stop = sessionCoordinator.subscribeIdentityChange(clearSensitiveInput);
onBeforeUnmount(() => {
  clearSensitiveInput();
  stop();
});
onBeforeUnmount(() => {
  active = false;
});
const saving = ref(false),
  failed = ref(false),
  message = ref('');
watch(
  () => props.modelValue,
  (open) => {
    text.value = '';
    if (open) draft.open('create');
  },
  { immediate: true }
);
async function save() {
  if (saving.value) return;
  failed.value = false;
  message.value = '';
  try {
    const countryCode = parseProxyCountry(draft.form.countryCode);
    const kind = draft.form.kind;
    if (!kind) throw new Error('请选择 IP 属性');
    const rows = text.value
      .split(/\r?\n/)
      .map((url) => url.trim())
      .filter(Boolean);
    if (!rows.length || rows.length > 500) throw new Error('每次需要导入 1 至 500 条代理');
    const input = rows.map((url) => ({
      ...draft.form,
      countryCode,
      kind,
      url,
      protocol: protocolForProxyLink(url, draft.form.connectionMode, draft.form.protocol)
    }));
    const submittedText = text.value;
    const complete = draft.beginSave();
    const identity = sessionCoordinator.identityEpoch.value;
    saving.value = true;
    const result = await proxyPoolApi.importMany(input);
    if (!active || identity !== sessionCoordinator.identityEpoch.value) return;
    message.value = `已导入 ${result.imported} 条，跳过重复 ${result.duplicates ?? 0} 条`;
    if (text.value === submittedText && complete()) text.value = '';
    emit('saved');
  } catch (cause) {
    failed.value = true;
    message.value = getApiErrorMessage(cause);
  } finally {
    saving.value = false;
  }
}
</script>
