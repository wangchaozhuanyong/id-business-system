<template>
  <V2FormDrawer
    :model-value="modelValue"
    retain-draft
    :title="row ? '编辑代理' : '新增代理'"
    :confirm-loading="saving"
    :dirty="Boolean(url || form.countryCode || form.kind || form.remark)"
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
      <el-form-item
        :label="form.connectionMode === 'direct' ? '代理地址' : '提取链接'"
        :required="!row"
        ><el-input
          v-model="url"
          :maxlength="2048"
          autocomplete="off"
          :placeholder="
            row
              ? '留空保留已保存链接'
              : form.connectionMode === 'direct'
                ? '协议://账号:密码@主机:端口'
                : 'HTTPS 提取链接'
          "
      /></el-form-item>
      <p>动态会话支持在代理地址中使用 {session}；IP 属性与连接方式分别保存。</p>
    </el-form>
    <p v-if="error" role="alert">{{ error }}</p>
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
import type { ProxyPoolItem } from './contracts';
import ProxyPoolFields, { type ProxyPoolForm } from './ProxyPoolFields.vue';
const props = defineProps<{ modelValue: boolean; row: ProxyPoolItem | null }>();
const emit = defineEmits<{ 'update:modelValue': [boolean]; saved: [] }>();
const draft = useV2FormDraft<ProxyPoolForm>('proxy-pool/editor', () => ({
  countryCode: '',
  kind: '',
  connectionMode: 'direct',
  protocol: 'http',
  remark: ''
}));
const form = draft.form;
const fields = computed({ get: () => form, set: (value) => Object.assign(form, value) });
// 代理凭据只保存在当前打开的输入框中，不写入会话草稿。
const url = ref('');
let active = true;
function clearSensitiveInput() {
  url.value = '';
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
  error = ref('');
watch(
  () => [props.modelValue, props.row?.id] as const,
  ([open]) => {
    url.value = '';
    if (!open) return;
    error.value = '';
    draft.open(
      props.row?.id ?? 'create',
      props.row
        ? {
            countryCode: props.row.countryCode,
            kind: props.row.kind ?? '',
            protocol: props.row.protocol,
            connectionMode: props.row.connectionMode,
            remark:
              props.row.remark ?? [props.row.remark1, props.row.remark2].filter(Boolean).join('\n')
          }
        : undefined,
      props.row?.updatedAt
    );
  },
  { immediate: true }
);
async function save() {
  if (saving.value) return;
  error.value = '';
  try {
    const countryCode = parseProxyCountry(form.countryCode);
    if (!form.kind) throw new Error('请选择 IP 属性');
    if (!props.row && !url.value.trim()) throw new Error('请填写代理地址或提取链接');
    const input = {
      ...form,
      protocol: protocolForProxyLink(url.value, form.connectionMode, form.protocol),
      kind: form.kind,
      countryCode,
      ...(url.value.trim() ? { url: url.value.trim() } : {})
    };
    const id = props.row?.id;
    const version = draft.version.value;
    const complete = draft.beginSave();
    const identity = sessionCoordinator.identityEpoch.value;
    const submittedSecret = url.value;
    saving.value = true;
    if (id)
      await proxyPoolApi.update(id, {
        ...input,
        expectedUpdatedAt: version == null ? undefined : String(version)
      });
    else await proxyPoolApi.create({ ...input, url: url.value.trim() });
    if (!active || identity !== sessionCoordinator.identityEpoch.value) return;
    if (url.value === submittedSecret && complete()) {
      url.value = '';
      emit('update:modelValue', false);
    }
    emit('saved');
  } catch (cause) {
    error.value = getApiErrorMessage(cause);
  } finally {
    saving.value = false;
  }
}
</script>
