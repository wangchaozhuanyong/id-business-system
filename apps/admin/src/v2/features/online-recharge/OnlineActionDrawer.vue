<template>
  <V2FormDrawer
    :model-value="modelValue"
    :title="action.label"
    :confirm-loading="busy"
    :confirm-text="action.label"
    @update:model-value="$emit('update:modelValue', $event)"
    @confirm="submit"
  >
    <el-form
      label-position="left"
      label-width="112px"
      require-asterisk-position="right"
      @submit.prevent="submit"
    >
      <el-form-item
        v-for="field in action.fields ?? []"
        :key="field.key"
        :label="field.label"
        :required="field.required"
      >
        <div class="online-field">
          <el-input-number
            v-if="field.type === 'number'"
            :model-value="Number(value(field.key))"
            :min="field.min"
            :max="field.max"
            @update:model-value="setValue(field, $event ?? 0)"
          />
          <el-select
            v-else-if="field.type === 'select'"
            :model-value="String(value(field.key))"
            @update:model-value="setValue(field, $event)"
            ><el-option
              v-for="option in field.options"
              :key="option.value"
              :label="option.label"
              :value="option.value"
          /></el-select>
          <el-switch
            v-else-if="field.type === 'switch'"
            :model-value="Boolean(value(field.key))"
            @update:model-value="setValue(field, Boolean($event))"
          />
          <el-input
            v-else
            :model-value="String(value(field.key))"
            :type="
              field.type === 'textarea' ? 'textarea' : field.type === 'secret' ? 'password' : 'text'
            "
            :rows="field.type === 'textarea' ? 7 : undefined"
            :show-password="field.type === 'secret'"
            autocomplete="off"
            @update:model-value="setValue(field, $event)"
          />
          <small v-if="field.help">{{ field.help }}</small>
          <label v-if="field.key === 'text'" class="online-file-label"
            >从文本文件读取<input
              type="file"
              accept=".txt,.csv,text/plain,text/csv"
              aria-label="读取导入文件"
              @change="loadFile(field, $event)"
          /></label>
        </div>
      </el-form-item>
    </el-form>
    <p v-if="error" role="alert" class="online-error">{{ error }}</p>
  </V2FormDrawer>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { sessionCoordinator } from '@/auth/sessionCoordinator';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import { useV2FormDraft } from '@/v2/composables/useV2SessionDraft';
import type { FormValue, OnlineAction, OnlineField, OnlineRow, OnlineSection } from './contracts';
import { initialFields } from './sections';
import { onlineApi } from './api';
import { onlineError } from './labels';
import { importLines, parseImportedCards } from './importInput';
const props = defineProps<{
  modelValue: boolean;
  section: OnlineSection;
  action: OnlineAction;
  row?: OnlineRow;
}>();
const emit = defineEmits<{ 'update:modelValue': [boolean]; saved: [Record<string, unknown>] }>();
const authStore = useAuthStore();
const draft = useV2FormDraft<Record<string, FormValue>>(
  `online-recharge/${props.section}/actions`,
  () => ({})
);
// 安全码、导入卡片、会话和带凭据代理不会进入会话草稿。
const temporary = reactive<Record<string, FormValue>>({});
function clearTemporary() {
  for (const key of Object.keys(temporary)) delete temporary[key];
}
let active = true;
const stopIdentityWatch = sessionCoordinator.subscribeIdentityChange(clearTemporary);
onBeforeUnmount(() => {
  active = false;
  clearTemporary();
  stopIdentityWatch();
});
const busy = ref(false);
const error = ref('');
watch(
  () => [props.modelValue, props.action.key, props.row?.id] as const,
  ([open]) => {
    if (!open) {
      for (const key of Object.keys(temporary)) delete temporary[key];
      return;
    }
    error.value = '';
    const initial = initialFields(props.action.fields);
    for (const field of props.action.fields ?? [])
      if (!field.transient && props.row?.[field.key] !== undefined)
        initial[field.key] = props.row[field.key] as FormValue;
    draft.open(
      `${props.section}/${props.action.key}/${props.row?.id ?? 'new'}`,
      initial,
      props.row?.updatedAt
    );
    for (const field of props.action.fields ?? [])
      if (field.transient) temporary[field.key] = field.initial ?? '';
  },
  { immediate: true }
);
function value(key: string) {
  return temporary[key] ?? draft.form[key] ?? '';
}
function setValue(field: OnlineField, input: FormValue) {
  if (field.transient) temporary[field.key] = input;
  else draft.form[field.key] = input;
}
const invalid = computed(() =>
  (props.action.fields ?? []).some((field) => field.required && !String(value(field.key)).trim())
);
async function loadFile(field: OnlineField, event: Event) {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  target.value = '';
  if (!file) return;
  if (file.size > 1024 * 1024) {
    error.value = '文件不能超过 1 MB';
    return;
  }
  setValue(field, await file.text());
}
function actionBody() {
  const body: Record<string, unknown> = {
    ...Object.fromEntries(
      (props.action.fields ?? []).map((field) => [field.key, value(field.key)])
    ),
    ...(props.row ? { id: props.row.id, version: draft.version.value } : {})
  };
  if (props.action.key === 'import') {
    const lines = importLines(body.text);
    if (props.section === 'cards') body.cards = parseImportedCards(body.text);
    delete body.text;
    if (props.section === 'proxies') body.proxies = lines;
    else if (props.section === 'cdks') body.codes = lines;
    if (!lines.length || lines.length > 500) throw new Error('每次需要导入 1 至 500 条记录');
  }
  if (body.session) {
    try {
      const parsed = JSON.parse(String(body.session));
      if (!parsed || typeof parsed !== 'object' || !parsed.accessToken) throw new Error();
    } catch {
      throw new Error('会话资料需要包含访问凭据的完整 JSON');
    }
  }
  if (body.cvc && !/^\d{3,4}$/.test(String(body.cvc)))
    throw new Error('安全码需要为 3 至 4 位数字');
  return body;
}
async function submit() {
  if (busy.value) return;
  if (invalid.value) {
    error.value = '请填写所有必填字段后重试';
    return;
  }
  busy.value = true;
  error.value = '';
  const completeSave = draft.beginSave();
  const saveOwner = authStore.user?.id;
  const identity = sessionCoordinator.identityEpoch.value;
  const saveKey = `${props.section}/${props.action.key}/${props.row?.id ?? 'new'}`;
  try {
    const result = await onlineApi.action(props.section, props.action.key, actionBody());
    completeSave();
    if (
      !active ||
      identity !== sessionCoordinator.identityEpoch.value ||
      saveOwner !== authStore.user?.id ||
      saveKey !== `${props.section}/${props.action.key}/${props.row?.id ?? 'new'}`
    )
      return;
    emit('saved', result);
    emit('update:modelValue', false);
  } catch (cause) {
    if (!active || identity !== sessionCoordinator.identityEpoch.value) return;
    error.value = onlineError(cause);
  } finally {
    busy.value = false;
  }
}
</script>
