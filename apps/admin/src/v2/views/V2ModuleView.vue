<template>
  <section v-if="moduleDefinition" class="v2-module-page">
    <V2FilterBar
      v-if="moduleDefinition.kind === 'list' && moduleDefinition.filters.length"
      :filters="moduleDefinition.filters"
    />

    <V2DataTable v-if="moduleDefinition.kind === 'list'" :columns="moduleDefinition.columns" />

    <V2OrderEntryFrame v-else />
  </section>

  <V2PageState
    v-else
    state="error"
    title="页面配置不存在"
    message="当前路由没有对应的 V2 模块定义。"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import V2DataTable from '@/v2/components/V2DataTable.vue';
import V2FilterBar from '@/v2/components/V2FilterBar.vue';
import V2OrderEntryFrame from '@/v2/components/V2OrderEntryFrame.vue';
import V2PageState from '@/v2/components/V2PageState.vue';
import { getV2ModuleDefinition } from '@/v2/config/modules';

const route = useRoute();
const moduleDefinition = computed(() => getV2ModuleDefinition(route.meta.v2ModuleKey));
</script>
