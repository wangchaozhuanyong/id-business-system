<template>
  <section class="v2-page-layout">
    <V2RechargeOrdersChannelView
      v-if="channel === 'bitbrowser' || canReadOnline"
      :key="channel"
      :channel="channel"
    >
      <template #channel-navigation>
        <el-tabs v-model="channel" aria-label="充值订单渠道">
          <el-tab-pane label="比特订单" name="bitbrowser" />
          <el-tab-pane v-if="canReadOnline" label="线上订单" name="online" />
        </el-tabs>
      </template>
    </V2RechargeOrdersChannelView>
    <template v-else>
      <el-tabs v-model="channel" aria-label="充值订单渠道">
        <el-tab-pane label="比特订单" name="bitbrowser" />
      </el-tabs>
      <p role="alert">没有线上代充查看权限，请联系管理员。</p>
    </template>
  </section>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { canReadOnlineOrders } from '@/v2/features/online-recharge/public-api';
import type { RechargeOrderChannel } from './bank-recharge-api';
import V2RechargeOrdersChannelView from './V2RechargeOrdersChannelView.vue';
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const canReadOnline = computed(() => canReadOnlineOrders(auth.user));
const channel = computed<RechargeOrderChannel>({
  get: () => (route.query.channel === 'online' ? 'online' : 'bitbrowser'),
  set: (value) => {
    void router.replace({
      path: route.path,
      query: {
        ...route.query,
        channel: value === 'online' ? 'online' : undefined,
        accountId: undefined,
        orderNo: undefined
      }
    });
  }
});
</script>
