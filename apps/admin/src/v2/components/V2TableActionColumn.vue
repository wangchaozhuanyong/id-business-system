<template>
  <el-table-column
    label="操作"
    :width="V2_TABLE_ACTION_COLUMN_WIDTH[layout]"
    fixed="right"
    align="right"
    header-align="right"
    class-name="v2-table-action-column"
    label-class-name="v2-table-action-column"
  >
    <template #default="scope">
      <div class="v2-table-actions" :data-action-layout="layout">
        <slot v-bind="scope" />
      </div>
    </template>
  </el-table-column>
</template>

<script setup lang="ts">
import { V2_TABLE_ACTION_COLUMN_WIDTH, type V2TableActionLayout } from './tableActionLayout';

defineProps<{
  layout: V2TableActionLayout;
}>();
</script>
