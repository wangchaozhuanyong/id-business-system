<template>
  <template v-if="compact">
    <span
      v-for="(service, index) in services"
      :key="service.id"
      :title="serviceHistoryTitle(service)"
    >
      {{ index ? '、' : '' }}{{ service.name }}
    </span>
    <template v-if="!services.length">—</template>
  </template>
  <div v-else-if="services.length" class="v2-record-tags">
    <el-tag
      v-for="service in services"
      :key="service.id"
      type="info"
      effect="plain"
      :title="serviceHistoryTitle(service)"
    >
      {{ service.name }}
    </el-tag>
  </div>
  <span v-else>—</span>
</template>

<script setup lang="ts">
import type { V2Customer } from '../contracts';

defineProps<{
  services: V2Customer['services'];
  compact?: boolean;
}>();

function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date(value));
}

function serviceHistoryTitle(service: V2Customer['services'][number]) {
  return `${service.name}：累计 ${service.activationCount} 次；首次 ${formatDate(
    service.firstOpenedAt
  )}；最近 ${formatDate(service.lastOpenedAt)}`;
}
</script>
