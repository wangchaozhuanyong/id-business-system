<template>
  <el-dialog
    v-model="page.revealDialogVisible"
    :title="`查看完整${page.revealFieldLabel}`"
    width="min(440px, 92vw)"
  >
    <el-form
      ref="revealFormRef"
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
      <el-form-item v-if="page.revealForm.value" :label="`完整${page.revealFieldLabel}`">
        <el-input v-model="page.revealForm.value" readonly />
      </el-form-item>
    </el-form>
    <template #footer>
      <AppButton variant="ghost" @click="page.revealDialogVisible = false">关闭</AppButton>
      <AppButton variant="soft" :loading="page.revealing" @click="page.revealContact(revealFormRef)"
        >读取资料</AppButton
      >
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, type UnwrapNestedRefs } from 'vue';
import type { FormInstance } from 'element-plus';
import AppButton from '@/components/ui/AppButton.vue';
import type { useCustomersPage } from '../useCustomersPage';

defineProps<{
  page: UnwrapNestedRefs<ReturnType<typeof useCustomersPage>>;
}>();

const revealFormRef = ref<FormInstance>();
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
