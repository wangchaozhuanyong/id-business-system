<template>
  <div v-if="hasActions" class="v2-record-actions v2-account-row-actions">
    <AppButton v-if="canViewSensitive" size="small" variant="ghost" @click="emit('view-sensitive')">
      敏感资料
    </AppButton>
    <AppButton v-if="canUpdate" size="small" variant="ghost" @click="emit('edit')">
      <el-icon><Edit /></el-icon>
      编辑
    </AppButton>
    <el-dropdown
      v-if="hasSecondaryActions"
      ref="dropdownRef"
      trigger="click"
      @command="handleCommand"
      @keydown.esc.stop.prevent="closeMenu"
    >
      <AppButton icon-only size="small" variant="ghost" title="更多 ID 操作">
        <el-icon><MoreFilled /></el-icon>
      </AppButton>
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item v-if="canUpdate" command="toggle-status">
            {{ recordStatus === 'active' ? '停用 ID' : '启用 ID' }}
          </el-dropdown-item>
          <el-dropdown-item
            v-if="canDelete"
            command="delete"
            :divided="canUpdate"
            class="v2-record-action-danger"
          >
            删除 ID
          </el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>
  </div>
  <span v-else>-</span>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { Edit, MoreFilled } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import type { V2RecordStatus } from '../contracts';

const props = defineProps<{
  recordStatus: V2RecordStatus;
  canViewSensitive: boolean;
  canUpdate: boolean;
  canDelete: boolean;
}>();

const emit = defineEmits<{
  'view-sensitive': [];
  edit: [];
  'toggle-status': [];
  delete: [];
}>();

const dropdownRef = ref<{ handleClose: () => void } | null>(null);
const hasActions = computed(() => props.canViewSensitive || props.canUpdate || props.canDelete);
const hasSecondaryActions = computed(() => props.canUpdate || props.canDelete);

function closeMenu() {
  dropdownRef.value?.handleClose();
}

function handleCommand(command: string | number | object) {
  if (command === 'toggle-status') {
    emit('toggle-status');
  } else if (command === 'delete') {
    emit('delete');
  }
}
</script>
