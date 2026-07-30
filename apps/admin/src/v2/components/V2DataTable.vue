<template>
  <section class="v2-table-shell">
    <header class="v2-table-shell__header">
      <div>
        <h2>数据列表</h2>
        <span>共 0 条</span>
      </div>
    </header>

    <el-table :data="[]" row-key="id" height="420">
      <V2TableColumn
        v-for="column in dataColumns"
        :key="column.key"
        :kind="column.kind"
        :prop="column.key"
        :label="column.label"
        :min-width="column.minWidth"
        :fixed="column.fixed"
      />
      <template #empty>
        <div class="v2-table-empty">
          <strong>暂无业务数据</strong>
          <span>当前筛选条件下没有记录</span>
        </div>
      </template>
    </el-table>

    <footer class="v2-table-shell__footer">
      <span>第 1 页</span>
      <el-pagination disabled background layout="prev, pager, next" :page-size="20" :total="0" />
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import type { V2TableColumnDefinition } from '@/v2/config/modules';

const props = defineProps<{
  columns: readonly V2TableColumnDefinition[];
}>();

const dataColumns = computed(() =>
  props.columns.filter(
    (
      column
    ): column is V2TableColumnDefinition & {
      kind: Exclude<V2TableColumnDefinition['kind'], 'actions'>;
    } => column.kind !== 'actions'
  )
);
</script>
