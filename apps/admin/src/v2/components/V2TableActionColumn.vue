<template>
  <el-table-column
    :label="definition.label"
    :column-key="definition.key"
    :width="
      contentWidths?.columnWidth(definition) ?? V2_TABLE_ACTION_COLUMN_WIDTH[definition.layout]
    "
    :fixed="visibility?.fixedColumnsEnabled() === false ? false : 'right'"
    align="right"
    header-align="right"
    :class-name="`v2-table-action-column ${getV2TableColumnKeyClass(definition.key)}`"
    :label-class-name="`v2-table-action-column ${getV2TableColumnKeyClass(definition.key)}`"
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
import { getV2TableColumnKeyClass } from './tableContentWidth';
import type { V2TableActionColumnDefinition } from './tableSystem';
import { V2_TABLE_CONTENT_WIDTH_CONTEXT, V2_TABLE_VISIBILITY_CONTEXT } from './tableVisibility';

const visibility = inject(V2_TABLE_VISIBILITY_CONTEXT, null);
const contentWidths = inject(V2_TABLE_CONTENT_WIDTH_CONTEXT, null);

defineProps<{
  definition: V2TableActionColumnDefinition;
}>();
</script>
