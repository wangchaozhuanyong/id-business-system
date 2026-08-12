<template>
  <el-dialog
    v-model="page.saleRecoveryDialogVisible"
    title="已售出 ID 恢复库存归属"
    width="min(520px, 92vw)"
    destroy-on-close
    :close-on-click-modal="!page.saleRecoverySubmitting"
    :close-on-press-escape="!page.saleRecoverySubmitting"
    :show-close="!page.saleRecoverySubmitting"
    :before-close="beforeClose"
  >
    <el-alert
      type="warning"
      title="恢复会解除客户归属，但保留 ID 当前启用或停用状态。余额与余额成本必须为零，且有效业务和其他活动锁均已处理完毕。"
      :closable="false"
      show-icon
    />
    <div v-if="page.saleRecoveryLoading" class="v2-account-sale-recovery-state">
      正在检查回收条件…
    </div>
    <el-alert
      v-else-if="page.saleRecoveryError"
      type="error"
      title="回收条件检查失败"
      :description="page.saleRecoveryError"
      :closable="false"
      show-icon
    />
    <el-alert
      v-else-if="page.saleRecoveryPreview && !page.saleRecoveryPreview.canRecover"
      type="error"
      title="当前不能恢复库存归属"
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
      <el-form-item label="ID 账号">
        <span>{{ page.saleRecoveryTarget?.appleIdMasked }}</span>
      </el-form-item>
      <el-form-item label="来源订单">
        <span>{{ page.saleRecoveryTarget?.soldByOrder?.orderNo || '—' }}</span>
      </el-form-item>
      <el-form-item v-if="page.saleRecoveryPreview" label="当前余额">
        <span>
          {{ page.saleRecoveryPreview.currentBalance }} / 成本
          {{ page.saleRecoveryPreview.balanceCostAmount }}
        </span>
      </el-form-item>
      <el-form-item label="恢复原因" prop="reason">
        <el-input
          v-model="page.saleRecoveryReason"
          type="textarea"
          :rows="4"
          maxlength="200"
          show-word-limit
          placeholder="例如：客户退货，已核对 ID 可重新使用"
        />
      </el-form-item>
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
        确认恢复
      </AppButton>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, type UnwrapNestedRefs } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
import { ElMessageBox } from 'element-plus/es/components/message-box/index.mjs';
import AppButton from '@/components/ui/AppButton.vue';
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
    await ElMessageBox.confirm('恢复原因尚未提交，确认关闭吗？', '关闭确认', {
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
  margin-top: 18px;
}

.v2-account-sale-recovery-state {
  padding: 16px 0;
  color: var(--v2-text-secondary);
}
</style>
