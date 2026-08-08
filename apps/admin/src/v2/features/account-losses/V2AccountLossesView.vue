<template>
  <section class="v2-records-page v2-account-losses">
    <section class="v2-records-toolbar v2-records-toolbar--accounts" aria-label="ID报损记录筛选">
      <el-input
        v-model="page.query.keyword"
        clearable
        placeholder="ID、订单、原因、操作人"
        aria-label="搜索ID报损记录"
        @keyup.enter="page.handleSearch"
        @clear="page.handleSearch"
      />
      <el-select
        v-model="page.query.countryOptionId"
        clearable
        placeholder="全部国家"
        aria-label="筛选报损ID国家"
        @change="page.handleFilterChange"
      >
        <el-option
          v-for="option in page.countryOptions"
          :key="option.id"
          :label="option.name"
          :value="option.id"
        />
      </el-select>
      <el-select
        v-model="page.query.saleState"
        clearable
        placeholder="全部销售状态"
        aria-label="筛选报损ID销售状态"
        @change="page.handleFilterChange"
      >
        <el-option label="报损时可用" value="available" />
        <el-option label="报损时已卖出" value="sold" />
      </el-select>
      <V2FilterDisclosure>
        <el-date-picker
          v-model="page.reportedRange"
          type="daterange"
          value-format="YYYY-MM-DD"
          range-separator="至"
          start-placeholder="报损开始"
          end-placeholder="报损结束"
          aria-label="筛选报损日期"
          @change="page.handleFilterChange"
        />
      </V2FilterDisclosure>
      <div class="v2-records-toolbar__actions">
        <AppButton icon-only title="搜索" @click="page.handleSearch">
          <el-icon><Search /></el-icon>
        </AppButton>
        <AppButton icon-only title="重置筛选" @click="page.resetFilters">
          <el-icon><RefreshLeft /></el-icon>
        </AppButton>
        <AppButton icon-only title="刷新" :disabled="page.loading" @click="page.loadAccountLosses">
          <el-icon><Refresh /></el-icon>
        </AppButton>
      </div>
    </section>

    <V2AsyncRegion
      skeleton="table"
      :loading="page.loading || page.isInitialLoading"
      :resolved="page.hasLoadedOnce"
      :error="page.listError"
      loading-title="正在加载 ID 报损记录"
      refreshing-title="正在更新 ID 报损记录"
      error-title="ID 报损记录加载失败"
      @retry="page.loadAccountLosses"
    >
      <section class="v2-records-list">
        <V2Table
          :schema="v2TableSchemas.accountLosses.main"
          :aria-busy="page.loading"
          scrollbar-always-on
          show-overflow-tooltip
          class="v2-records-table"
          :data="page.items"
          @sort-change="page.handleSortChange"
        >
          <template #empty>
            <div class="v2-records-empty">
              <strong>暂无 ID 报损记录</strong>
              <span>报损操作成功后会自动生成不可修改的记录</span>
            </div>
          </template>
          <V2TableColumn
            :definition="v2TableSchemas.accountLosses.main.columns[0]"
            prop="rowNumber"
          />
          <V2TableColumn :definition="v2TableSchemas.accountLosses.main.columns[1]">
            <template #default="{ row }">
              <strong class="v2-account-losses__account">{{ row.appleIdMasked }}</strong>
            </template>
          </V2TableColumn>
          <V2TableColumn
            :definition="v2TableSchemas.accountLosses.main.columns[2]"
            prop="countryName"
          />
          <V2TableColumn :definition="v2TableSchemas.accountLosses.main.columns[3]">
            <template #default="{ row }">{{ row.supplierName || '—' }}</template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.accountLosses.main.columns[4]">
            <template #default="{ row }">
              <el-tag :type="row.saleState === 'sold' ? 'danger' : 'info'" effect="plain">
                {{ row.saleState === 'sold' ? '已卖出' : '可用' }}
              </el-tag>
            </template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.accountLosses.main.columns[5]">
            <template #default="{ row }">{{ row.soldOrderNo || '—' }}</template>
          </V2TableColumn>
          <V2TableColumn
            :definition="v2TableSchemas.accountLosses.main.columns[6]"
            prop="lossBalance"
            sortable="custom"
          >
            <template #default="{ row }">
              {{ page.formatDecimal(row.lossBalance) }}
              {{ row.currencyCode || '' }}
            </template>
          </V2TableColumn>
          <V2TableColumn
            :definition="v2TableSchemas.accountLosses.main.columns[7]"
            prop="lossCostAmount"
            sortable="custom"
          >
            <template #default="{ row }">
              <strong class="v2-account-losses__loss">
                ¥{{ page.formatDecimal(row.lossCostAmount) }}
              </strong>
            </template>
          </V2TableColumn>
          <V2TableColumn
            :definition="v2TableSchemas.accountLosses.main.columns[8]"
            prop="reason"
            show-overflow-tooltip
          />
          <V2TableColumn :definition="v2TableSchemas.accountLosses.main.columns[9]">
            <template #default="{ row }">
              {{ operatorUsername(row.reportedBy) }}
            </template>
          </V2TableColumn>
          <V2TableColumn
            :definition="v2TableSchemas.accountLosses.main.columns[10]"
            prop="reportedAt"
            sortable="custom"
          >
            <template #default="{ row }">{{ page.formatDate(row.reportedAt) }}</template>
          </V2TableColumn>
        </V2Table>

        <div class="v2-records-mobile-list" :data-mobile-for="v2TableSchemas.accountLosses.main.id">
          <article v-for="item in page.items" :key="item.id" class="v2-records-mobile-item">
            <header>
              <div>
                <strong v-v2-column-visibility="[v2TableSchemas.accountLosses.main.id, 'ID 账号']">
                  {{ item.appleIdMasked }}
                </strong>
                <span
                  v-v2-column-visibility="[v2TableSchemas.accountLosses.main.id, 'countryName']"
                >
                  {{ item.countryName }}
                </span>
                <span v-v2-column-visibility="[v2TableSchemas.accountLosses.main.id, '供应商']">
                  {{ item.supplierName || '未设置供应商' }}
                </span>
              </div>
              <el-tag
                v-v2-column-visibility="[v2TableSchemas.accountLosses.main.id, '销售状态']"
                :type="item.status === 'reversed' ? 'info' : 'danger'"
                effect="plain"
              >
                {{ item.status === 'reversed' ? '已冲回' : '已报损冻结' }}
              </el-tag>
            </header>
            <dl>
              <div v-v2-column-visibility="[v2TableSchemas.accountLosses.main.id, '销售状态']">
                <dt>报损时销售状态</dt>
                <dd>{{ item.saleState === 'sold' ? '已卖出' : '可用' }}</dd>
              </div>
              <div v-v2-column-visibility="[v2TableSchemas.accountLosses.main.id, '来源订单']">
                <dt>来源订单</dt>
                <dd>{{ item.soldOrderNo || '—' }}</dd>
              </div>
              <div v-v2-column-visibility="[v2TableSchemas.accountLosses.main.id, 'lossBalance']">
                <dt>损失余额</dt>
                <dd>{{ page.formatDecimal(item.lossBalance) }} {{ item.currencyCode || '' }}</dd>
              </div>
              <div
                v-v2-column-visibility="[v2TableSchemas.accountLosses.main.id, 'lossCostAmount']"
              >
                <dt>人民币亏损</dt>
                <dd>¥{{ page.formatDecimal(item.lossCostAmount) }}</dd>
              </div>
              <div v-v2-column-visibility="[v2TableSchemas.accountLosses.main.id, '操作人']">
                <dt>操作人</dt>
                <dd>{{ operatorUsername(item.reportedBy) }}</dd>
              </div>
              <div v-v2-column-visibility="[v2TableSchemas.accountLosses.main.id, 'reportedAt']">
                <dt>报损时间</dt>
                <dd>{{ page.formatDate(item.reportedAt) }}</dd>
              </div>
              <div
                v-v2-column-visibility="[v2TableSchemas.accountLosses.main.id, 'reason']"
                class="v2-account-losses__mobile-reason"
              >
                <dt>报损原因</dt>
                <dd>{{ item.reason }}</dd>
              </div>
            </dl>
          </article>
          <div v-if="!page.items.length" class="v2-records-empty">
            <strong>暂无 ID 报损记录</strong>
            <span>当前筛选条件下没有数据</span>
          </div>
        </div>

        <footer class="v2-records-pagination">
          <span>共 {{ page.total }} 条</span>
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
  </section>
</template>

<script setup lang="ts">
import V2Table from '@/v2/components/V2Table.vue';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import { reactive } from 'vue';
import { Refresh, RefreshLeft, Search } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2FilterDisclosure from '@/v2/components/V2FilterDisclosure.vue';
import { operatorUsername } from '@/v2/utils/operator';
import { useAccountLossesPage } from './useAccountLossesPage';
import '@/v2/styles/records.css';

const page = reactive(useAccountLossesPage());
</script>

<style scoped>
.v2-account-losses__account,
.v2-account-losses__loss {
  overflow-wrap: anywhere;
}

.v2-account-losses__loss {
  color: var(--el-color-danger);
}

.v2-account-losses__mobile-reason {
  grid-column: 1 / -1;
}
</style>
