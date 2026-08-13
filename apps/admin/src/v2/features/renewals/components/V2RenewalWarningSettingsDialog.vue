<template>
  <V2FormDrawer
    v-model="visible"
    title="续费到期预警设置"
    size="min(480px, 92vw)"
    eyebrow="工作台提醒"
    description="控制全局到期预警窗口，不改变实际续费资格规则"
    confirm-text="保存设置"
    :confirm-loading="saving"
    :confirm-disabled-reason="disabledReason"
    :dirty="dirty"
    @confirm="confirm"
  >
    <el-alert
      type="info"
      :closable="false"
      show-icon
      title="此设置全局生效"
      :description="`设为 ${warningDays} 天后，工作台和右上角提醒会显示未来 ${warningDays} 天内到期的记录；已到期记录会单独统计。`"
    />
    <el-form
      ref="formRef"
      class="v2-renewal-warning-settings v2-horizontal-form"
      :model="formModel"
      :rules="rules"
      label-position="left"
      label-width="116px"
      require-asterisk-position="right"
      status-icon
      scroll-to-error
      :scroll-into-view-options="{ behavior: 'smooth', block: 'center' }"
    >
      <p v-if="loading" class="v2-renewal-warning-settings__state">正在读取当前设置…</p>
      <el-alert v-else-if="error" type="error" :closable="false" show-icon :title="error" />
      <V2PanelSection
        v-else
        heading-id="renewal-warning-window"
        title="提醒窗口"
        step="01"
        help="实际录入续费仍只允许处理 7 天内到期或已到期记录"
      >
        <el-form-item label="提前预警天数" prop="warningDays">
          <el-input-number
            v-model="warningDays"
            :min="settings.minWarningDays"
            :max="settings.maxWarningDays"
            :step="1"
            step-strictly
            controls-position="right"
            aria-label="提前预警天数"
          />
        </el-form-item>
        <small>可设置 {{ settings.minWarningDays }}–{{ settings.maxWarningDays }} 天。</small>
      </V2PanelSection>
    </el-form>
  </V2FormDrawer>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import V2PanelSection from '@/v2/components/V2PanelSection.vue';
import { validateV2Form } from '@/v2/utils/formValidation';
import type { V2RenewalWarningSettings } from '../contracts';

const props = defineProps<{
  settings: V2RenewalWarningSettings;
  loading: boolean;
  saving: boolean;
  error: string;
  canManage: boolean;
}>();

const emit = defineEmits<{
  save: [];
}>();

const visible = defineModel<boolean>({ required: true });
const warningDays = defineModel<number>('warningDays', { required: true });
const baselineWarningDays = ref(warningDays.value);
const formRef = ref<FormInstance>();
const formModel = computed(() => ({ warningDays: warningDays.value }));
const rules = computed<FormRules>(() => ({
  warningDays: [
    { required: true, message: '请输入提前预警天数', trigger: 'change' },
    {
      validator: (_rule, value, callback) =>
        callback(
          Number.isInteger(value) &&
            value >= props.settings.minWarningDays &&
            value <= props.settings.maxWarningDays
            ? undefined
            : new Error(
                `请输入 ${props.settings.minWarningDays} 到 ${props.settings.maxWarningDays} 的整数天数`
              )
        ),
      trigger: 'change'
    }
  ]
}));
const disabledReason = computed(() => {
  if (!props.canManage) return '当前账号无续费预警设置权限';
  if (props.loading) return '正在读取当前预警设置';
  if (props.error) return '预警设置加载失败，请先重试';
  return '';
});
const dirty = computed(
  () => visible.value && !props.loading && warningDays.value !== baselineWarningDays.value
);

watch(
  [visible, () => props.loading],
  ([isVisible, isLoading]) => {
    if (isVisible && !isLoading) baselineWarningDays.value = warningDays.value;
  },
  { flush: 'post' }
);

async function confirm() {
  if (disabledReason.value || !(await validateV2Form(formRef.value))) return;
  emit('save');
}
</script>
