<template>
  <div v-if="hasActions" class="v2-record-actions v2-account-row-actions">
    <AppButton v-if="canViewSensitive" size="small" variant="ghost" @click="emit('view-sensitive')">
      敏感资料
    </AppButton>
    <AppButton
      v-if="canReportLoss && lossReported"
      size="small"
      variant="ghost"
      @click="emit('unfreeze-loss')"
    >
      解除冻结
    </AppButton>
    <AppButton v-if="canUpdate && !lossReported" size="small" variant="ghost" @click="emit('edit')">
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
          <el-dropdown-item v-if="canUpdate && !lossReported" command="toggle-status">
            {{ recordStatus === 'active' ? '停用 ID' : '启用 ID' }}
          </el-dropdown-item>
          <el-dropdown-item
            v-if="canReportLoss && !lossReported"
            command="report-loss"
            :divided="canUpdate"
            class="v2-record-action-danger"
          >
            报损
          </el-dropdown-item>
          <el-dropdown-item
            v-if="canDelete && !lossReported"
            command="delete"
            :divided="canUpdate || canReportLoss"
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
  canReportLoss: boolean;
  lossReported: boolean;
}>();

const emit = defineEmits<{
  'view-sensitive': [];
  edit: [];
  'toggle-status': [];
  'report-loss': [];
  'unfreeze-loss': [];
  delete: [];
}>();

const dropdownRef = ref<{ handleClose: () => void } | null>(null);
const hasActions = computed(
  () =>
    props.canViewSensitive ||
    (props.lossReported && props.canReportLoss) ||
    (!props.lossReported && (props.canUpdate || props.canDelete || props.canReportLoss))
);
const hasSecondaryActions = computed(
  () => !props.lossReported && (props.canUpdate || props.canDelete || props.canReportLoss)
);

function closeMenu() {
  dropdownRef.value?.handleClose();
}

function handleCommand(command: string | number | object) {
  if (command === 'toggle-status') {
    emit('toggle-status');
  } else if (command === 'report-loss') {
    emit('report-loss');
  } else if (command === 'delete') {
    emit('delete');
  }
}
</script>
