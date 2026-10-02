<template>
  <el-table-column
    :label="definition.label"
    :column-key="definition.key"
    :width="V2_TABLE_ACTION_COLUMN_WIDTH[definition.layout]"
    :fixed="visibility?.fixedColumnsEnabled() === false ? false : 'right'"
    align="right"
    header-align="right"
    class-name="v2-table-action-column"
    label-class-name="v2-table-action-column"
  >
    <template #default="scope">
      <div class="v2-table-actions" :data-action-layout="definition.layout">
        <slot v-bind="scope" />
      </div>
    </template>
  </el-table-column>
</template>

<script setup lang="ts">
import { inject } from 'vue';
import { V2_TABLE_ACTION_COLUMN_WIDTH } from './tableActionLayout';
import type { V2TableActionColumnDefinition } from './tableSystem';
import { V2_TABLE_VISIBILITY_CONTEXT } from './tableVisibility';

const visibility = inject(V2_TABLE_VISIBILITY_CONTEXT, null);

defineProps<{
  definition: V2TableActionColumnDefinition;
}>();
</script>
