<template>
  <el-table-column
    v-if="definition.control === 'expand'"
    type="expand"
    :label="definition.label"
    :column-key="definition.key"
    :width="definition.width"
    :fixed="definition.pin === 'start' ? 'left' : undefined"
    align="center"
    header-align="center"
    class-name="v2-table-column v2-table-column--control"
    label-class-name="v2-table-column v2-table-column--control"
  >
    <template #default="scope">
      <slot v-bind="scope" />
    </template>
  </el-table-column>
  <el-table-column
    v-else
    type="selection"
    :label="definition.label"
    :column-key="definition.key"
    :width="definition.width"
    :fixed="definition.pin === 'start' ? 'left' : undefined"
    :selectable="selectionDisabled ? () => false : undefined"
    align="center"
    header-align="center"
    class-name="v2-table-column v2-table-column--control"
    label-class-name="v2-table-column v2-table-column--control"
  />
</template>

<script setup lang="ts">
import type { V2TableControlColumnDefinition } from './tableSystem';

defineProps<{
  definition: V2TableControlColumnDefinition;
  selectionDisabled?: boolean;
}>();
</script>
