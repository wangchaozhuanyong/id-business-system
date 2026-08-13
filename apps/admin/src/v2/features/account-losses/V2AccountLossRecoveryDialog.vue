<template>
  <V2ConfirmDialog
    :model-value="page.recoveryDialogVisible"
    title="恢复报损 ID"
    message=""
    width="min(600px, 92vw)"
    confirm-text="恢复 ID 并冲回损耗"
    :confirm-loading="page.recoverySubmitting"
    :confirm-disabled-reason="disabledReason"
    :dirty="Boolean(page.recoveryReason.trim())"
    @update:model-value="page.setRecoveryDialogVisible"
    @confirm="confirm"
  >
    <div v-if="page.recoveryTarget" class="v2-account-loss-recovery">
      <V2DetailSummary
        heading-id="account-loss-recovery-summary"
        eyebrow="报损冲回"
        :title="page.recoveryTarget.appleIdMasked"
        description="恢复后回到可用分类，原报损记录和审计证据仍会保留"
        :metrics="[
          {
            label: '恢复余额',
            value: `${page.formatDecimal(page.recoveryTarget.lossBalance)} ${page.recoveryTarget.currencyCode || ''}`
          },
          {
            label: '冲回损耗',
            value: `¥${page.formatDecimal(page.recoveryTarget.lossCostAmount)}`,
            tone: 'positive'
          }
        ]"
      />
      <el-alert
        type="info"
        title="恢复后 ID 回到可用分类；原报损记录不会删除，并新增财务冲回记录。"
        :closable="false"
        show-icon
      />
      <el-form
        ref="formRef"
        class="v2-horizontal-form"
        :model="formModel"
        :rules="rules"
        label-position="left"
        label-width="88px"
        require-asterisk-position="right"
        status-icon
      >
        <V2PanelSection heading-id="account-loss-recovery-reason" title="恢复依据" step="01">
          <el-form-item label="恢复原因" prop="reason">
            <el-input
              :model-value="page.recoveryReason"
              type="textarea"
              :rows="3"
              minlength="2"
              maxlength="500"
              show-word-limit
              placeholder="说明 ID 已恢复、可继续使用的核对依据"
              @update:model-value="page.setRecoveryReason"
            />
          </el-form-item>
        </V2PanelSection>
      </el-form>
    </div>
  </V2ConfirmDialog>
</template>

<script setup lang="ts">
import { computed, ref, type UnwrapNestedRefs } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
import V2ConfirmDialog from '@/v2/components/V2ConfirmDialog.vue';
import V2DetailSummary from '@/v2/components/V2DetailSummary.vue';
import V2PanelSection from '@/v2/components/V2PanelSection.vue';
import { validateV2Form } from '@/v2/utils/formValidation';
import type { useAccountLossesPage } from './useAccountLossesPage';

type AccountLossesPage = UnwrapNestedRefs<ReturnType<typeof useAccountLossesPage>>;

const props = defineProps<{ page: AccountLossesPage }>();
const formRef = ref<FormInstance>();
const formModel = computed(() => ({ reason: props.page.recoveryReason }));
const rules: FormRules = {
  reason: [
    {
      required: true,
      validator: (_rule, value, callback) =>
        callback(
          String(value ?? '').trim().length >= 2 && String(value ?? '').trim().length <= 500
            ? undefined
            : new Error('恢复原因必须为 2 至 500 个字符')
        ),
      trigger: 'blur'
    }
  ]
};
const disabledReason = computed(() => {
  if (!props.page.canRecover) return '当前账号无恢复报损 ID 的权限';
  if (!props.page.recoveryTarget) return '未选择需要恢复的 ID';
  if (props.page.recoveryTarget.status !== 'active') return '该报损记录已经冲回';
  return '';
});

async function confirm() {
  if (disabledReason.value || !(await validateV2Form(formRef.value))) return;
  await props.page.confirmRecovery();
}
</script>

<style scoped>
.v2-account-loss-recovery {
  display: grid;
  gap: 16px;
}
</style>
