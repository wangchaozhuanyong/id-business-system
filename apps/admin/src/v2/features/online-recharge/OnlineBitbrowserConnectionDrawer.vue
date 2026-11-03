<template>
  <V2FormDrawer
    :model-value="modelValue"
    :title="`${device?.name || '执行电脑'} · 比特连接设置`"
    retain-draft
    :confirm-loading="busy"
    :confirm-disabled="query.phase.value !== 'ready'"
    :dirty="dirty"
    @update:model-value="$emit('update:modelValue', $event)"
    @confirm="save"
  >
    <V2AsyncRegion
      :phase="query.phase.value"
      :error="query.error.value ? getApiErrorMessage(query.error.value) : ''"
      skeleton="form"
      loading-title="正在读取本台电脑的连接设置"
      @retry="query.refresh"
    >
      <p>每台电脑使用自己的比特接口密钥。更改只影响新任务，日常在网站提交和查看结果即可。</p>
      <el-form
        ref="formRef"
        :model="draft.form"
        :rules="rules"
        label-position="left"
        label-width="112px"
        require-asterisk-position="right"
        @submit.prevent="save"
      >
        <el-form-item label="比特本机接口" prop="localApiUrl" required
          ><el-input v-model="draft.form.localApiUrl"
        /></el-form-item>
        <el-form-item label="比特接口密钥"
          ><el-input
            v-model="apiKey"
            type="password"
            show-password
            autocomplete="new-password"
            :placeholder="
              query.data.value?.secretSaved ? '已保存，留空保留' : '首次填写本台电脑的接口密钥'
            "
        /></el-form-item>
        <el-form-item label="比特分组名称" prop="groupName" required
          ><el-input v-model="draft.form.groupName" maxlength="80"
        /></el-form-item>
        <el-form-item label="比特标签名称" prop="tagName" required
          ><el-input v-model="draft.form.tagName" maxlength="80"
        /></el-form-item>
      </el-form>
      <p v-if="error" role="alert">{{ error }}</p>
    </V2AsyncRegion>
  </V2FormDrawer>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
import { sessionCoordinator } from '@/auth/sessionCoordinator';
import { getApiErrorMessage } from '@/api/client';
import { useV2FormDraft } from '@/v2/composables/useV2SessionDraft';
import { useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { validateV2Form } from '@/v2/utils/formValidation';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import {
  bitbrowserApi,
  type BitbrowserDevice,
  type BitbrowserDeviceConnection
} from './bitbrowser-api';
const props = defineProps<{ modelValue: boolean; device: BitbrowserDevice | null }>();
const emit = defineEmits<{ 'update:modelValue': [boolean]; saved: [] }>();
const draft = useV2FormDraft('online-recharge/device-connection', () => ({
  localApiUrl: '',
  groupName: '',
  tagName: ''
}));
const formRef = ref<FormInstance>(),
  busy = ref(false),
  error = ref(''),
  apiKey = ref('');
const dirty = computed(
  () => JSON.stringify(draft.form) !== draft.original.value || Boolean(apiKey.value)
);
const query = useV2ModuleQuery<BitbrowserDeviceConnection & { deviceId: string }>({
  moduleKey: 'online-recharge-config',
  scope: 'online-recharge',
  trackRouteData: false,
  keepPreviousData: false,
  key: () => `bitbrowser-connection:${props.device?.id ?? 'closed'}`,
  enabled: () => props.modelValue && Boolean(props.device),
  query: async ({ signal }) => {
    const deviceId = props.device!.id;
    return { ...(await bitbrowserApi.connection(deviceId, signal)), deviceId };
  }
});
const rules: FormRules = Object.fromEntries(
  ['localApiUrl', 'groupName', 'tagName'].map((key) => [
    key,
    [{ required: true, message: '请填写此项', trigger: 'blur' }]
  ])
);
watch(
  [query.data, () => props.device?.id],
  ([data, deviceId]) => {
    if (data && deviceId && data.deviceId === deviceId)
      draft.open(
        String(deviceId),
        { localApiUrl: data.localApiUrl, groupName: data.groupName, tagName: data.tagName },
        String(data.version)
      );
  },
  { immediate: true }
);
function clearSensitiveInput() {
  apiKey.value = '';
  error.value = '';
}
watch(() => props.modelValue, clearSensitiveInput);
watch(() => props.device?.id, clearSensitiveInput);
const stopIdentity = sessionCoordinator.subscribeIdentityChange(clearSensitiveInput);
let active = true;
onBeforeUnmount(() => {
  active = false;
  clearSensitiveInput();
  stopIdentity();
});
async function save() {
  if (
    busy.value ||
    !props.device ||
    query.data.value?.deviceId !== props.device.id ||
    !(await validateV2Form(formRef.value))
  )
    return;
  if (!query.data.value?.secretSaved && apiKey.value.length < 16) {
    error.value = '请填写本台电脑的有效比特接口密钥';
    return;
  }
  const deviceId = props.device.id,
    epoch = sessionCoordinator.identityEpoch.value;
  const body = {
    ...draft.form,
    version: Number(draft.version.value ?? 0),
    localApiToken: apiKey.value
  };
  const finish = draft.beginSave();
  busy.value = true;
  error.value = '';
  try {
    await bitbrowserApi.saveConnection(deviceId, body);
    if (!active || epoch !== sessionCoordinator.identityEpoch.value) return;
    finish();
    if (
      props.device?.id === deviceId &&
      apiKey.value === body.localApiToken &&
      JSON.stringify(draft.form) ===
        JSON.stringify({
          localApiUrl: body.localApiUrl,
          groupName: body.groupName,
          tagName: body.tagName
        })
    ) {
      apiKey.value = '';
      emit('update:modelValue', false);
    }
    emit('saved');
  } catch (cause) {
    if (active && props.device?.id === deviceId && epoch === sessionCoordinator.identityEpoch.value)
      error.value = getApiErrorMessage(cause);
  } finally {
    if (active) busy.value = false;
  }
}
</script>
