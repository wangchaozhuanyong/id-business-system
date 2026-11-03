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
  <AppButton
    v-if="showMore && !dropdownReady"
    size="small"
    variant="ghost"
    aria-haspopup="menu"
    aria-expanded="false"
    :disabled="page.isParameterTransition || page.archive.saving"
    :loading="page.lifecycleBusyOrderId === order.id"
    @click="openMenu"
    @keydown.down.prevent="openMenu"
    >更多操作</AppButton
  >
  <el-dropdown
    v-if="showMore && dropdownReady"
    ref="dropdownRef"
    trigger="click"
    :persistent="false"
    :disabled="page.isParameterTransition || page.archive.saving"
    @command="page.handleLifecycleCommand($event, order)"
    @keydown.esc.stop.prevent="closeMenu"
  >
    <AppButton
      ref="menuTrigger"
      size="small"
      variant="ghost"
      :loading="page.lifecycleBusyOrderId === order.id"
    >
      更多操作
    </AppButton>
    <template #dropdown>
      <el-dropdown-menu @keydown.esc.stop.prevent="closeMenu">
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
import { computed, nextTick, ref, type UnwrapNestedRefs } from 'vue';
import { Edit, View } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import type { V2Order } from '../contracts';
import type { useOrdersPage } from '../useOrdersPage';
type OrdersPage = UnwrapNestedRefs<ReturnType<typeof useOrdersPage>>;
const props = defineProps<{ order: V2Order; page: OrdersPage; mobile?: boolean }>();
const dropdownReady = ref(false);
const dropdownRef = ref<{ handleOpen: () => void; handleClose: () => void }>();
const menuTrigger = ref<{ $el: HTMLElement }>();
const showMore = computed(
  () =>
    !props.order.archivedAt &&
    (props.page.hasLifecycleActions(props.order) ||
      (props.page.canUpdateOrders && props.page.archive.canArchive(props.order)))
);
async function openMenu() {
  const blocked = () =>
    props.page.isParameterTransition ||
    props.page.archive.saving ||
    props.page.lifecycleBusyOrderId === props.order.id;
  if (blocked()) return;
  dropdownReady.value = true;
  await nextTick();
  if (blocked()) return;
  menuTrigger.value?.$el.focus();
  dropdownRef.value?.handleOpen();
}
function closeMenu() {
  dropdownRef.value?.handleClose();
  menuTrigger.value?.$el.focus({ preventScroll: true });
}
</script>
