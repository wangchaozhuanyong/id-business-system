<template>
  <AppButton size="small" variant="ghost" @click="page.openDetail(order)">
    <el-icon v-if="!mobile"><View /></el-icon>
    {{ mobile ? '查看详情' : '详情' }}
  </AppButton>
  <AppButton
    v-if="page.canUpdateOrders && page.archive.canUnarchive(order)"
    size="small"
    variant="ghost"
    :disabled="page.isParameterTransition || page.archive.saving"
    @click="page.archive.openUnarchive(order)"
  >
    恢复归档
  </AppButton>
  <AppButton
    v-if="!order.archivedAt && page.canUpdateOrders && order.operations.canEdit"
    size="small"
    variant="ghost"
    :icon-only="!mobile"
    title="修改订单"
    :disabled="page.isParameterTransition"
    @click="page.openEdit(order)"
  >
    <el-icon v-if="!mobile"><Edit /></el-icon>
    <template v-else>修改</template>
  </AppButton>
  <el-dropdown
    v-if="
      !order.archivedAt &&
      (page.hasLifecycleActions(order) || (page.canUpdateOrders && page.archive.canArchive(order)))
    "
    trigger="click"
    :disabled="page.isParameterTransition || page.archive.saving"
    @command="page.handleLifecycleCommand($event, order)"
  >
    <AppButton size="small" variant="ghost" :loading="page.lifecycleBusyOrderId === order.id">
      更多操作
    </AppButton>
    <template #dropdown>
      <el-dropdown-menu>
        <el-dropdown-item
          v-if="page.canUpdateOrders && page.archive.canArchive(order)"
          command="archive"
        >
          归档订单
        </el-dropdown-item>
        <el-dropdown-item
          v-if="page.canUpdateOrders && order.operations.canRecordUpgradeBalanceReturn"
          command="upgrade-balance-return"
        >
          登记升级退币
        </el-dropdown-item>
        <el-dropdown-item
          v-if="page.canUpdateOrders && order.operations.canReverseUpgradeBalanceReturn"
          command="reverse-upgrade-balance-return"
        >
          撤销升级退币
        </el-dropdown-item>
        <el-dropdown-item v-if="page.canUpdateOrders && order.operations.canRefund" command="refund"
          >退款</el-dropdown-item
        >
        <el-dropdown-item v-if="page.canUpdateOrders && order.operations.canCancel" command="cancel"
          >取消订单</el-dropdown-item
        >
        <el-dropdown-item
          v-if="page.canDeleteOrders && order.operations.canDelete"
          command="delete"
          divided
          class="v2-order-action-danger"
          >删除记录</el-dropdown-item
        >
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import { Edit, View } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import type { V2Order } from '../contracts';
import type { useOrdersPage } from '../useOrdersPage';
type OrdersPage = UnwrapNestedRefs<ReturnType<typeof useOrdersPage>>;
defineProps<{ order: V2Order; page: OrdersPage; mobile?: boolean }>();
</script>
