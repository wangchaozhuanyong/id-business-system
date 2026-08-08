<template>
  <el-alert
    v-if="missingOptions || missingCustomers"
    class="v2-order-entry-prerequisite-alert"
    type="warning"
    :title="message"
    show-icon
    :closable="false"
  >
    <div class="v2-order-entry-prerequisite-actions">
      <span>请先补全缺失资料，再继续创建订单。</span>
      <div>
        <AppButton
          v-if="missingOptions && canManageOptions"
          variant="primary"
          @click="$emit('openOptions')"
        >
          前往选项设置
        </AppButton>
        <AppButton
          v-if="missingCustomers && canCreateCustomer"
          variant="soft"
          @click="$emit('quickCustomer')"
        >
          快速新增客户
        </AppButton>
        <AppButton
          v-if="missingCustomers && canViewCustomers"
          variant="ghost"
          @click="$emit('openCustomers')"
        >
          前往客户管理
        </AppButton>
      </div>
    </div>
  </el-alert>
</template>

<script setup lang="ts">
import AppButton from '@/components/ui/AppButton.vue';

defineProps<{
  missingOptions: boolean;
  missingCustomers: boolean;
  message: string;
  canManageOptions: boolean;
  canCreateCustomer: boolean;
  canViewCustomers: boolean;
}>();

defineEmits<{
  openOptions: [];
  quickCustomer: [];
  openCustomers: [];
}>();
</script>
