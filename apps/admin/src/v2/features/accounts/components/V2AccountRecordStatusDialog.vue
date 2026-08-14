<template>
  <V2ConfirmDialog
    v-model="page.recordStatusDialogVisible"
    :title="dialogTitle"
    message=""
    width="min(500px, 92vw)"
    :cancel-text="page.recordStatusDialogMode === 'view' ? '关闭' : '取消'"
    :confirm-text="page.targetRecordStatus === 'disabled' ? '确认停用' : '确认启用'"
    :confirm-visible="page.recordStatusDialogMode === 'change'"
    :danger="page.targetRecordStatus === 'disabled'"
    :confirm-loading="page.recordStatusSubmitting"
    :dirty="Boolean(page.recordStatusReason.trim())"
    @confirm="confirmChange"
  >
    <V2DetailSummary
      v-if="page.recordStatusTarget"
      heading-id="account-status-summary"
      :eyebrow="page.recordStatusDialogMode === 'view' ? '停用记录' : '状态变更对象'"
      :title="page.recordStatusTarget.displayAppleId ?? ''"
      :description="
        page.recordStatusDialogMode === 'view'
          ? page.recordStatusTarget.disabledReason || '历史记录未填写原因'
          : page.targetRecordStatus === 'disabled'
            ? '停用后不能继续用于下单、续费或加卡'
            : '启用后恢复进入可用 ID 范围'
      "
      :facts="
        page.recordStatusDialogMode === 'view' ? [{ label: '停用时间', value: disabledAtText }] : []
      "
    />

    <el-form
      v-if="page.recordStatusDialogMode === 'change'"
      ref="formRef"
      class="v2-horizontal-form"
      :model="formModel"
      :rules="rules"
      label-position="left"
      label-width="92px"
      require-asterisk-position="right"
      status-icon
    >
      <V2PanelSection heading-id="account-status-reason" title="变更依据" step="01">
        <el-form-item
          :label="page.targetRecordStatus === 'disabled' ? '停用原因' : '启用原因'"
          prop="reason"
        >
          <el-input
            v-model="page.recordStatusReason"
            type="textarea"
            :rows="4"
            maxlength="200"
            show-word-limit
            :placeholder="
              page.targetRecordStatus === 'disabled'
                ? '说明为什么暂停使用该 ID'
                : '说明本次恢复启用的核对结果'
            "
          />
        </el-form-item>
      </V2PanelSection>
    </el-form>
  </V2ConfirmDialog>
</template>

<script setup lang="ts">
import { computed, ref, type UnwrapNestedRefs } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
import V2ConfirmDialog from '@/v2/components/V2ConfirmDialog.vue';
import V2DetailSummary from '@/v2/components/V2DetailSummary.vue';
import V2PanelSection from '@/v2/components/V2PanelSection.vue';
import { validateV2Form } from '@/v2/utils/formValidation';
import type { useAccountsPage } from '../useAccountsPage';

type AccountsPage = UnwrapNestedRefs<ReturnType<typeof useAccountsPage>>;

const props = defineProps<{ page: AccountsPage }>();
const formRef = ref<FormInstance>();
const formModel = computed(() => ({ reason: props.page.recordStatusReason }));
const rules: FormRules = {
  reason: [
    {
      required: true,
      validator: (_rule, value, callback) => {
        const length = String(value ?? '').trim().length;
        callback(
          length >= 2 && length <= 200 ? undefined : new Error('原因必须为 2 至 200 个字符')
        );
      },
      trigger: 'blur'
    }
  ]
};

const dialogTitle = computed(() => {
  if (props.page.recordStatusDialogMode === 'view') return '停用资料';
  return props.page.targetRecordStatus === 'disabled' ? '停用 ID' : '恢复启用 ID';
});

const disabledAtText = computed(() => {
  const value = props.page.recordStatusTarget?.disabledAt;
  return value
    ? new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        dateStyle: 'medium',
        timeStyle: 'short'
      }).format(new Date(value))
    : '—';
});

async function confirmChange() {
  if (props.page.recordStatusDialogMode === 'view') {
    props.page.recordStatusDialogVisible = false;
    return;
  }
  if (!(await validateV2Form(formRef.value))) return;
  await props.page.confirmRecordStatusChange();
}
</script>
