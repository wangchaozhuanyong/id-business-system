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
    <p v-if="message" :role="failed ? 'alert' : 'status'">{{ message }}</p>
    <el-form
      ref="formRef"
      :model="validationModel"
      :rules="rules"
      scroll-to-error
      label-position="left"
      label-width="110px"
      require-asterisk-position="right"
      @submit.prevent="save"
    >
      <ProxyPoolFields v-model="fields" />
      <el-form-item label="代理列表" prop="text" required
        ><el-input
          v-model="text"
          :validate-event="!saving"
          type="textarea"
          :rows="10"
          :maxlength="1024000"
          autocomplete="off"
          placeholder="每行一条代理地址或提取链接，最多 500 条"
      /></el-form-item>
      <p>以上国家、属性和备注应用于本批代理。重复链接自动跳过。</p>
    </el-form>
  </V2FormDrawer>
</template>
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { FormInstance } from 'element-plus';
import { sessionCoordinator } from '@/auth/sessionCoordinator';
import { getApiErrorMessage } from '@/api/client';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import { useV2FormDraft } from '@/v2/composables/useV2SessionDraft';
import { validateV2Form } from '@/v2/utils/formValidation';
import { proxyPoolApi } from './api';
import { createProxyFormRules, normalizeProxyImport, parseProxyCountry } from './options';
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
const formRef = ref<FormInstance>();
const validationModel = computed(() => ({ ...draft.form, text: text.value }));
const rules = createProxyFormRules({
  field: 'text',
  mode: () => draft.form.connectionMode,
  protocol: () => draft.form.protocol
});
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
    if (open) {
      message.value = '';
      draft.open('create');
    }
  },
  { immediate: true }
);
async function save() {
  if (saving.value) return;
  failed.value = false;
  message.value = '';
  try {
    if (!(await validateV2Form(formRef.value))) return;
    const countryCode = parseProxyCountry(draft.form.countryCode);
    const kind = draft.form.kind;
    if (!kind) throw new Error('请选择 IP 属性');
    const rows = normalizeProxyImport(text.value, draft.form.connectionMode, draft.form.protocol);
    const input = rows.map((connection) => ({
      ...draft.form,
      countryCode,
      kind,
      ...connection
    }));
    const submittedText = text.value;
    const complete = draft.beginSave();
    const identity = sessionCoordinator.identityEpoch.value;
    saving.value = true;
    const result = await proxyPoolApi.importMany(input);
    if (!active || identity !== sessionCoordinator.identityEpoch.value) return;
    message.value = `已导入 ${result.imported} 条，跳过重复 ${result.duplicates ?? 0} 条`;
    if (text.value === submittedText && complete()) {
      text.value = '';
      await nextTick();
      formRef.value?.clearValidate();
    }
    emit('saved');
  } catch (cause) {
    failed.value = true;
    message.value = getApiErrorMessage(cause);
  } finally {
    saving.value = false;
  }
}
</script>
