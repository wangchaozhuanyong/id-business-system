<template>
  <section class="v2-records-page v2-business-monitoring-page">
    <V2PageContext
      description="异常由当前订单、开通、余额、汇率和财务状态实时计算；修正源数据后自动消失。"
      aria-label="业务监控说明"
    >
      <template v-if="page.generatedAt" #status>
        <span>更新于 {{ page.formatBusinessMonitoringDate(page.generatedAt) }}</span>
      </template>
    </V2PageContext>

    <section class="v2-records-toolbar v2-business-monitoring-toolbar" aria-label="业务异常筛选">
      <div class="v2-business-monitoring-severity" role="group" aria-label="按风险级别筛选">
        <button
          type="button"
          :class="{ 'is-active': page.query.severity === '' }"
          :aria-pressed="page.query.severity === ''"
          @click="page.applySeverity('')"
        >
          全部
        </button>
        <button
          type="button"
          :class="{ 'is-active': page.query.severity === 'critical' }"
          :aria-pressed="page.query.severity === 'critical'"
          @click="page.applySeverity('critical')"
        >
          紧急 <span>{{ page.summary?.critical ?? 0 }}</span>
        </button>
        <button
          type="button"
          :class="{ 'is-active': page.query.severity === 'warning' }"
          :aria-pressed="page.query.severity === 'warning'"
          @click="page.applySeverity('warning')"
        >
          警告 <span>{{ page.summary?.warning ?? 0 }}</span>
        </button>
        <button
          type="button"
          :class="{ 'is-active': page.query.severity === 'info' }"
          :aria-pressed="page.query.severity === 'info'"
          @click="page.applySeverity('info')"
        >
          提示 <span>{{ page.summary?.info ?? 0 }}</span>
        </button>
      </div>
      <el-select
        v-model="page.query.category"
        clearable
        placeholder="全部异常分类"
        aria-label="筛选异常分类"
        @change="page.handleFilterChange"
      >
        <el-option label="订单" value="order" />
        <el-option label="余额" value="balance" />
        <el-option label="续费与开通" value="renewal" />
        <el-option label="汇率采集" value="exchange_rate" />
        <el-option label="财务基线" value="finance" />
      </el-select>
      <div class="v2-records-toolbar__actions">
        <AppButton
          variant="ghost"
          :disabled="!page.query.severity && !page.query.category"
          @click="page.resetFilters"
        >
          <el-icon><RefreshLeft /></el-icon>
          重置筛选
        </AppButton>
        <AppButton variant="soft" :loading="page.loading" @click="page.refresh">
          <el-icon><Refresh /></el-icon>
          刷新快照
        </AppButton>
      </div>
    </section>

    <V2AsyncRegion
      skeleton="table"
      :loading="page.loading"
      :resolved="page.hasData"
      :error="page.error"
      loading-title="正在计算业务异常"
      refreshing-title="正在更新业务异常"
      error-title="业务监控加载失败"
      @retry="page.refresh"
    >
      <div class="v2-business-monitoring-content">
        <V2BusinessMonitoringSummary :page="page" />

        <div class="v2-business-monitoring-workspace">
          <section class="v2-records-list" aria-label="业务异常队列">
            <header class="v2-business-monitoring-list-heading">
              <div>
                <span>实时队列</span>
                <h2>待复核异常</h2>
              </div>
              <small>点击行查看详情</small>
            </header>
            <V2Table
              :schema="v2TableSchemas.businessMonitoring.main"
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
                  <el-tag
                    :type="page.businessMonitoringSeverityMeta(row.severity).type"
                    effect="plain"
                  >
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
                    <strong>{{ item.subject }}</strong>
                    <span>{{ page.businessMonitoringCategoryLabel(item.category) }}</span>
                  </div>
                  <el-tag
                    :type="page.businessMonitoringSeverityMeta(item.severity).type"
                    effect="plain"
                  >
                    {{ page.businessMonitoringSeverityMeta(item.severity).label }}
                  </el-tag>
                </header>
                <dl>
                  <div class="v2-business-monitoring-mobile-description">
                    <dt>异常说明</dt>
                    <dd>{{ item.description }}</dd>
                  </div>
                  <div>
                    <dt>发现时间</dt>
                    <dd>{{ page.formatBusinessMonitoringDate(item.detectedAt) }}</dd>
                  </div>
                </dl>
                <footer>
                  <span>修正源数据后自动消失</span>
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
      </div>
    </V2AsyncRegion>
  </section>
</template>

<script setup lang="ts">
import { reactive } from 'vue';
import { Refresh, RefreshLeft } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2PageContext from '@/v2/components/V2PageContext.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import V2Table from '@/v2/components/V2Table.vue';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import V2BusinessMonitoringSummary from './components/V2BusinessMonitoringSummary.vue';
import V2BusinessMonitoringDetail from './components/V2BusinessMonitoringDetail.vue';
import { useBusinessMonitoringPage } from './useBusinessMonitoringPage';
import '@/v2/styles/records.css';

const page = reactive(useBusinessMonitoringPage());
</script>

<style scoped>
.v2-records-mobile-item footer > span {
  margin: 0;
  color: var(--v2-text-soft);
  font-size: 11px;
  line-height: 1.5;
}

.v2-business-monitoring-toolbar {
  grid-template-columns: minmax(340px, 1fr) minmax(180px, 240px) auto;
}

.v2-business-monitoring-content {
  display: grid;
  min-width: 0;
  gap: 14px;
}

.v2-business-monitoring-severity {
  display: inline-flex;
  min-width: 0;
  width: fit-content;
  max-width: 100%;
  padding: 3px;
  border: 1px solid var(--v2-border-soft);
  border-radius: calc(var(--v3-radius) - 1px);
  background: var(--v2-bg);
}

.v2-business-monitoring-severity button {
  min-height: 32px;
  padding: 5px 10px;
  border: 0;
  border-radius: calc(var(--v3-radius) - 3px);
  color: var(--v2-text-soft);
  background: transparent;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  white-space: nowrap;
}

.v2-business-monitoring-severity button:hover,
.v2-business-monitoring-severity button:focus-visible,
.v2-business-monitoring-severity button.is-active {
  color: var(--v2-text);
  background: var(--v2-surface);
  box-shadow: 0 0 0 1px var(--v2-border-soft);
  outline: none;
}

.v2-business-monitoring-severity button span {
  margin-left: 3px;
  color: inherit;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.v2-business-monitoring-workspace {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 340px);
  align-items: start;
  gap: 14px;
}

.v2-business-monitoring-list-heading {
  display: flex;
  min-height: 58px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--v2-border-soft);
}

.v2-business-monitoring-list-heading div {
  display: grid;
  gap: 2px;
}

.v2-business-monitoring-list-heading span,
.v2-business-monitoring-list-heading small {
  color: var(--v2-text-soft);
  font-size: 11px;
}

.v2-business-monitoring-list-heading h2 {
  margin: 0;
  color: var(--v2-text);
  font-size: 15px;
}

.v2-business-monitoring-page :deep(.v2-records-table .el-table__row) {
  cursor: pointer;
}

.v2-business-monitoring-page :deep(.v2-records-table .is-monitoring-selected > td.el-table__cell) {
  background: color-mix(in srgb, var(--v2-accent) 7%, var(--v2-surface));
}

.v2-business-monitoring-page :deep(.v2-records-mobile-item.is-selected) {
  border-color: color-mix(in srgb, var(--v2-accent) 55%, var(--v2-border));
}

.v2-business-monitoring-mobile-description {
  grid-column: 1 / -1;
}

@media (max-width: 900px) {
  .v2-business-monitoring-toolbar {
    grid-template-columns: minmax(0, 1fr) minmax(180px, 240px);
  }

  .v2-business-monitoring-toolbar .v2-records-toolbar__actions {
    grid-column: 1 / -1;
  }

  .v2-business-monitoring-workspace {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 560px) {
  .v2-business-monitoring-toolbar {
    grid-template-columns: minmax(0, 1fr);
  }

  .v2-business-monitoring-severity {
    width: 100%;
    overflow-x: auto;
  }

  .v2-business-monitoring-severity button {
    flex: 1 0 auto;
  }

  .v2-business-monitoring-list-heading {
    min-height: 54px;
  }
}
</style>
