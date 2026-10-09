<template>
  <section v-if="canRead" class="v2-page-layout online-page">
    <V2PageContext description="按原软件保存执行与供应商配置；密钥默认隐藏，留空保留已保存值。"
      ><template #actions
        ><AppButton v-if="canManage" variant="primary" :loading="saving" @click="save"
          >保存配置</AppButton
        ><AppButton variant="ghost" allow-when-stale @click="query.refresh"
          >刷新</AppButton
        ></template
      ></V2PageContext
    >
    <p v-if="message" :role="failure ? 'alert' : 'status'" :class="{ 'online-error': failure }">
      {{ message }}
    </p>
    <V2AsyncRegion
      :phase="query.phase.value"
      :error="query.error.value ? getApiErrorMessage(query.error.value) : ''"
      skeleton="form"
      loading-title="正在加载配置"
      @retry="query.refresh"
    >
      <section v-for="group in visibleGroups" :key="group.key" class="online-panel">
        <V2SectionHeading :title="group.title"
          ><template #actions
            ><AppButton
              v-for="test in canManage ? (group.tests ?? []) : []"
              :key="test.key"
              variant="soft"
              :loading="testing === test.key"
              @click="testConfig(test.key)"
              >{{ test.label }}</AppButton
            ></template
          ></V2SectionHeading
        >
        <el-form
          :disabled="!canManage"
          label-position="left"
          label-width="160px"
          require-asterisk-position="right"
          @submit.prevent="save"
          ><el-form-item
            v-for="field in group.fields"
            :key="field.key"
            :label="field.label"
            :required="field.required"
            ><div class="online-field">
              <el-switch
                v-if="field.type === 'switch'"
                :model-value="Boolean(draft.form[field.key])"
                @update:model-value="draft.form[field.key] = Boolean($event)"
              /><el-input-number
                v-else-if="field.type === 'number'"
                :model-value="Number(draft.form[field.key])"
                :min="field.min"
                :max="field.max"
                @update:model-value="draft.form[field.key] = $event ?? 0"
              /><el-select v-else-if="field.type === 'select'" v-model="draft.form[field.key]"
                ><el-option
                  v-for="option in field.options"
                  :key="option.value"
                  :label="option.label"
                  :value="option.value" /></el-select
              ><el-input
                v-else-if="field.transient"
                v-model="secrets[field.key]"
                type="password"
                show-password
                autocomplete="new-password"
                :placeholder="field.saved ? '已保存，留空保留' : '尚未保存'"
              /><el-input v-else v-model="draft.form[field.key]" autocomplete="off" /><small
                v-if="field.help"
                >{{ field.help }}</small
              >
            </div></el-form-item
          ></el-form
        >
        <p v-if="group.key === 'webhook'" class="online-wrap">
          回调地址：{{ webhookEndpoint }}
          <AppButton size="small" variant="ghost" @click="copyWebhook">复制地址</AppButton>
        </p>
      </section>
    </V2AsyncRegion>
    <OnlineResultDialog v-model="resultOpen" :result="testResult" />
  </section>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { sessionCoordinator } from '@/auth/sessionCoordinator';
import { canUseOnlineAction } from './permissions';
import { getApiErrorMessage } from '@/api/client';
import AppButton from '@/components/ui/AppButton.vue';
import V2PageContext from '@/v2/components/V2PageContext.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import { useV2FormDraft } from '@/v2/composables/useV2SessionDraft';
import { useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { onlineApi, copyOnlineText } from './api';
import { configGroups } from './configFields';
import { onlineError } from './labels';
import { initialFields } from './sections';
import OnlineResultDialog from './OnlineResultDialog.vue';
import type { FormValue } from './contracts';
import './online-recharge.css';
const authStore = useAuthStore();
const canRead = computed(() => canUseOnlineAction(authStore.user, 'config', 'detail'));
const canManage = computed(() => canUseOnlineAction(authStore.user, 'config', 'update'));
const fields = configGroups.flatMap((group) => group.fields);
const draft = useV2FormDraft<Record<string, FormValue>>('online-recharge/config', () =>
  initialFields(fields)
);
const query = useV2ModuleQuery({
  moduleKey: 'online-recharge-config',
  scope: 'online-recharge',
  enabled: () => canUseOnlineAction(authStore.user, 'config', 'detail'),
  key: 'config',
  query: ({ signal }) => onlineApi.config(signal),
  keepPreviousData: true
});
const secrets = reactive<Record<string, string>>({});
const saving = ref(false);
const testing = ref('');
const message = ref('');
const failure = ref(false);
const resultOpen = ref(false);
const testResult = ref<Record<string, unknown>>({});
watch(
  query.data,
  (data) => {
    if (data) {
      const clean = Object.fromEntries(
        fields
          .filter((field) => !field.transient && data[field.key] !== undefined)
          .map((field) => [field.key, data[field.key] as FormValue])
      );
      draft.open('settings', clean, String(data.version ?? 0));
    }
  },
  { immediate: true }
);
const webhookEndpoint = computed(
  () => `${window.location.origin}/api/id-business-v2/online-recharge/webhooks/card-issue`
);
function secretSaved(key: string) {
  const flags = query.data.value?.secretStatus ?? query.data.value?.secretKeysSaved ?? {};
  return Boolean((flags as Record<string, unknown>)[key] ?? query.data.value?.[`${key}Saved`]);
}
const visibleGroups = computed(() =>
  configGroups.map((group) => ({
    ...group,
    fields: group.fields.map((field) => ({ ...field, saved: secretSaved(field.key) }))
  }))
);
function clearSecrets() {
  for (const key of Object.keys(secrets)) delete secrets[key];
}
let active = true;
const stopIdentityWatch = sessionCoordinator.subscribeIdentityChange(() => {
  clearSecrets();
  resultOpen.value = false;
  testResult.value = {};
  message.value = '';
});
onBeforeUnmount(clearSecrets);
onBeforeUnmount(() => {
  active = false;
  stopIdentityWatch();
});
async function save() {
  if (saving.value) return;
  saving.value = true;
  message.value = '';
  const finish = draft.beginSave();
  const identity = sessionCoordinator.identityEpoch.value;
  const submittedSecrets = { ...secrets };
  try {
    const values = {
      ...draft.form,
      ...Object.fromEntries(Object.entries(secrets).filter(([, value]) => value.trim())),
      version: Number(draft.version.value ?? 0)
    };
    await onlineApi.saveConfig(values);
    finish();
    if (!active || identity !== sessionCoordinator.identityEpoch.value) return;
    for (const [key, value] of Object.entries(submittedSecrets))
      if (secrets[key] === value) delete secrets[key];
    message.value = '配置已保存';
    failure.value = false;
    await query.refresh();
  } catch (cause) {
    if (!active || identity !== sessionCoordinator.identityEpoch.value) return;
    failure.value = true;
    message.value = onlineError(cause);
  } finally {
    saving.value = false;
  }
}
async function testConfig(target: string) {
  if (testing.value) return;
  testing.value = target;
  message.value = '';
  try {
    testResult.value = await onlineApi.action('config', 'test', { target });
    resultOpen.value = true;
    failure.value = false;
    message.value = String(testResult.value.message ?? '测试任务已提交，请在任务管理查看结果');
  } catch (cause) {
    failure.value = true;
    message.value = onlineError(cause);
  } finally {
    testing.value = '';
  }
}
async function copyWebhook() {
  try {
    await copyOnlineText(webhookEndpoint.value);
    message.value = '回调地址已复制';
    failure.value = false;
  } catch {
    failure.value = true;
    message.value = '复制失败，请手动选择地址';
  }
}
</script>
