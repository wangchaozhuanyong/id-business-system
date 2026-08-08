<template>
  <el-dialog
    v-model="page.revealDialogVisible"
    :title="page.revealField === 'phone' ? '查看完整手机号' : '查看完整 WhatsApp'"
    width="min(440px, 92vw)"
  >
    <el-alert
      :type="page.sensitiveAccessRequiresApproval ? 'warning' : 'info'"
      :title="
        page.sensitiveAccessRequiresApproval
          ? '该字段需要管理员批准后才能查看，批准结果会自动同步。'
          : '当前角色可以直接查看，系统仍会记录本次访问。'
      "
      :closable="false"
      show-icon
    />
    <el-form
      ref="page.revealFormRef"
      class="v2-horizontal-form"
      :model="page.revealForm"
      :rules="page.revealRules"
      label-position="left"
      label-width="88px"
      require-asterisk-position="right"
      status-icon
      scroll-to-error
      :scroll-into-view-options="{ behavior: 'smooth', block: 'center' }"
    >
      <el-form-item
        v-if="
          page.sensitiveAccessRequiresApproval &&
          !page.sensitiveAccessCanReveal &&
          page.sensitiveAccessRequest?.status !== 'pending'
        "
        label="申请原因"
        prop="reason"
      >
        <el-input v-model="page.revealForm.reason" maxlength="200" />
      </el-form-item>
      <div class="v2-sensitive-access-status" role="status">
        <span>{{ page.sensitiveAccessStatusText }}</span>
        <AppButton
          v-if="page.sensitiveAccessError"
          size="small"
          variant="ghost"
          @click="page.refreshSensitiveAccess"
        >
          重试
        </AppButton>
      </div>
      <el-form-item
        v-if="page.revealForm.value"
        :label="page.revealField === 'phone' ? '完整手机号' : '完整 WhatsApp'"
      >
        <el-input v-model="page.revealForm.value" readonly />
      </el-form-item>
    </el-form>
    <template #footer>
      <AppButton variant="ghost" @click="page.revealDialogVisible = false">关闭</AppButton>
      <AppButton
        variant="primary"
        :loading="page.revealing || page.sensitiveAccessLoading || page.sensitiveAccessRequesting"
        :disabled="
          Boolean(page.sensitiveAccessError) ||
          page.sensitiveAccessPolicy?.mode === 'denied' ||
          (page.sensitiveAccessRequiresApproval &&
            page.sensitiveAccessRequest?.status === 'pending')
        "
        @click="page.revealContact"
      >
        {{ page.sensitiveAccessActionText }}
      </AppButton>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import type { useCustomersPage } from '../useCustomersPage';

defineProps<{
  page: UnwrapNestedRefs<ReturnType<typeof useCustomersPage>>;
}>();
</script>

<style scoped>
.v2-sensitive-access-status {
  display: flex;
  min-height: 40px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 12px 0 4px;
  padding: 8px 10px;
  border: 1px solid var(--v2-border);
  border-radius: var(--el-border-radius-small);
  background: var(--el-fill-color-extra-light);
  color: var(--v2-text-soft);
  font-size: 12px;
}
</style>
