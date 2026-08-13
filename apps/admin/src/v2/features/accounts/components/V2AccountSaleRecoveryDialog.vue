<template>
  <el-dialog
    v-model="page.saleRecoveryDialogVisible"
    title="纠正 ID 售出记录"
    width="min(520px, 92vw)"
    destroy-on-close
    :close-on-click-modal="!page.saleRecoverySubmitting"
    :close-on-press-escape="!page.saleRecoverySubmitting"
    :show-close="!page.saleRecoverySubmitting"
    :before-close="beforeClose"
  >
    <V2DetailSummary
      v-if="page.saleRecoveryTarget"
      heading-id="account-sale-recovery-summary"
      eyebrow="售出误操作纠正"
      :title="page.saleRecoveryTarget.appleIdMasked"
      :description="`来源订单 ${page.saleRecoveryTarget.soldByOrder?.orderNo || '—'}`"
      :facts="
        page.saleRecoveryPreview
          ? [
              { label: '当前余额', value: page.saleRecoveryPreview.currentBalance },
              { label: '余额成本', value: page.saleRecoveryPreview.balanceCostAmount },
              {
                label: '关联业务',
                value: `${page.saleRecoveryPreview.counts.pendingAfterSalesOrders} 单`
              },
              {
                label: '条件检查',
                value: page.saleRecoveryPreview.canRecover ? '允许纠正' : '暂不可纠正'
              }
            ]
          : []
      "
    />
    <el-alert
      type="warning"
      title="仅用于纠正员工误将 ID 标记为已售出的情况。本操作不退客户款、不改变来源订单业务状态；当前余额、余额成本和 ID 采购成本原值均保留。"
      :closable="false"
      show-icon
    />
    <el-alert
      v-if="
        page.saleRecoveryPreview &&
        (page.saleRecoveryPreview.counts.pendingAfterSalesOrders > 0 ||
          page.saleRecoveryPreview.counts.activeActivations > 0 ||
          page.saleRecoveryPreview.counts.activeLocks > 0)
      "
      type="info"
      title="关联的历史订单、有效业务和业务锁将保持原状，不影响本次售出纠正"
      :closable="false"
      show-icon
    />
    <div v-if="page.saleRecoveryLoading" class="v2-account-sale-recovery-state">
      正在检查纠正条件…
    </div>
    <el-alert
      v-else-if="page.saleRecoveryError"
      type="error"
      title="纠正条件检查失败"
      :description="page.saleRecoveryError"
      :closable="false"
      show-icon
    />
    <el-alert
      v-else-if="page.saleRecoveryPreview && !page.saleRecoveryPreview.canRecover"
      type="error"
      title="当前不能纠正售出记录"
      :description="page.saleRecoveryPreview.blockers.map((item) => item.message).join('；')"
      :closable="false"
      show-icon
    />
    <el-form
      ref="formRef"
      class="v2-horizontal-form v2-account-sale-recovery-form"
      :model="formModel"
      :rules="rules"
      label-position="left"
      label-width="92px"
      require-asterisk-position="right"
      status-icon
    >
      <V2PanelSection
        heading-id="account-sale-recovery-reason"
        title="纠正依据"
        step="01"
        help="记录本次售出误操作及恢复库存归属的依据"
      >
        <el-form-item label="纠正原因" prop="reason">
          <el-input
            v-model="page.saleRecoveryReason"
            type="textarea"
            :rows="4"
            maxlength="200"
            show-word-limit
            placeholder="例如：员工误将未售出的 ID 标记为已售出"
          />
        </el-form-item>
      </V2PanelSection>
    </el-form>

    <template #footer>
      <AppButton
        v-if="page.saleRecoveryError"
        variant="ghost"
        :disabled="page.saleRecoverySubmitting"
        @click="page.loadSaleRecoveryPreview"
      >
        重新检查
      </AppButton>
      <AppButton variant="ghost" :disabled="page.saleRecoverySubmitting" @click="closeDialog">
        取消
      </AppButton>
      <AppButton
        variant="primary"
        :loading="page.saleRecoverySubmitting"
        :disabled="page.saleRecoveryLoading || !page.saleRecoveryPreview?.canRecover"
        @click="confirmRecovery"
      >
        确认纠正
      </AppButton>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, type UnwrapNestedRefs } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
import { ElMessageBox } from 'element-plus/es/components/message-box/index.mjs';
import AppButton from '@/components/ui/AppButton.vue';
import V2DetailSummary from '@/v2/components/V2DetailSummary.vue';
import V2PanelSection from '@/v2/components/V2PanelSection.vue';
import { validateV2Form } from '@/v2/utils/formValidation';
import type { useAccountsPage } from '../useAccountsPage';

type AccountsPage = UnwrapNestedRefs<ReturnType<typeof useAccountsPage>>;

const props = defineProps<{ page: AccountsPage }>();
const formRef = ref<FormInstance>();
const formModel = computed(() => ({ reason: props.page.saleRecoveryReason }));
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

async function canClose() {
  if (props.page.saleRecoverySubmitting) return false;
  if (!props.page.saleRecoveryReason.trim()) return true;
  try {
    await ElMessageBox.confirm('纠正原因尚未提交，确认关闭吗？', '关闭确认', {
      type: 'warning',
      confirmButtonText: '确认关闭',
      cancelButtonText: '继续填写'
    });
    return true;
  } catch {
    return false;
  }
}

function beforeClose(done: () => void) {
  void canClose().then((confirmed) => {
    if (confirmed) done();
  });
}

function closeDialog() {
  void canClose().then((confirmed) => {
    if (confirmed) props.page.saleRecoveryDialogVisible = false;
  });
}

async function confirmRecovery() {
  if (!(await validateV2Form(formRef.value))) return;
  await props.page.confirmSaleRecovery();
}
</script>

<style scoped>
.v2-account-sale-recovery-form {
  margin-top: 6px;
}

.v2-account-sale-recovery-state {
  padding: 16px 0;
  color: var(--v2-text-secondary);
}
</style>
