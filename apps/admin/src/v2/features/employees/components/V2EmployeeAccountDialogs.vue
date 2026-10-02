<template>
  <V2FormDrawer
    v-model="actions.resetVisible"
    title="重置员工密码"
    eyebrow="账号安全"
    :description="actions.resetEmployee ? `账号：${actions.resetEmployee.username}` : ''"
    confirm-text="重置密码"
    :confirm-loading="actions.resetting"
    :confirm-disabled-reason="actions.resetDisabledReason"
    :dirty="actions.resetDirty"
    :retain-draft="false"
    @confirm="actions.resetPassword"
  >
    <el-alert
      type="warning"
      title="旧会话会立即失效，员工下次登录必须修改密码。登录 MFA 保持原绑定。"
      :closable="false"
      show-icon
    />
    <el-alert
      v-if="actions.resetError"
      type="error"
      :title="actions.resetError"
      :closable="false"
      show-icon
    />
    <el-form
      class="v2-horizontal-form"
      :model="actions.resetPasswordForm"
      label-position="left"
      label-width="104px"
      require-asterisk-position="right"
    >
      <el-form-item label="新临时密码" required>
        <el-input
          v-model="actions.resetPasswordForm.password"
          type="password"
          show-password
          autocomplete="new-password"
          maxlength="160"
          :disabled="actions.resetting"
        />
      </el-form-item>
      <el-form-item label="确认密码" required>
        <el-input
          v-model="actions.resetPasswordForm.confirmation"
          type="password"
          show-password
          autocomplete="new-password"
          maxlength="160"
          :disabled="actions.resetting"
        />
      </el-form-item>
    </el-form>
  </V2FormDrawer>
  <V2ConfirmDialog
    v-model="actions.deleteVisible"
    title="删除员工账号并移交业务"
    message="删除后账号无法登录，业务默认由超级管理员接管。"
    confirm-text="删除并移交"
    danger
    :confirm-loading="actions.deleting"
    :confirm-disabled-reason="actions.deleteDisabledReason"
    @confirm="actions.removeEmployee"
  >
    <V2AsyncRegion
      :phase="actions.previewPhase"
      :error="actions.previewError"
      skeleton="form"
      loading-title="正在核对删除影响"
      error-title="删除预检查失败"
      @retry="actions.refreshPreview"
    >
      <template v-if="actions.preview">
        <p>
          删除账号：{{ actions.preview.employee.username }}（{{
            actions.preview.employee.displayName
          }}）
        </p>
        <p>
          业务接管人：{{ actions.preview.target.displayName }}（{{
            actions.preview.target.username
          }}）
        </p>
        <ul>
          <li v-for="item in impactRows" :key="item.label">
            {{ item.label }}：{{ item.value }} 条
          </li>
        </ul>
        <el-alert
          type="info"
          title="账号删除后无法登录；业务、原创建人、审计和账务保留。日常离职可以只停用账号，后续继续复用。"
          :closable="false"
          show-icon
        />
      </template>
    </V2AsyncRegion>
    <el-alert
      v-if="actions.deleteError"
      type="error"
      :title="actions.deleteError"
      :closable="false"
      show-icon
    />
  </V2ConfirmDialog>
</template>

<script setup lang="ts">
import { computed, type UnwrapNestedRefs } from 'vue';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import V2ConfirmDialog from '@/v2/components/V2ConfirmDialog.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import type { useEmployeeAccountActions } from '../useEmployeeAccountActions';

const props = defineProps<{
  actions: UnwrapNestedRefs<ReturnType<typeof useEmployeeAccountActions>>;
}>();
const impactRows = computed(() => {
  const counts = props.actions.preview?.counts;
  if (!counts) return [];
  return [
    { label: '接管地址', value: counts.addresses },
    { label: '接管充值任务', value: counts.rechargeJobs },
    { label: '接管充值记录', value: counts.rechargeRecords },
    { label: '接管业务 2FA 账号', value: counts.businessTotpAccounts },
    { label: '接管中转脚本任务', value: counts.relayJobs },
    { label: '保留客户', value: counts.customers },
    { label: '保留订单', value: counts.orders },
    { label: '保留 ID 资料', value: counts.accounts },
    { label: '保留加卡记录', value: counts.giftCards }
  ];
});
</script>
