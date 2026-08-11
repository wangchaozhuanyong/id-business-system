<template>
  <div class="v2-business-monitoring-workspace">
    <section
      ref="listRef"
      class="v2-records-list v2-business-monitoring-list"
      :style="listFrameStyle"
      aria-label="业务异常队列"
    >
      <header class="v2-business-monitoring-list__header">
        <V2SectionHeading
          title="实时异常队列"
          help="队列由当前源业务状态实时计算；点击一条异常可在右侧查看判定规则和源数据入口。"
        >
          <template #actions>
            <V2TableColumnSettings inline :schema="v2TableSchemas.businessMonitoring.main" />
            <span>本页 {{ page.items.length }} 条</span>
            <span aria-hidden="true">·</span>
            <strong>共 {{ page.total }} 条</strong>
          </template>
        </V2SectionHeading>
      </header>

      <V2Table
        :schema="v2TableSchemas.businessMonitoring.main"
        :show-column-settings="false"
        :aria-busy="page.loading"
        :row-class-name="page.businessMonitoringRowClassName"
        scrollbar-always-on
        show-overflow-tooltip
        class="v2-records-table"
        :data="page.items"
        @row-click="page.selectFinding"
      >
        <template #empty>
          <div class="v2-records-empty">
            <strong>当前筛选下没有异常</strong>
            <span>这是当前源数据快照，不代表历史上从未发生异常</span>
          </div>
        </template>
        <V2TableColumn :definition="v2TableSchemas.businessMonitoring.main.columns[0]">
          <template #default="{ row }">
            <el-tag :type="page.businessMonitoringSeverityMeta(row.severity).type" effect="plain">
              {{ page.businessMonitoringSeverityMeta(row.severity).label }}
            </el-tag>
          </template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.businessMonitoring.main.columns[1]">
          <template #default="{ row }">
            {{ page.businessMonitoringCategoryLabel(row.category) }}
          </template>
        </V2TableColumn>
        <V2TableColumn
          :definition="v2TableSchemas.businessMonitoring.main.columns[2]"
          prop="subject"
        />
        <V2TableColumn
          :definition="v2TableSchemas.businessMonitoring.main.columns[3]"
          prop="description"
          show-overflow-tooltip
        />
        <V2TableColumn :definition="v2TableSchemas.businessMonitoring.main.columns[4]">
          <template #default>修正源数据</template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.businessMonitoring.main.columns[5]">
          <template #default="{ row }">
            {{ page.formatBusinessMonitoringDate(row.detectedAt) }}
          </template>
        </V2TableColumn>
        <V2TableActionColumn :definition="v2TableSchemas.businessMonitoring.main.columns[6]">
          <template #default="{ row }">
            <AppButton size="small" variant="ghost" @click.stop="page.selectFinding(row)">
              查看详情
            </AppButton>
          </template>
        </V2TableActionColumn>
      </V2Table>

      <div
        class="v2-records-mobile-list"
        :data-mobile-for="v2TableSchemas.businessMonitoring.main.id"
      >
        <article
          v-for="item in page.items"
          :key="item.id"
          class="v2-records-mobile-item"
          :class="{ 'is-selected': page.selectedFinding?.id === item.id }"
        >
          <header>
            <div>
              <strong
                v-v2-column-visibility="[v2TableSchemas.businessMonitoring.main.id, 'subject']"
              >
                {{ item.subject }}
              </strong>
              <span v-v2-column-visibility="[v2TableSchemas.businessMonitoring.main.id, '分类']">
                {{ page.businessMonitoringCategoryLabel(item.category) }}
              </span>
            </div>
            <el-tag
              v-v2-column-visibility="[v2TableSchemas.businessMonitoring.main.id, '级别']"
              :type="page.businessMonitoringSeverityMeta(item.severity).type"
              effect="plain"
            >
              {{ page.businessMonitoringSeverityMeta(item.severity).label }}
            </el-tag>
          </header>
          <dl>
            <div
              v-v2-column-visibility="[v2TableSchemas.businessMonitoring.main.id, 'description']"
              class="v2-business-monitoring-mobile-description"
            >
              <dt>异常说明</dt>
              <dd>{{ item.description }}</dd>
            </div>
            <div v-v2-column-visibility="[v2TableSchemas.businessMonitoring.main.id, '发现时间']">
              <dt>发现时间</dt>
              <dd>{{ page.formatBusinessMonitoringDate(item.detectedAt) }}</dd>
            </div>
          </dl>
          <footer>
            <span v-v2-column-visibility="[v2TableSchemas.businessMonitoring.main.id, '处理方式']">
              修正源数据后自动消失
            </span>
            <AppButton size="small" variant="ghost" @click="page.selectFinding(item)">
              查看详情
            </AppButton>
          </footer>
        </article>
        <div v-if="!page.items.length" class="v2-records-empty">
          <strong>当前筛选下没有异常</strong>
          <span>可调整筛选条件查看其他分类</span>
        </div>
      </div>

      <footer class="v2-records-pagination">
        <span>当前筛选共 {{ page.total }} 条</span>
        <el-pagination
          v-model:current-page="page.query.page"
          v-model:page-size="page.query.pageSize"
          v-pagination-label
          background
          :page-sizes="[10, 20, 50, 100]"
          layout="sizes, prev, pager, next"
          :total="page.total"
          @current-change="page.handlePageChange"
          @size-change="page.handlePageSizeChange"
        />
      </footer>
    </section>

    <V2BusinessMonitoringDetail :page="page" />
  </div>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import V2Table from '@/v2/components/V2Table.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import V2TableColumnSettings from '@/v2/components/V2TableColumnSettings.vue';
import { useV2StableListFrame } from '@/v2/composables/useV2StableListFrame';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import type { useBusinessMonitoringPage } from '../useBusinessMonitoringPage';
import V2BusinessMonitoringDetail from './V2BusinessMonitoringDetail.vue';

type BusinessMonitoringPage = UnwrapNestedRefs<ReturnType<typeof useBusinessMonitoringPage>>;

const props = defineProps<{ page: BusinessMonitoringPage }>();
const { listRef, listFrameStyle } = useV2StableListFrame({
  items: () => props.page.items,
  pageSize: () => props.page.query.pageSize
});
</script>
