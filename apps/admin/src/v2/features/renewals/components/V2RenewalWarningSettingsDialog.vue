<template>
  <el-dialog
    v-model="visible"
    title="续费到期预警设置"
    width="min(460px, 92vw)"
    :close-on-click-modal="!saving"
    :close-on-press-escape="!saving"
  >
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
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="此设置全局生效"
        :description="`设为 ${warningDays} 天后，工作台和右上角提醒会显示未来 ${warningDays} 天内到期的记录；已到期记录会单独统计。`"
      />
      <p v-if="loading" class="v2-renewal-warning-settings__state">正在读取当前设置…</p>
      <el-alert v-else-if="error" type="error" :closable="false" show-icon :title="error" />
      <el-form-item v-else label="提前预警天数" prop="warningDays">
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
      <small>
        可设置 {{ settings.minWarningDays }}–{{ settings.maxWarningDays }} 天。
        实际录入续费仍只允许处理 7 天内到期或已到期记录。
      </small>
    </el-form>
    <template #footer>
      <span v-if="disabledReason" class="v2-submit-disabled-reason" role="status">
        {{ disabledReason }}
      </span>
      <AppButton variant="ghost" :disabled="saving" @click="visible = false">取消</AppButton>
      <AppButton
        variant="primary"
        :loading="saving"
        :disabled="Boolean(disabledReason)"
        :aria-label="disabledReason ? `保存设置：${disabledReason}` : '保存设置'"
        @click="confirm"
      >
        保存设置
      </AppButton>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
import AppButton from '@/components/ui/AppButton.vue';
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

async function confirm() {
  if (disabledReason.value || !(await validateV2Form(formRef.value))) return;
  emit('save');
}
</script>
