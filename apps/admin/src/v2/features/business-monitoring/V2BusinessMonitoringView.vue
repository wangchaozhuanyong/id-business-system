<template>
  <section class="v2-records-page v2-business-monitoring-page">
    <header class="v2-business-monitoring-header">
      <div>
        <strong>业务监控</strong>
        <p>异常由当前订单、开通、余额、汇率和财务状态实时计算；修正源数据后自动消失。</p>
      </div>
      <span v-if="page.generatedAt">
        更新于 {{ page.formatBusinessMonitoringDate(page.generatedAt) }}
      </span>
    </header>

    <section class="v2-records-toolbar v2-business-monitoring-toolbar" aria-label="业务异常筛选">
      <el-select
        v-model="page.query.severity"
        clearable
        placeholder="全部风险级别"
        aria-label="筛选风险级别"
        @change="page.handleFilterChange"
      >
        <el-option label="紧急" value="critical" />
        <el-option label="警告" value="warning" />
        <el-option label="提示" value="info" />
      </el-select>
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
        <AppButton icon-only title="重置筛选" @click="page.resetFilters">
          <el-icon><RefreshLeft /></el-icon>
        </AppButton>
        <AppButton icon-only title="刷新" :disabled="page.loading" @click="page.refresh">
          <el-icon><Refresh /></el-icon>
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

        <section class="v2-records-list">
          <V2Table
            :schema="v2TableSchemas.businessMonitoring.main"
            :aria-busy="page.loading"
            scrollbar-always-on
            show-overflow-tooltip
            class="v2-records-table"
            :data="page.items"
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
                <AppButton size="small" variant="ghost" @click="page.openSource(row.route)">
                  查看源数据
                </AppButton>
              </template>
            </V2TableActionColumn>
          </V2Table>

          <div
            class="v2-records-mobile-list"
            :data-mobile-for="v2TableSchemas.businessMonitoring.main.id"
          >
            <article v-for="item in page.items" :key="item.id" class="v2-records-mobile-item">
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
                <AppButton size="small" variant="ghost" @click="page.openSource(item.route)">
                  查看源数据
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
      </div>
    </V2AsyncRegion>
  </section>
</template>

<script setup lang="ts">
import { reactive } from 'vue';
import { Refresh, RefreshLeft } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import V2Table from '@/v2/components/V2Table.vue';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import V2BusinessMonitoringSummary from './components/V2BusinessMonitoringSummary.vue';
import { useBusinessMonitoringPage } from './useBusinessMonitoringPage';
import '@/v2/styles/records.css';

const page = reactive(useBusinessMonitoringPage());
</script>

<style scoped>
.v2-business-monitoring-header {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 18px;
  border: 1px solid var(--v2-border);
  border-radius: var(--v3-radius);
  background: var(--v2-surface);
}

.v2-business-monitoring-header > div {
  display: grid;
  min-width: 0;
  gap: 4px;
}

.v2-business-monitoring-header strong {
  color: var(--v2-text);
  font-size: 20px;
}

.v2-business-monitoring-header p,
.v2-business-monitoring-header > span,
.v2-records-mobile-item footer > span {
  margin: 0;
  color: var(--v2-text-soft);
  font-size: 11px;
  line-height: 1.5;
}

.v2-business-monitoring-toolbar {
  grid-template-columns: minmax(160px, 220px) minmax(180px, 240px) 1fr;
}

.v2-business-monitoring-content {
  display: grid;
  min-width: 0;
  gap: 14px;
}

.v2-business-monitoring-mobile-description {
  grid-column: 1 / -1;
}

@media (max-width: 900px) {
  .v2-business-monitoring-header {
    align-items: flex-start;
    flex-direction: column;
  }

  .v2-business-monitoring-toolbar {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 560px) {
  .v2-business-monitoring-toolbar {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
