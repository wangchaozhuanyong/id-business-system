<template>
  <section class="v2-records-page v2-topup-workbench">
    <V2TopupWorkbenchOverview :page="page" />
    <V2TopupWorkbenchToolbar :page="page" />
    <V2TopupWorkbenchList :page="page" />
    <V2TopupWorkbenchDialogs :page="page" />
  </section>
</template>

<script setup lang="ts">
import { reactive } from 'vue';
import V2TopupWorkbenchDialogs from './components/V2TopupWorkbenchDialogs.vue';
import V2TopupWorkbenchList from './components/V2TopupWorkbenchList.vue';
import V2TopupWorkbenchOverview from './components/V2TopupWorkbenchOverview.vue';
import V2TopupWorkbenchToolbar from './components/V2TopupWorkbenchToolbar.vue';
import { useTopupWorkbenchPage } from './useTopupWorkbenchPage';
import '@/v2/styles/records.css';
import '@/v2/styles/topup-workbench.css';

const page = reactive(useTopupWorkbenchPage());
</script>
