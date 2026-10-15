<template>
  <el-dropdown v-if="canManage" trigger="click">
    <AppButton variant="ghost">更多操作</AppButton>
    <template #dropdown
      ><el-dropdown-menu
        ><el-dropdown-item @click="openPreview">历史订单补录</el-dropdown-item></el-dropdown-menu
      ></template
    >
  </el-dropdown>
  <V2FormDrawer
    v-model="open"
    title="历史线上订单补录"
    description="每次预览最多 100 个原充值任务。补录仅同步订单记录，不会重新充值或付款。"
    :confirm-loading="busy"
    :confirm-disabled="!preview?.eligible || !preview.previewToken || !canManage"
    confirm-text="补录本批订单"
    @confirm="submit"
  >
    <V2AsyncRegion
      skeleton="inline"
      :phase="query.phase.value"
      :error="query.error.value ? getApiErrorMessage(query.error.value) : ''"
      loading-title="正在核对历史充值"
      @retry="query.refresh"
    >
      <template v-if="preview">
        <p>
          本批 {{ preview.total }} 条：可补录 {{ preview.eligible }} 条，已有订单
          {{ preview.existing }} 条，证据不足 {{ preview.insufficient }} 条。
        </p>
        <ul>
          <li v-for="item in preview.items" :key="item.taskId">
            {{ item.taskId }} · {{ statusLabels[item.status]
            }}<span v-if="item.orderNo"> · {{ item.orderNo }}</span>
          </li>
        </ul>
        <AppButton v-if="preview.nextCursor" variant="ghost" :disabled="busy" @click="nextBatch"
          >查看下一批</AppButton
        >
      </template>
    </V2AsyncRegion>
    <p v-if="message" :role="failed ? 'alert' : 'status'">{{ message }}</p>
  </V2FormDrawer>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { getApiErrorMessage } from '@/api/client';
import AppButton from '@/components/ui/AppButton.vue';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import { useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { canManageOnlineOrders } from './orderPermissions';
import { onlineApi } from './api';
interface Preview {
  items: Array<{
    taskId: string;
    status: 'eligible' | 'existing' | 'insufficient';
    orderNo?: string;
  }>;
  total: number;
  eligible: number;
  existing: number;
  insufficient: number;
  previewToken: string;
  nextCursor: string | null;
}
const emit = defineEmits<{ completed: [] }>();
const auth = useAuthStore();
const canManage = computed(() => canManageOnlineOrders(auth.user));
const open = ref(false),
  busy = ref(false),
  message = ref(''),
  failed = ref(false),
  cursor = ref('');
let active = true;
onBeforeUnmount(() => {
  active = false;
});
const statusLabels = { eligible: '可补录', existing: '已有订单', insufficient: '证据不足' };
const query = useV2ModuleQuery({
  moduleKey: 'bank-recharge-orders',
  scope: 'online-recharge',
  enabled: () => open.value && canManage.value,
  key: () => `online-order-backfill:${cursor.value}`,
  query: async () =>
    (await onlineApi.action(
      'jobs',
      'order-backfill-preview',
      cursor.value ? { cursor: cursor.value } : {}
    )) as unknown as Preview
});
const preview = computed(() => query.data.value);
function openPreview() {
  cursor.value = '';
  message.value = '';
  open.value = true;
  void query.refresh();
}
function nextBatch() {
  if (preview.value?.nextCursor) {
    cursor.value = preview.value.nextCursor;
    message.value = '';
    void query.refresh();
  }
}
async function submit() {
  if (busy.value || !canManage.value || !preview.value?.previewToken) return;
  busy.value = true;
  message.value = '';
  failed.value = false;
  try {
    const result = await onlineApi.action('jobs', 'order-backfill', {
      previewToken: preview.value.previewToken
    });
    if (!active) return;
    message.value = `本批已登记 ${result.queued ?? 0} 条待同步，已有 ${result.existing ?? 0} 条，跳过 ${result.skipped ?? 0} 条。请稍后刷新订单。`;
    emit('completed');
    await query.refresh();
  } catch (error) {
    if (active) {
      failed.value = true;
      message.value = getApiErrorMessage(error);
    }
  } finally {
    busy.value = false;
  }
}
</script>
