<template>
  <el-drawer
    :model-value="true"
    title="银行卡详细"
    size="min(760px, 96vw)"
    destroy-on-close
    @close="$emit('close')"
  >
    <p v-if="detailLoading">正在读取银行卡资料…</p>
    <p v-if="detailError" class="bank-recharge-error" role="alert">
      {{ detailError }} <AppButton size="small" @click="loadDetail">重试</AppButton>
    </p>
    <template v-if="detail">
      <el-descriptions :column="1" border>
        <el-descriptions-item label="银行卡名称">{{ detail.label }}</el-descriptions-item>
        <el-descriptions-item label="完整卡号">
          <span v-if="detail.number">{{ detail.number }}</span>
          <span v-else-if="!hasStoredNumber">未录入</span>
          <span v-else
            >当前未显示 <AppButton size="small" @click="loadDetail">重新查看</AppButton></span
          >
        </el-descriptions-item>
        <el-descriptions-item label="持卡人姓名">{{
          detail.billingName || '未设定'
        }}</el-descriptions-item>
        <el-descriptions-item label="有效期">{{ detail.expiry ?? '未录入' }}</el-descriptions-item>
        <el-descriptions-item label="付款币种">{{ detail.currencyCode }}</el-descriptions-item>
        <el-descriptions-item label="状态">{{
          detail.status === 'active' ? '启用' : '停用'
        }}</el-descriptions-item>
        <el-descriptions-item label="备注1">{{ detail.remark1 || '—' }}</el-descriptions-item>
        <el-descriptions-item label="备注2">{{ detail.remark2 || '—' }}</el-descriptions-item>
      </el-descriptions>
      <p class="bank-recharge-form-note">完整卡号只在当前详情短暂显示；安全码不保存。</p>
    </template>

    <V2AsyncRegion
      skeleton="table"
      :phase="ordersQuery.phase.value"
      :previous-data="ordersQuery.isParameterTransition.value"
      :error="ordersQuery.error.value ? getApiErrorMessage(ordersQuery.error.value) : ''"
      loading-title="正在加载充值记录"
      @retry="ordersQuery.refresh"
    >
      <section class="v2-records-list">
        <header>
          <V2SectionHeading title="充值账号与订单">
            <template #actions
              ><span>共 {{ ordersQuery.data.value?.total ?? 0 }} 单</span></template
            >
          </V2SectionHeading>
        </header>
        <div v-if="!ordersQuery.data.value?.items.length" class="v2-records-empty">
          <strong>暂无已充值账号</strong><span>充值成功且关联此卡后会显示在这里</span>
        </div>
        <div v-else class="bank-recharge-card-orders">
          <div
            v-for="order in ordersQuery.data.value.items"
            :key="order.id"
            class="bank-recharge-card-order"
          >
            <div>
              <strong>{{ order.account?.emailMasked ?? '待关联账号' }}</strong>
              <span
                >{{ order.orderNo }} · {{ order.chargeAmount }} {{ order.chargeCurrencyCode }}</span
              >
            </div>
            <AppButton
              size="small"
              variant="ghost"
              :disabled="!order.accountId"
              @click="goToOrder(order.accountId, order.orderNo)"
              >前往订单</AppButton
            >
          </div>
        </div>
        <footer class="v2-records-pagination">
          <span>共 {{ ordersQuery.data.value?.total ?? 0 }} 单</span>
          <el-pagination
            v-pagination-label
            :current-page="ordersQuery.data.value?.page ?? page"
            :page-size="20"
            :total="ordersQuery.data.value?.total ?? 0"
            background
            layout="prev, pager, next"
            @current-change="page = $event"
          />
        </footer>
      </section>
    </V2AsyncRegion>
  </el-drawer>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import AppButton from '@/components/ui/AppButton.vue';
import { getApiErrorMessage } from '@/api/client';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import { createV2QueryKey, useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { bankRechargeApi, type ManagedBankRechargeCardDetail } from './bank-recharge-api';

const props = defineProps<{ id: string }>();
defineEmits<{ close: [] }>();
const router = useRouter();
const page = ref(1);
const ordersQuery = useV2ModuleQuery({
  moduleKey: 'bank-recharge-cards',
  scope: 'auto-recharge',
  key: () => createV2QueryKey({ cardId: props.id, page: page.value }),
  keepPreviousData: true,
  query: ({ signal }) =>
    bankRechargeApi.managedCardOrders(props.id, { page: page.value, pageSize: 20 }, { signal })
});
watch(page, () => {
  void ordersQuery.ensureFresh();
});

// 完整卡号不进入共享查询缓存；关闭或超过一分钟后从当前组件状态清除。
const detail = ref<ManagedBankRechargeCardDetail | null>(null);
const detailLoading = ref(false);
const detailError = ref('');
const hasStoredNumber = ref(false);
let mounted = true;
let clearTimer: ReturnType<typeof setTimeout> | undefined;
async function loadDetail() {
  if (detailLoading.value) return;
  detailLoading.value = true;
  detailError.value = '';
  try {
    const value = await bankRechargeApi.managedCardDetail(props.id);
    if (!mounted) return;
    detail.value = value;
    hasStoredNumber.value = Boolean(value.number);
    if (clearTimer) clearTimeout(clearTimer);
    clearTimer = setTimeout(() => {
      if (detail.value) detail.value = { ...detail.value, number: null };
    }, 60_000);
  } catch (error) {
    if (mounted) detailError.value = getApiErrorMessage(error);
  } finally {
    if (mounted) detailLoading.value = false;
  }
}
onMounted(() => {
  void loadDetail();
});
onUnmounted(() => {
  mounted = false;
  if (clearTimer) clearTimeout(clearTimer);
  detail.value = null;
});
function goToOrder(accountId: string, orderNo: string) {
  void router.push({ path: '/v2/auto-recharge/bank-orders', query: { accountId, orderNo } });
}
</script>

<style scoped>
.bank-recharge-card-orders {
  display: grid;
  gap: 8px;
  padding: 12px;
}
.bank-recharge-card-order {
  display: flex;
  gap: 12px;
  justify-content: space-between;
  align-items: center;
  padding: 10px 0;
  border-bottom: 1px solid var(--el-border-color-light);
}
.bank-recharge-card-order > div {
  display: grid;
  gap: 4px;
  min-width: 0;
}
.bank-recharge-card-order span {
  color: var(--v2-text-soft);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
@media (max-width: 560px) {
  .bank-recharge-card-order {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
