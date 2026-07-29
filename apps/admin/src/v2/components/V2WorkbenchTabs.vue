<template>
  <nav class="v2-workbench-tabs" aria-label="工作台页面">
    <RouterLink
      v-for="item in v2WorkbenchModules"
      :key="item.key"
      :to="item.route"
      class="v2-workbench-tabs__item"
    >
      {{ item.title }}
    </RouterLink>
  </nav>
</template>

<script setup lang="ts">
import { v2WorkbenchModules } from '@/v2/config/modules';
</script>
