<template>
  <div class="v2-quick-actions-entry">
    <AppButton
      class="v2-quick-actions-fab"
      variant="primary"
      aria-controls="v2-quick-actions-drawer"
      :aria-expanded="drawerOpen"
      @click="drawerOpen = true"
    >
      <el-icon aria-hidden="true"><DocumentCopy /></el-icon>
      便捷操作
    </AppButton>
    <V2QuickActionsDrawer
      v-model="drawerOpen"
      :items="items"
      :phase="query.phase.value"
      :error="queryError"
      :writes-allowed="auth.writesAllowed"
      :refresh="query.refresh"
      :save="save"
      :remove="remove"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { DocumentCopy } from '@element-plus/icons-vue';
import type { V2QuickActionInput, V2QuickActionList } from '@apple-business/shared';
import AppButton from '@/components/ui/AppButton.vue';
import { getApiErrorMessage } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { idBusinessV2WorkspaceApi } from '@/v2/api/workspace';
import { useV2ModuleQuery } from '@/v2/composables/useV2Query';
import V2QuickActionsDrawer from './V2QuickActionsDrawer.vue';

const auth = useAuthStore();
const drawerOpen = ref(false);
const query = useV2ModuleQuery<V2QuickActionList>({
  moduleKey: 'profile',
  scope: 'workspace',
  key: () => `quick-actions:${auth.user?.id ?? 'anonymous'}`,
  enabled: () => drawerOpen.value && Boolean(auth.user?.id),
  trackRouteData: false,
  query: ({ signal }) => idBusinessV2WorkspaceApi.listQuickActions({ signal })
});
const items = computed(() => query.data.value?.items ?? []);
const queryError = computed(() => (query.error.value ? getApiErrorMessage(query.error.value) : ''));

async function save(input: V2QuickActionInput, id?: string) {
  try {
    if (id) await idBusinessV2WorkspaceApi.updateQuickAction(id, input);
    else await idBusinessV2WorkspaceApi.createQuickAction(input);
  } catch (error) {
    throw new Error(getApiErrorMessage(error), { cause: error });
  }
  await query.refresh();
}

async function remove(id: string) {
  try {
    await idBusinessV2WorkspaceApi.removeQuickAction(id);
  } catch (error) {
    throw new Error(getApiErrorMessage(error), { cause: error });
  }
  await query.refresh();
}
</script>

<style scoped>
.v2-quick-actions-fab {
  position: fixed;
  z-index: 30;
  right: max(20px, env(safe-area-inset-right));
  bottom: max(20px, env(safe-area-inset-bottom));
  min-height: 44px;
  padding-inline: 16px;
  border-radius: 999px;
  box-shadow: var(--v3-shadow-md);
}

.v2-quick-actions-fab .el-icon {
  margin-right: 7px;
}

@media (max-width: 600px) {
  .v2-quick-actions-fab {
    right: max(12px, env(safe-area-inset-right));
    bottom: max(12px, env(safe-area-inset-bottom));
  }
}
</style>
