<template>
  <section class="v2-filter-bar" aria-label="列表筛选">
    <div class="v2-filter-bar__fields">
      <label v-for="filter in filters" :key="filter.key" class="v2-filter-field">
        <span>{{ filter.label }}</span>

        <el-input v-if="filter.kind === 'search'" disabled :placeholder="filter.placeholder" />

        <el-select
          v-else-if="filter.kind === 'select'"
          disabled
          :placeholder="`选择${filter.label}`"
        >
          <el-option
            v-for="option in filter.options"
            :key="option"
            :label="option"
            :value="option"
          />
        </el-select>

        <el-date-picker
          v-else-if="filter.kind === 'date-range'"
          type="daterange"
          disabled
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          range-separator="-"
        />

        <span v-else class="v2-number-range">
          <el-input-number disabled controls-position="right" placeholder="最低" />
          <span>至</span>
          <el-input-number disabled controls-position="right" placeholder="最高" />
        </span>
      </label>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { V2FilterDefinition } from '@/v2/config/modules';

defineProps<{
  filters: readonly V2FilterDefinition[];
}>();
</script>
