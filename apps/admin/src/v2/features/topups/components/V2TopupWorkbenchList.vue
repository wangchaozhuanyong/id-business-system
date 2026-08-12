<template>
  <V2AsyncRegion
    skeleton="table"
    :phase="page.queryPhase"
    :previous-data="page.isParameterTransition"
    :error="page.listError"
    loading-title="正在加载加卡工作台"
    refreshing-title="正在更新加卡工作台"
    error-title="加卡工作台加载失败"
    @retry="page.loadWorkbench"
  >
    <section ref="listRef" class="v2-records-list" :style="listFrameStyle">
      <header class="v2-topup-list__header">
        <V2SectionHeading
          title="可加额 ID 列表"
          help="列表保留余额、成本和当前业务快照；已售 ID 保留原销售订单与客户归属。"
        >
          <template #actions>
            <V2TableColumnSettings inline :schema="v2TableSchemas.topups.main" />
            <span>本页 {{ page.items.length }} 条</span>
            <span aria-hidden="true">·</span>
            <strong>共 {{ page.total }} 条</strong>
          </template>
        </V2SectionHeading>
      </header>

      <V2Table
        :schema="v2TableSchemas.topups.main"
        :show-column-settings="false"
        :aria-busy="page.loading"
        scrollbar-always-on
        show-overflow-tooltip
        class="v2-records-table v2-topup-table"
        :data="page.items"
        @sort-change="page.handleSortChange"
      >
        <template #empty>
          <div class="v2-records-empty">
            <strong>暂无 ID</strong>
            <span>当前筛选条件下没有启用的 ID</span>
            <AppButton variant="ghost" @click="page.resetFilters">重置筛选</AppButton>
          </div>
        </template>

        <V2TableColumn
          :definition="v2TableSchemas.topups.main.columns[0]"
          prop="appleId"
          sortable="custom"
        >
          <template #default="{ row }">
            <div class="v2-table-cell">
              <strong class="v2-topup-account">{{ row.appleIdMasked }}</strong>
              <el-tag v-if="row.saleState === 'sold'" type="warning" effect="plain"
                >客户已购</el-tag
              >
              <small v-if="row.soldByOrder">
                {{ row.soldByOrder.orderNo }} · {{ row.soldByOrder.customer.name }}
              </small>
            </div>
          </template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.topups.main.columns[1]">
          <template #default="{ row }">{{ row.country.name }}</template>
        </V2TableColumn>
        <V2TableColumn
          :definition="v2TableSchemas.topups.main.columns[2]"
          prop="currentBalance"
          sortable="custom"
        >
          <template #default="{ row }">{{ page.formatDecimal(row.currentBalance) }}</template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.topups.main.columns[3]">
          <template #default="{ row }">¥{{ page.formatDecimal(row.averageCost) }}</template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.topups.main.columns[4]">
          <template #default="{ row }">
            <div class="v2-topup-record-links">
              <AppButton
                size="small"
                variant="ghost"
                title="查看该 ID 的完整加卡记录"
                @click="page.openAccountRecords(row, 'giftCards')"
              >
                <el-icon><Tickets /></el-icon>
                加卡 {{ row.topupRecordCount }}
              </AppButton>
              <AppButton
                v-if="page.canAdjustBalance && row.topupRecordCount > 0"
                icon-only
                size="small"
                variant="ghost"
                title="处理可标记被赎回或撤回的礼品卡"
                @click="page.openReversalDrawer(row)"
              >
                <el-icon><RefreshLeft /></el-icon>
              </AppButton>
            </div>
          </template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.topups.main.columns[5]">
          <template #default="{ row }">
            <AppButton
              size="small"
              variant="ghost"
              title="查看该 ID 的完整余额变动"
              @click="page.openAccountRecords(row, 'ledger')"
            >
              <el-icon><DataAnalysis /></el-icon>
              流水 {{ row.balanceChangeCount }}
            </AppButton>
          </template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.topups.main.columns[6]">
          <template #default="{ row }">
            <span :title="row.lastTopupAt ? page.formatDate(row.lastTopupAt) : undefined">
              {{ page.formatElapsed(row.lastTopupAt) }}
            </span>
          </template>
        </V2TableColumn>
        <V2TableColumn
          :definition="v2TableSchemas.topups.main.columns[7]"
          prop="updatedAt"
          sortable="custom"
        >
          <template #default="{ row }">{{ page.formatElapsed(row.updatedAt) }}</template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.topups.main.columns[8]">
          <template #default="{ row }">
            <div
              v-if="row.currentServices.length"
              class="v2-topup-service-tags"
              :title="row.currentServices.map(page.servicePath).join('、')"
            >
              <el-tag
                v-for="service in row.currentServices"
                :key="service.id"
                type="success"
                effect="plain"
                :title="page.servicePath(service)"
              >
                {{ service.name }}
              </el-tag>
            </div>
            <span v-else>—</span>
          </template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.topups.main.columns[9]">
          <template #default="{ row }">
            <el-tag :type="row.status.code === 'normal' ? 'success' : 'warning'" effect="plain">
              {{ row.status.name }}
            </el-tag>
          </template>
        </V2TableColumn>
        <V2TableActionColumn :definition="v2TableSchemas.topups.main.columns[10]">
          <template #default="{ row }">
            <AppButton
              v-if="page.canTopup"
              size="small"
              variant="primary"
              title="礼品卡入账"
              @click="page.openCreditDrawer(row)"
            >
              <el-icon><Plus /></el-icon>
              加卡
            </AppButton>
            <span v-else>—</span>
          </template>
        </V2TableActionColumn>
      </V2Table>

      <div class="v2-records-mobile-list" :data-mobile-for="v2TableSchemas.topups.main.id">
        <article v-for="item in page.items" :key="item.id" class="v2-records-mobile-item">
          <header>
            <div>
              <strong v-v2-column-visibility="[v2TableSchemas.topups.main.id, 'appleId']">
                {{ item.appleIdMasked }}
              </strong>
              <el-tag v-if="item.saleState === 'sold'" type="warning" effect="plain">
                客户已购
              </el-tag>
              <span v-v2-column-visibility="[v2TableSchemas.topups.main.id, '国家']">
                {{ item.country.name }}
              </span>
            </div>
            <el-tag
              v-v2-column-visibility="[v2TableSchemas.topups.main.id, 'ID 状态']"
              :type="item.status.code === 'normal' ? 'success' : 'warning'"
              effect="plain"
            >
              {{ item.status.name }}
            </el-tag>
          </header>
          <dl>
            <div v-if="item.soldByOrder">
              <dt>原销售归属</dt>
              <dd>{{ item.soldByOrder.orderNo }} · {{ item.soldByOrder.customer.name }}</dd>
            </div>
            <div v-v2-column-visibility="[v2TableSchemas.topups.main.id, 'currentBalance']">
              <dt>ID 余额</dt>
              <dd>{{ page.formatDecimal(item.currentBalance) }}</dd>
            </div>
            <div>
              <dt>人民币成本</dt>
              <dd>¥{{ page.formatDecimal(item.balanceCostAmount) }}</dd>
            </div>
            <div v-v2-column-visibility="[v2TableSchemas.topups.main.id, '平均成本']">
              <dt>平均成本</dt>
              <dd>¥{{ page.formatDecimal(item.averageCost) }}</dd>
            </div>
            <div v-v2-column-visibility="[v2TableSchemas.topups.main.id, '最近加卡']">
              <dt>最近加卡</dt>
              <dd>{{ page.formatElapsed(item.lastTopupAt) }}</dd>
            </div>
            <div v-v2-column-visibility="[v2TableSchemas.topups.main.id, '加卡记录']">
              <dt>加卡记录</dt>
              <dd>
                <AppButton
                  size="small"
                  variant="ghost"
                  title="查看该 ID 的完整加卡记录"
                  @click="page.openAccountRecords(item, 'giftCards')"
                >
                  <el-icon><Tickets /></el-icon>
                  {{ item.topupRecordCount }} 笔
                </AppButton>
              </dd>
            </div>
            <div v-v2-column-visibility="[v2TableSchemas.topups.main.id, '余额流水']">
              <dt>余额变动</dt>
              <dd>
                <AppButton
                  size="small"
                  variant="ghost"
                  title="查看该 ID 的完整余额变动"
                  @click="page.openAccountRecords(item, 'ledger')"
                >
                  <el-icon><DataAnalysis /></el-icon>
                  {{ item.balanceChangeCount }} 笔
                </AppButton>
              </dd>
            </div>
            <div class="v2-topup-mobile-service">
              <dt>历史开通业务</dt>
              <dd>
                <div v-if="item.historicalServices.length" class="v2-topup-service-tags">
                  <el-tag
                    v-for="service in item.historicalServices"
                    :key="service.id"
                    type="info"
                    effect="plain"
                    :title="page.servicePath(service)"
                  >
                    {{ service.name }}
                  </el-tag>
                </div>
                <span v-else>—</span>
              </dd>
            </div>
            <div
              v-v2-column-visibility="[v2TableSchemas.topups.main.id, '当前业务']"
              class="v2-topup-mobile-service"
            >
              <dt>当前开通业务</dt>
              <dd>
                <div v-if="item.currentServices.length" class="v2-topup-service-tags">
                  <el-tag
                    v-for="service in item.currentServices"
                    :key="service.id"
                    type="success"
                    effect="plain"
                    :title="page.servicePath(service)"
                  >
                    {{ service.name }}
                  </el-tag>
                </div>
                <span v-else>—</span>
              </dd>
            </div>
          </dl>
          <footer>
            <span
              v-v2-column-visibility="[v2TableSchemas.topups.main.id, 'updatedAt']"
              class="v2-topup-updated"
            >
              {{ page.formatDate(item.updatedAt) }}
            </span>
            <div class="v2-topup-mobile-actions">
              <AppButton
                v-if="page.canAdjustBalance && item.topupRecordCount > 0"
                icon-only
                size="small"
                variant="ghost"
                title="处理可标记被赎回或撤回的礼品卡"
                @click="page.openReversalDrawer(item)"
              >
                <el-icon><RefreshLeft /></el-icon>
              </AppButton>
              <AppButton
                v-if="page.canTopup"
                size="small"
                variant="primary"
                title="礼品卡入账"
                @click="page.openCreditDrawer(item)"
              >
                <el-icon><Plus /></el-icon>
                加卡
              </AppButton>
            </div>
          </footer>
        </article>
        <div v-if="!page.items.length" class="v2-records-empty">
          <strong>暂无 ID</strong>
          <span>当前筛选条件下没有启用的 ID</span>
          <AppButton variant="ghost" @click="page.resetFilters">重置筛选</AppButton>
        </div>
      </div>

      <footer class="v2-records-pagination">
        <span>
          共 {{ page.total }} 条
          <template v-if="page.evaluatedAt">
            · 当前业务计算于 {{ page.formatTime(page.evaluatedAt) }}</template
          >
        </span>
        <el-pagination
          v-pagination-label
          :current-page="page.displayedPage"
          :page-size="page.displayedPageSize"
          background
          :disabled="page.queryPhase === 'transitioning'"
          :page-sizes="[10, 20, 50, 100]"
          layout="sizes, prev, pager, next"
          :total="page.total"
          @current-change="page.handlePageChange"
          @size-change="page.handlePageSizeChange"
        />
      </footer>
    </section>
  </V2AsyncRegion>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import { DataAnalysis, Plus, RefreshLeft, Tickets } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import V2Table from '@/v2/components/V2Table.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import V2TableColumnSettings from '@/v2/components/V2TableColumnSettings.vue';
import { useV2StableListFrame } from '@/v2/composables/useV2StableListFrame';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import type { useTopupWorkbenchPage } from '../useTopupWorkbenchPage';

type TopupWorkbenchPage = UnwrapNestedRefs<ReturnType<typeof useTopupWorkbenchPage>>;

const props = defineProps<{
  page: TopupWorkbenchPage;
}>();

const { listRef, listFrameStyle } = useV2StableListFrame({
  items: () => props.page.items,
  pageSize: () => props.page.displayedPageSize
});
</script>
