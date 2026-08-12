<template>
  <V2ConfirmDialog
    v-model="page.lossDialogVisible"
    title="报损冻结 ID"
    message=""
    confirm-text="确认报损冻结"
    danger
    :confirm-loading="page.lossSubmitting"
    :confirm-disabled-reason="lossDisabledReason"
    @confirm="reportLoss"
  >
    <div v-if="page.lossTarget" class="v2-account-loss-dialog">
      <dl>
        <div>
          <dt>ID 账号</dt>
          <dd>{{ page.lossTarget.appleIdMasked }}</dd>
        </div>
        <div>
          <dt>损失余额</dt>
          <dd>{{ page.formatDecimal(page.lossTarget.currentBalance) }}</dd>
        </div>
        <div>
          <dt>人民币亏损</dt>
          <dd>¥{{ page.formatDecimal(page.lossTarget.balanceCostAmount) }}</dd>
        </div>
      </dl>
      <el-alert
        type="warning"
        :title="
          page.lossTarget.saleState === 'sold'
            ? '已售 ID 报损只核销剩余余额成本，ID 采购成本为 0，原销售归属保持不变。'
            : '报损后 ID 将显示为已报损冻结，当前余额成本和未售 ID 采购成本计入损耗。'
        "
        :closable="false"
        show-icon
      />
      <el-form
        ref="lossFormRef"
        class="v2-horizontal-form"
        :model="lossFormModel"
        :rules="lossRules"
        label-position="left"
        label-width="88px"
        require-asterisk-position="right"
        status-icon
        scroll-to-error
        :scroll-into-view-options="{ behavior: 'smooth', block: 'center' }"
      >
        <el-form-item label="报损原因" prop="reason">
          <el-input
            v-model="page.lossReason"
            type="textarea"
            :rows="3"
            minlength="2"
            maxlength="500"
            show-word-limit
            placeholder="说明 ID 死亡、冻结或无法继续使用的原因"
          />
        </el-form-item>
        <el-form-item label="冻结确认" prop="confirmed">
          <el-checkbox v-model="page.lossConfirmed">
            我确认冻结该 ID 并把当前余额与人民币成本计入损耗
          </el-checkbox>
        </el-form-item>
      </el-form>
    </div>
  </V2ConfirmDialog>

  <V2ConfirmDialog
    v-model="page.unfreezeDialogVisible"
    title="解除报损冻结"
    message=""
    confirm-text="解除冻结并冲回"
    :confirm-loading="page.unfreezeSubmitting"
    :confirm-disabled-reason="unfreezeDisabledReason"
    @confirm="unfreezeLoss"
  >
    <div v-if="page.unfreezeTarget" class="v2-account-loss-dialog">
      <dl>
        <div>
          <dt>ID 账号</dt>
          <dd>{{ page.unfreezeTarget.appleIdMasked }}</dd>
        </div>
        <div>
          <dt>恢复余额</dt>
          <dd>{{ page.formatDecimal(page.unfreezeTarget.currentBalance) }}</dd>
        </div>
        <div>
          <dt>冲回损耗</dt>
          <dd>¥{{ page.formatDecimal(page.unfreezeTarget.balanceCostAmount) }}</dd>
        </div>
      </dl>
      <el-alert
        type="info"
        title="解除后 ID 恢复可用状态，并生成反向财务流水冲回损耗；历史开通记录不会自动恢复。"
        :closable="false"
        show-icon
      />
      <el-form
        ref="unfreezeFormRef"
        class="v2-horizontal-form"
        :model="unfreezeFormModel"
        :rules="unfreezeRules"
        label-position="left"
        label-width="88px"
        require-asterisk-position="right"
        status-icon
        scroll-to-error
        :scroll-into-view-options="{ behavior: 'smooth', block: 'center' }"
      >
        <el-form-item label="解除原因" prop="reason">
          <el-input
            v-model="page.unfreezeReason"
            type="textarea"
            :rows="3"
            minlength="2"
            maxlength="500"
            show-word-limit
            placeholder="说明该 ID 已恢复可继续使用的原因"
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
import type { useAccountsPage } from '../useAccountsPage';

type AccountsPage = UnwrapNestedRefs<ReturnType<typeof useAccountsPage>>;

const props = defineProps<{
  page: AccountsPage;
}>();

const lossFormRef = ref<FormInstance>();
const unfreezeFormRef = ref<FormInstance>();
const lossFormModel = computed(() => ({
  reason: props.page.lossReason,
  confirmed: props.page.lossConfirmed
}));
const unfreezeFormModel = computed(() => ({
  reason: props.page.unfreezeReason
}));
const lossRules: FormRules = {
  reason: [
    {
      required: true,
      validator: (_rule, value, callback) => {
        const normalized = String(value ?? '').trim();
        callback(
          normalized.length >= 2 && normalized.length <= 500
            ? undefined
            : new Error('报损原因必须为 2 至 500 个字符')
        );
      },
      trigger: 'blur'
    }
  ],
  confirmed: [
    {
      validator: (_rule, value, callback) =>
        callback(value === true ? undefined : new Error('请确认报损冻结和损耗入账影响')),
      trigger: 'change'
    }
  ]
};
const unfreezeRules: FormRules = {
  reason: [
    {
      required: true,
      validator: (_rule, value, callback) => {
        const normalized = String(value ?? '').trim();
        callback(
          normalized.length >= 2 && normalized.length <= 500
            ? undefined
            : new Error('解除原因必须为 2 至 500 个字符')
        );
      },
      trigger: 'blur'
    }
  ]
};
const lossDisabledReason = computed(() => {
  if (!props.page.canReportLoss) return '当前账号无报损冻结权限';
  if (!props.page.lossTarget) return '未选择需要报损的 ID';
  if (props.page.lossTarget.lossStatus === 'reported') return '该 ID 已报损冻结';
  return '';
});
const unfreezeDisabledReason = computed(() => {
  if (!props.page.canReportLoss) return '当前账号无解除报损冻结权限';
  if (!props.page.unfreezeTarget) return '未选择需要解除冻结的 ID';
  if (props.page.unfreezeTarget.lossStatus !== 'reported') return '该 ID 当前未报损冻结';
  if (!props.page.unfreezeTarget.activeLossId) return '该 ID 缺少当前报损记录，请刷新后重试';
  return '';
});

async function reportLoss() {
  if (lossDisabledReason.value || !(await validateV2Form(lossFormRef.value))) return;
  await props.page.confirmReportLoss();
}

async function unfreezeLoss() {
  if (unfreezeDisabledReason.value || !(await validateV2Form(unfreezeFormRef.value))) return;
  await props.page.confirmUnfreezeLoss();
}
</script>

<style scoped>
.v2-account-loss-dialog {
  display: grid;
  gap: 16px;
}

.v2-account-loss-dialog dl {
  display: grid;
  margin: 0;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.v2-account-loss-dialog dl > div {
  display: grid;
  min-width: 0;
  gap: 6px;
  padding: 12px;
  border: 1px solid var(--v2-border-soft);
  border-radius: 12px;
  background: var(--v2-surface-raised);
}

.v2-account-loss-dialog dt {
  color: var(--v2-text-soft);
  font-size: 12px;
}

.v2-account-loss-dialog dd {
  margin: 0;
  overflow-wrap: anywhere;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

@media (max-width: 680px) {
  .v2-account-loss-dialog dl {
    grid-template-columns: 1fr;
  }
}
</style>
