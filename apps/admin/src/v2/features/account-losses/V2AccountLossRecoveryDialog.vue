<template>
  <V2ConfirmDialog
    :model-value="page.recoveryDialogVisible"
    title="恢复报损 ID"
    message=""
    confirm-text="恢复 ID 并冲回损耗"
    :confirm-loading="page.recoverySubmitting"
    :confirm-disabled-reason="disabledReason"
    @update:model-value="page.setRecoveryDialogVisible"
    @confirm="confirm"
  >
    <div v-if="page.recoveryTarget" class="v2-account-loss-recovery">
      <dl>
        <div>
          <dt>ID 账号</dt>
          <dd>{{ page.recoveryTarget.appleIdMasked }}</dd>
        </div>
        <div>
          <dt>恢复余额</dt>
          <dd>
            {{ page.formatDecimal(page.recoveryTarget.lossBalance) }}
            {{ page.recoveryTarget.currencyCode || '' }}
          </dd>
        </div>
        <div>
          <dt>冲回损耗</dt>
          <dd>¥{{ page.formatDecimal(page.recoveryTarget.lossCostAmount) }}</dd>
        </div>
      </dl>
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
      </el-form>
    </div>
  </V2ConfirmDialog>
</template>

<script setup lang="ts">
import { computed, ref, type UnwrapNestedRefs } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
import V2ConfirmDialog from '@/v2/components/V2ConfirmDialog.vue';
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

.v2-account-loss-recovery dl {
  display: grid;
  margin: 0;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.v2-account-loss-recovery dl > div {
  display: grid;
  min-width: 0;
  gap: 6px;
  padding: 12px;
  border: 1px solid var(--v2-border-soft);
  border-radius: 12px;
  background: var(--v2-surface-raised);
}

.v2-account-loss-recovery dt {
  color: var(--v2-text-soft);
  font-size: 12px;
}

.v2-account-loss-recovery dd {
  margin: 0;
  overflow-wrap: anywhere;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

@media (max-width: 680px) {
  .v2-account-loss-recovery dl {
    grid-template-columns: 1fr;
  }
}
</style>
