<template>
  <V2ConfirmDialog
    v-model="page.lossDialogVisible"
    title="报损冻结 ID"
    message=""
    width="min(600px, calc(100vw - 32px))"
    confirm-text="确认报损冻结"
    danger
    :dirty="Boolean(page.lossReason.trim() || page.lossConfirmed)"
    :confirm-loading="page.lossSubmitting"
    :confirm-disabled-reason="lossDisabledReason"
    @confirm="reportLoss"
  >
    <div v-if="page.lossTarget" class="v2-account-loss-dialog">
      <section class="v2-account-loss-dialog__summary" aria-labelledby="loss-summary-heading">
        <header>
          <span>报损对象</span>
          <strong id="loss-summary-heading">{{ page.lossTarget.appleIdMasked }}</strong>
          <small>提交后该 ID 将被冻结，不能继续下单、续费或加卡</small>
        </header>
        <dl class="v2-account-loss-dialog__impact">
          <div>
            <dt>损失余额</dt>
            <dd>{{ page.formatDecimal(page.lossTarget.currentBalance) }}</dd>
          </div>
          <div>
            <dt>计入人民币损耗</dt>
            <dd>¥{{ page.formatDecimal(page.lossTarget.balanceCostAmount) }}</dd>
          </div>
        </dl>
      </section>
      <el-alert
        class="v2-account-loss-dialog__alert"
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
        class="v2-account-loss-dialog__form v2-horizontal-form"
        :model="lossFormModel"
        :rules="lossRules"
        label-position="left"
        label-width="88px"
        require-asterisk-position="right"
        status-icon
        scroll-to-error
        :scroll-into-view-options="{ behavior: 'smooth', block: 'center' }"
      >
        <section class="v2-account-loss-dialog__section" aria-labelledby="loss-reason-heading">
          <header class="v2-account-loss-dialog__section-heading">
            <span>01</span>
            <h3 id="loss-reason-heading">填写报损原因</h3>
          </header>
          <el-form-item label="报损原因" prop="reason">
            <el-input
              v-model="page.lossReason"
              type="textarea"
              :rows="4"
              minlength="2"
              maxlength="500"
              show-word-limit
              placeholder="说明 ID 死亡、冻结或无法继续使用的原因"
            />
          </el-form-item>
        </section>
        <section class="v2-account-loss-dialog__section" aria-labelledby="loss-confirm-heading">
          <header class="v2-account-loss-dialog__section-heading">
            <span>02</span>
            <h3 id="loss-confirm-heading">确认损耗影响</h3>
          </header>
          <el-form-item
            class="v2-account-loss-dialog__confirmation"
            label="冻结确认"
            prop="confirmed"
          >
            <el-checkbox v-model="page.lossConfirmed">
              我确认冻结该 ID，并将上述余额与人民币成本计入损耗
            </el-checkbox>
          </el-form-item>
        </section>
      </el-form>
    </div>
  </V2ConfirmDialog>

  <V2ConfirmDialog
    v-model="page.unfreezeDialogVisible"
    title="解除报损冻结"
    message=""
    width="min(600px, calc(100vw - 32px))"
    confirm-text="解除冻结并冲回"
    :confirm-loading="page.unfreezeSubmitting"
    :dirty="Boolean(page.unfreezeReason.trim())"
    :confirm-disabled-reason="unfreezeDisabledReason"
    @confirm="unfreezeLoss"
  >
    <div v-if="page.unfreezeTarget" class="v2-account-loss-dialog">
      <section class="v2-account-loss-dialog__summary" aria-labelledby="unfreeze-summary-heading">
        <header>
          <span>解除对象</span>
          <strong id="unfreeze-summary-heading">{{ page.unfreezeTarget.appleIdMasked }}</strong>
          <small>解除后恢复可用状态，历史开通记录保持不变</small>
        </header>
        <dl class="v2-account-loss-dialog__impact">
          <div>
            <dt>恢复余额</dt>
            <dd>{{ page.formatDecimal(page.unfreezeTarget.currentBalance) }}</dd>
          </div>
          <div>
            <dt>冲回人民币损耗</dt>
            <dd>¥{{ page.formatDecimal(page.unfreezeTarget.balanceCostAmount) }}</dd>
          </div>
        </dl>
      </section>
      <el-alert
        class="v2-account-loss-dialog__alert"
        type="info"
        title="解除后 ID 恢复可用状态，并生成反向财务流水冲回损耗；历史开通记录不会自动恢复。"
        :closable="false"
        show-icon
      />
      <el-form
        ref="unfreezeFormRef"
        class="v2-account-loss-dialog__form v2-horizontal-form"
        :model="unfreezeFormModel"
        :rules="unfreezeRules"
        label-position="left"
        label-width="88px"
        require-asterisk-position="right"
        status-icon
        scroll-to-error
        :scroll-into-view-options="{ behavior: 'smooth', block: 'center' }"
      >
        <section class="v2-account-loss-dialog__section" aria-labelledby="unfreeze-reason-heading">
          <header class="v2-account-loss-dialog__section-heading">
            <span>01</span>
            <h3 id="unfreeze-reason-heading">填写解除原因</h3>
          </header>
          <el-form-item label="解除原因" prop="reason">
            <el-input
              v-model="page.unfreezeReason"
              type="textarea"
              :rows="4"
              minlength="2"
              maxlength="500"
              show-word-limit
              placeholder="说明该 ID 已恢复可继续使用的原因"
            />
          </el-form-item>
        </section>
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
  min-width: 0;
  gap: 14px;
}

.v2-account-loss-dialog__summary {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(0, 1.2fr) minmax(220px, 0.8fr);
  align-items: stretch;
  overflow: hidden;
  border: 1px solid var(--v2-border);
  border-radius: var(--v3-radius);
  background: var(--v2-surface-muted);
}

.v2-account-loss-dialog__summary > header {
  display: grid;
  min-width: 0;
  align-content: center;
  gap: 3px;
  padding: 17px 18px;
}

.v2-account-loss-dialog__summary > header span,
.v2-account-loss-dialog__summary > header small,
.v2-account-loss-dialog__impact dt {
  color: var(--v2-text-soft);
  font-size: 11px;
  line-height: 1.45;
}

.v2-account-loss-dialog__summary > header strong {
  color: var(--v2-text);
  overflow-wrap: anywhere;
  font-size: 17px;
  font-weight: var(--v3-font-weight-bold);
  line-height: 1.35;
}

.v2-account-loss-dialog__impact {
  display: grid;
  min-width: 0;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  margin: 0;
  border-left: 1px solid var(--v2-border-soft);
}

.v2-account-loss-dialog__impact > div {
  display: grid;
  min-width: 0;
  align-content: center;
  gap: 3px;
  padding: 14px 16px;
  border-left: 1px solid var(--v2-border-soft);
}

.v2-account-loss-dialog__impact > div:first-child {
  border-left: 0;
}

.v2-account-loss-dialog__impact dd {
  margin: 0;
  color: var(--v2-text);
  overflow-wrap: anywhere;
  font-variant-numeric: tabular-nums;
  font-size: 18px;
  font-weight: var(--v3-font-weight-bold);
  line-height: 1.3;
}

.v2-account-loss-dialog__alert {
  min-width: 0;
}

.v2-account-loss-dialog__form {
  display: grid;
  min-width: 0;
  gap: 0;
}

.v2-account-loss-dialog__section {
  display: grid;
  min-width: 0;
  gap: 12px;
  padding: 17px 0 16px;
  border-top: 1px solid var(--v2-border-soft);
}

.v2-account-loss-dialog__section:first-child {
  padding-top: 2px;
  border-top: 0;
}

.v2-account-loss-dialog__section:last-child {
  padding-bottom: 0;
}

.v2-account-loss-dialog__section-heading {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 9px;
}

.v2-account-loss-dialog__section-heading > span {
  display: inline-grid;
  width: 26px;
  height: 22px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 4px;
  background: var(--v2-accent-soft);
  color: var(--v2-accent);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  font-weight: var(--v3-font-weight-bold);
}

.v2-account-loss-dialog__section-heading h3 {
  margin: 0;
  color: var(--v2-text);
  font-size: 14px;
  font-weight: var(--v3-font-weight-bold);
  line-height: 1.4;
}

.v2-account-loss-dialog__section .el-form-item {
  margin-bottom: 0;
}

.v2-account-loss-dialog__section .el-form-item.is-error {
  margin-bottom: 21px;
}

.v2-account-loss-dialog__confirmation :deep(.el-form-item__content) {
  min-width: 0;
  min-height: 42px;
  align-items: center;
  padding: 8px 12px;
  border: 1px solid var(--v2-border-soft);
  border-radius: var(--v3-radius-sm);
  background: var(--v2-surface-muted);
}

.v2-account-loss-dialog__confirmation :deep(.el-checkbox) {
  width: 100%;
  height: auto;
  min-width: 0;
  align-items: flex-start;
  white-space: normal;
}

.v2-account-loss-dialog__confirmation :deep(.el-checkbox__input) {
  flex: 0 0 auto;
  margin-top: 2px;
}

.v2-account-loss-dialog__confirmation :deep(.el-checkbox__label) {
  min-width: 0;
  padding-left: 8px;
  color: var(--v2-text);
  line-height: 1.55;
  white-space: normal;
}

@media (max-width: 680px) {
  .v2-account-loss-dialog__summary {
    grid-template-columns: 1fr;
  }

  .v2-account-loss-dialog__impact {
    border-top: 1px solid var(--v2-border-soft);
    border-left: 0;
  }

  .v2-account-loss-dialog__summary > header,
  .v2-account-loss-dialog__impact > div {
    padding: 13px 14px;
  }

  .v2-account-loss-dialog__section .el-form-item {
    display: grid;
    grid-template-columns: minmax(78px, 88px) minmax(0, 1fr);
  }

  .v2-account-loss-dialog__section .el-form-item__label {
    width: auto !important;
  }
}
</style>
