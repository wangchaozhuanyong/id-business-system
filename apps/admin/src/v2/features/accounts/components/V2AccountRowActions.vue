<template>
  <div v-if="hasActions" class="v2-record-actions v2-account-row-actions">
    <AppButton
      v-if="canViewSensitive"
      size="small"
      variant="ghost"
      :disabled="disabled"
      @click="emit('view-sensitive')"
    >
      敏感资料
    </AppButton>
    <AppButton
      v-if="canReportLoss && lossReported"
      size="small"
      variant="ghost"
      :disabled="disabled"
      @click="emit('unfreeze-loss')"
    >
      解除冻结
    </AppButton>
    <AppButton
      v-if="canUpdate && !lossReported"
      size="small"
      variant="ghost"
      :disabled="disabled"
      @click="emit('edit')"
    >
      <el-icon><Edit /></el-icon>
      编辑
    </AppButton>
    <el-dropdown
      v-if="hasSecondaryActions"
      ref="dropdownRef"
      trigger="click"
      :disabled="disabled"
      @command="handleCommand"
      @keydown.esc.stop.prevent="closeMenu"
    >
      <AppButton icon-only size="small" variant="ghost" title="更多 ID 操作">
        <el-icon><MoreFilled /></el-icon>
      </AppButton>
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item v-if="canChangeRecordStatus" command="toggle-status">
            {{ recordStatus === 'active' ? '停用 ID' : '启用 ID' }}
          </el-dropdown-item>
          <el-dropdown-item v-if="canRecoverSale" command="recover-sale">
            恢复可用
          </el-dropdown-item>
          <el-dropdown-item
            v-if="canReportCurrentLoss"
            command="report-loss"
            :divided="canChangeRecordStatus || canRecoverSale"
            class="v2-record-action-danger"
          >
            报损
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
  saleState: 'available' | 'sold';
  canViewSensitive: boolean;
  canUpdate: boolean;
  canReportLoss: boolean;
  lossReported: boolean;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  'view-sensitive': [];
  edit: [];
  'toggle-status': [];
  'recover-sale': [];
  'report-loss': [];
  'unfreeze-loss': [];
}>();

const dropdownRef = ref<{ handleClose: () => void } | null>(null);
const hasActions = computed(
  () =>
    props.canViewSensitive ||
    (props.lossReported && props.canReportLoss) ||
    (!props.lossReported && (props.canUpdate || props.canReportLoss))
);
const canChangeRecordStatus = computed(() => props.canUpdate && !props.lossReported);
const canReportCurrentLoss = computed(() => props.canReportLoss && !props.lossReported);
const canRecoverSale = computed(
  () => props.canUpdate && !props.lossReported && props.saleState === 'sold'
);
const hasSecondaryActions = computed(
  () => canChangeRecordStatus.value || canRecoverSale.value || canReportCurrentLoss.value
);

function closeMenu() {
  dropdownRef.value?.handleClose();
}

function handleCommand(command: string | number | object) {
  if (props.disabled) return;
  if (command === 'toggle-status') {
    emit('toggle-status');
  } else if (command === 'recover-sale') {
    emit('recover-sale');
  } else if (command === 'report-loss') {
    emit('report-loss');
  }
}
</script>
