<template>
  <section class="v2-exchange-page">
    <V2AsyncRegion
      variant="section"
      skeleton="metrics"
      :phase="page.queryPhase"
      :previous-data="page.isParameterTransition"
      :error="page.headerError"
      loading-title="正在加载汇率状态"
      refreshing-title="正在更新汇率状态"
      error-title="汇率状态加载失败"
      @retry="page.loadHeader"
    >
      <V2ExchangeRatesOverview :page="page" />
    </V2AsyncRegion>

    <V2ExchangeRateTabs :page="page" />
    <V2ExchangeRateDrawers :page="page" />
  </section>
</template>

<script setup lang="ts">
import { reactive } from 'vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2ExchangeRateDrawers from './components/V2ExchangeRateDrawers.vue';
import V2ExchangeRatesOverview from './components/V2ExchangeRatesOverview.vue';
import V2ExchangeRateTabs from './components/V2ExchangeRateTabs.vue';
import { useExchangeRatesPage } from './useExchangeRatesPage';
import '@/v2/styles/records.css';
import '@/v2/styles/exchange-rates.css';

const page = reactive(useExchangeRatesPage());
</script>
