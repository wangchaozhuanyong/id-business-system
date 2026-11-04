<template>
  <section class="v2-page-layout v2-records-page">
    <V2OrdersOverview :page="page" />
    <V2OrdersToolbar :page="page" />
    <V2OrdersList :page="page" />
    <V2DeferredDrawerLoading
      v-if="dialogsOpened && !dialogsReady"
      :model-value="
        Boolean(
          page.detailVisible ||
          page.editVisible ||
          page.refundVisible ||
          page.upgradeBalanceReturnVisible ||
          page.archive.visible
        )
      "
      @update:model-value="closePendingDialogs"
    />
    <V2OrderDialogs v-if="dialogsOpened" :page="page" />
  </section>
</template>

<script setup lang="ts">
import { defineAsyncComponent, reactive, ref, watch } from 'vue';
import V2DeferredDrawerLoading from '@/v2/components/V2DeferredDrawerLoading.vue';
const dialogsReady = ref(false);
const V2OrderDialogs = defineAsyncComponent(() =>
  import('./components/V2OrderDialogs.vue').then(
    (module) => {
      dialogsReady.value = true;
      return module;
    },
    (error) => {
      dialogsReady.value = true;
      throw error;
    }
  )
);
import V2OrdersList from './components/V2OrdersList.vue';
import V2OrdersOverview from './components/V2OrdersOverview.vue';
import V2OrdersToolbar from './components/V2OrdersToolbar.vue';
import { useOrdersPage } from './useOrdersPage';
import '@/v2/styles/records.css';
import '@/v2/styles/orders.css';

const page = reactive(useOrdersPage());
const dialogsOpened = ref(false);
function closePendingDialogs() {
  page.detailVisible = false;
  page.editVisible = false;
  page.refundVisible = false;
  page.upgradeBalanceReturnVisible = false;
  page.archive.visible = false;
}
watch(
  () =>
    page.detailVisible ||
    page.editVisible ||
    page.refundVisible ||
    page.upgradeBalanceReturnVisible ||
    page.archive.visible,
  (visible) => {
    if (visible) dialogsOpened.value = true;
  },
  { immediate: true }
);
</script>
