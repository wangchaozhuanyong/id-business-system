<template>
  <div v-if="hasActions" class="v2-record-actions v2-account-row-actions">
    <AppButton
      v-if="canViewSensitive"
      size="small"
      variant="ghost"
      :disabled="disabled"
      @click="emit('view-sensitive')"
    >
      资料详情
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
    <AppButton
      v-if="hasSecondaryActions && !dropdownReady"
      size="small"
      variant="ghost"
      title="更多 ID 操作"
      aria-haspopup="menu"
      aria-expanded="false"
      :disabled="disabled"
      @click="openMenu"
      @keydown.down.prevent="openMenu"
      >更多操作</AppButton
    >
    <el-dropdown
      v-if="hasSecondaryActions && dropdownReady"
      ref="dropdownRef"
      trigger="click"
      :persistent="false"
      :disabled="disabled"
      @command="handleCommand"
      @keydown.esc.stop.prevent="closeMenu"
    >
      <AppButton ref="menuTrigger" size="small" variant="ghost" title="更多 ID 操作">
        更多操作
      </AppButton>
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item v-if="canChangeRecordStatus" command="toggle-status">
            {{ recordStatus === 'active' ? '停用 ID' : '启用 ID' }}
          </el-dropdown-item>
          <el-dropdown-item v-if="canRecoverSale" command="recover-sale">
            纠正售出
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
import { computed, nextTick, ref } from 'vue';
import { Edit } from '@element-plus/icons-vue';
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

const dropdownRef = ref<{ handleClose: () => void; handleOpen: () => void } | null>(null);
const menuTrigger = ref<{ $el: HTMLElement }>();
const dropdownReady = ref(false);
async function openMenu() {
  if (props.disabled) return;
  dropdownReady.value = true;
  await nextTick();
  if (props.disabled) return;
  menuTrigger.value?.$el.focus();
  dropdownRef.value?.handleOpen();
}
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
