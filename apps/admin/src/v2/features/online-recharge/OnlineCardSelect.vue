<template>
  <div class="online-field">
    <el-select
      :model-value="modelValue"
      clearable
      filterable
      remote
      :remote-method="search"
      :loading="query.phase.value === 'initial-loading'"
      placeholder="智能分配对应套餐银行卡"
      aria-label="对应套餐银行卡"
      @update:model-value="$emit('update:modelValue', String($event ?? ''))"
    >
      <el-option label="智能分配对应套餐银行卡" value="" />
      <el-option
        v-for="card in query.data.value?.items ?? []"
        :key="card.id"
        :value="card.id"
        :label="`银行卡 ····${card.last4}`"
        :disabled="Boolean(card.inUse)"
      />
    </el-select>
    <p v-if="query.error.value" role="alert" class="online-error">
      {{ onlineError(query.error.value) }}
      <AppButton link @click="query.refresh()">重试</AppButton>
    </p>
    <small v-else-if="query.phase.value === 'ready' && !query.data.value?.total"
      >当前套餐没有可用银行卡，请先在银行卡共享池添加或调整适用套餐。</small
    >
  </div>
</template>
<script setup lang="ts">
import { watch } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import { useV2SessionDraft } from '@/v2/composables/useV2SessionDraft';
import { useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { onlineApi } from './api';
import { onlineError } from './labels';
const props = defineProps<{ modelValue: string; plan: string }>();
const emit = defineEmits<{ 'update:modelValue': [string] }>();
const filters = useV2SessionDraft('online-recharge/card-picker', () => ({ keyword: '' }));
const query = useV2ModuleQuery({
  moduleKey: 'online-recharge-cards',
  scope: 'online-recharge',
  key: () => `online-card-picker:${props.plan}:${filters.keyword}`,
  query: ({ signal }) =>
    onlineApi.list(
      'cards',
      { page: 1, pageSize: 100, status: 'active', plan: props.plan, keyword: filters.keyword },
      signal
    )
});
function search(keyword: string) {
  filters.keyword = keyword;
}
watch(
  () => props.plan,
  () => emit('update:modelValue', '')
);
</script>
