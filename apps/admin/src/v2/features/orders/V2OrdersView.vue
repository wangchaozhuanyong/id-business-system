<template>
  <section class="v2-records-page">
    <V2OrdersOverview :page="page" />
    <V2OrdersToolbar :page="page" />
    <V2OrdersList :page="page" />
    <V2OrderDialogs :page="page" />
  </section>
</template>

<script setup lang="ts">
import { reactive } from 'vue';
import V2OrderDialogs from './components/V2OrderDialogs.vue';
import V2OrdersList from './components/V2OrdersList.vue';
import V2OrdersOverview from './components/V2OrdersOverview.vue';
import V2OrdersToolbar from './components/V2OrdersToolbar.vue';
import { useOrdersPage } from './useOrdersPage';
import '@/v2/styles/records.css';
import '@/v2/styles/orders.css';

const page = reactive(useOrdersPage());
</script>
