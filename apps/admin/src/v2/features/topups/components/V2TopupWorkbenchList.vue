<template>
  <V2AsyncRegion
    skeleton="table"
    :loading="page.loading || page.isInitialLoading"
    :resolved="page.hasLoadedOnce"
    :error="page.listError"
    loading-title="正在加载加卡工作台"
    refreshing-title="正在更新加卡工作台"
    error-title="加卡工作台加载失败"
    @retry="page.loadWorkbench"
  >
    <section class="v2-records-list">
      <el-table
        :aria-busy="page.loading"
        scrollbar-always-on
        show-overflow-tooltip
        class="v2-records-table v2-topup-table"
        :data="page.items"
        row-key="id"
        @sort-change="page.handleSortChange"
      >
        <template #empty>
          <div class="v2-records-empty">
            <strong>暂无 ID</strong>
            <span>当前筛选条件下没有启用的 ID</span>
            <AppButton variant="ghost" @click="page.resetFilters">重置筛选</AppButton>
          </div>
        </template>

        <el-table-column
          prop="appleId"
          label="ID 账号"
          min-width="190"
          fixed="left"
          sortable="custom"
        >
          <template #default="{ row }">
            <strong class="v2-topup-account v2-table-cell">{{ row.appleIdMasked }}</strong>
          </template>
        </el-table-column>
        <el-table-column label="国家" min-width="105">
          <template #default="{ row }">{{ row.country.name }}</template>
        </el-table-column>
        <el-table-column prop="currentBalance" label="余额" min-width="105" sortable="custom">
          <template #default="{ row }">{{ page.formatDecimal(row.currentBalance) }}</template>
        </el-table-column>
        <el-table-column label="平均成本" min-width="130">
          <template #default="{ row }">¥{{ page.formatDecimal(row.averageCost, 8) }}</template>
        </el-table-column>
        <el-table-column label="加卡记录" min-width="125">
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
        </el-table-column>
        <el-table-column label="余额流水" min-width="125">
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
        </el-table-column>
        <el-table-column label="最近加卡" min-width="130">
          <template #default="{ row }">
            <span :title="row.lastTopupAt ? page.formatDate(row.lastTopupAt) : undefined">
              {{ page.formatElapsed(row.lastTopupAt) }}
            </span>
          </template>
        </el-table-column>
        <el-table-column prop="updatedAt" label="更新时间" min-width="130" sortable="custom">
          <template #default="{ row }">{{ page.formatElapsed(row.updatedAt) }}</template>
        </el-table-column>
        <el-table-column label="当前业务" min-width="185">
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
            <span v-else>-</span>
          </template>
        </el-table-column>
        <el-table-column label="ID 状态" min-width="105">
          <template #default="{ row }">
            <el-tag :type="row.status.code === 'normal' ? 'success' : 'warning'" effect="plain">
              {{ row.status.name }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="98" fixed="right">
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
            <span v-else>-</span>
          </template>
        </el-table-column>
      </el-table>

      <div class="v2-records-mobile-list">
        <article v-for="item in page.items" :key="item.id" class="v2-records-mobile-item">
          <header>
            <div>
              <strong>{{ item.appleIdMasked }}</strong>
              <span>{{ item.country.name }}</span>
            </div>
            <el-tag :type="item.status.code === 'normal' ? 'success' : 'warning'" effect="plain">
              {{ item.status.name }}
            </el-tag>
          </header>
          <dl>
            <div>
              <dt>ID 余额</dt>
              <dd>{{ page.formatDecimal(item.currentBalance) }}</dd>
            </div>
            <div>
              <dt>人民币成本</dt>
              <dd>¥{{ page.formatDecimal(item.balanceCostAmount) }}</dd>
            </div>
            <div>
              <dt>平均成本</dt>
              <dd>¥{{ page.formatDecimal(item.averageCost, 8) }}</dd>
            </div>
            <div>
              <dt>最近加卡</dt>
              <dd>{{ page.formatElapsed(item.lastTopupAt) }}</dd>
            </div>
            <div>
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
            <div>
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
                <span v-else>-</span>
              </dd>
            </div>
            <div class="v2-topup-mobile-service">
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
                <span v-else>-</span>
              </dd>
            </div>
          </dl>
          <footer>
            <span class="v2-topup-updated">{{ page.formatDate(item.updatedAt) }}</span>
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
  </V2AsyncRegion>
</template>

<script setup lang="ts">
import { DataAnalysis, Plus, RefreshLeft, Tickets } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import type { UnwrapNestedRefs } from 'vue';
import type { useTopupWorkbenchPage } from '../useTopupWorkbenchPage';

type TopupWorkbenchPage = UnwrapNestedRefs<ReturnType<typeof useTopupWorkbenchPage>>;

defineProps<{
  page: TopupWorkbenchPage;
}>();
</script>
