<template>
  <section class="v2-records-page">
    <section class="v2-records-toolbar v2-records-toolbar--accounts" aria-label="ID筛选">
      <el-input
        v-model="page.query.keyword"
        clearable
        placeholder="ID账号、手机号、供应商"
        aria-label="搜索ID资料"
        @keyup.enter="page.handleSearch"
        @clear="page.handleSearch"
      />
      <el-select
        v-model="page.query.countryOptionId"
        clearable
        placeholder="全部国家"
        aria-label="筛选国家"
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
        v-model="page.query.statusOptionId"
        clearable
        placeholder="全部ID状态"
        aria-label="筛选ID状态"
        @change="page.handleFilterChange"
      >
        <el-option
          v-for="option in page.statusOptions"
          :key="option.id"
          :label="option.name"
          :value="option.id"
        />
      </el-select>
      <el-select
        v-model="page.query.saleState"
        clearable
        placeholder="全部销售状态"
        aria-label="筛选销售状态"
        @change="page.handleFilterChange"
      >
        <el-option label="可用" value="available" />
        <el-option label="已卖出" value="sold" />
      </el-select>
      <V2FilterDisclosure>
        <el-select
          v-model="page.query.supplierOptionId"
          clearable
          placeholder="全部供应商"
          aria-label="筛选ID供应商"
          @change="page.handleFilterChange"
        >
          <el-option
            v-for="option in page.supplierOptions"
            :key="option.id"
            :label="option.name"
            :value="option.id"
          />
        </el-select>
        <el-select
          v-model="page.query.recordStatus"
          clearable
          placeholder="全部资料状态"
          aria-label="筛选资料状态"
          @change="page.handleFilterChange"
        >
          <el-option label="启用" value="active" />
          <el-option label="停用" value="disabled" />
        </el-select>
      </V2FilterDisclosure>
      <div class="v2-records-toolbar__actions">
        <AppButton icon-only title="搜索" @click="page.handleSearch">
          <el-icon><Search /></el-icon>
        </AppButton>
        <AppButton icon-only title="刷新" :disabled="page.loading" @click="page.loadAccounts">
          <el-icon><Refresh /></el-icon>
        </AppButton>
        <el-dropdown trigger="click" @command="page.handleToolbarCommand">
          <AppButton variant="ghost" :loading="page.exporting">
            <el-icon><MoreFilled /></el-icon>
            更多
          </AppButton>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="template">下载导入模板</el-dropdown-item>
              <el-dropdown-item v-if="page.canImport" command="import">导入 ID</el-dropdown-item>
              <el-dropdown-item command="export">导出当前结果</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <AppButton v-if="page.canCreate" variant="primary" @click="page.openCreate">
          <el-icon><Plus /></el-icon>
          新增 ID
        </AppButton>
        <input
          ref="importFileInput"
          class="v2-sr-only"
          type="file"
          accept=".csv,text/csv"
          @change="page.handleImportFile"
        />
      </div>
    </section>

    <p class="v2-records-security-note">
      <el-icon><Lock /></el-icon>
      敏感资料默认脱敏，查看、复制和导出都会写入审计日志。
    </p>

    <V2AsyncRegion
      skeleton="table"
      :loading="page.loading || page.isInitialLoading"
      :resolved="page.hasLoadedOnce"
      :error="page.listError"
      loading-title="正在加载 ID 资料"
      refreshing-title="正在更新 ID 资料"
      error-title="ID 资料加载失败"
      @retry="page.loadAccounts"
    >
      <section class="v2-records-list">
        <el-table
          :aria-busy="page.loading"
          scrollbar-always-on
          show-overflow-tooltip
          class="v2-records-table"
          :data="page.items"
          row-key="id"
          @sort-change="page.handleSortChange"
        >
          <template #empty>
            <div class="v2-records-empty">
              <strong>暂无 ID 资料</strong>
              <span>当前筛选条件下没有数据</span>
              <AppButton v-if="page.canCreate" variant="primary" @click="page.openCreate"
                >新增 ID</AppButton
              >
            </div>
          </template>

          <el-table-column
            prop="appleId"
            label="ID 账号"
            min-width="220"
            sortable="custom"
            show-overflow-tooltip
          >
            <template #default="{ row }">
              <strong class="v2-table-cell">{{ row.appleIdMasked }}</strong>
            </template>
          </el-table-column>
          <el-table-column label="销售状态" min-width="130">
            <template #default="{ row }">
              <el-tag :type="row.saleState === 'sold' ? 'danger' : 'success'" effect="plain">
                {{ row.saleState === 'sold' ? '已卖出' : '可用' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="来源订单" min-width="180" show-overflow-tooltip>
            <template #default="{ row }">{{ row.soldByOrder?.orderNo || '-' }}</template>
          </el-table-column>
          <el-table-column label="国家" min-width="110">
            <template #default="{ row }">{{ row.country.name }}</template>
          </el-table-column>
          <el-table-column prop="currentBalance" label="余额" min-width="110" sortable="custom">
            <template #default="{ row }">{{ page.formatDecimal(row.currentBalance) }}</template>
          </el-table-column>
          <el-table-column label="汇率" min-width="110">
            <template #default="{ row }">{{ page.getAccountExchangeRate(row) }}</template>
          </el-table-column>
          <el-table-column
            prop="balanceCostAmount"
            label="人民币成本"
            min-width="130"
            sortable="custom"
          >
            <template #default="{ row }">¥{{ page.formatDecimal(row.balanceCostAmount) }}</template>
          </el-table-column>
          <el-table-column label="供应商" min-width="120">
            <template #default="{ row }">{{ row.supplier?.name || '-' }}</template>
          </el-table-column>
          <el-table-column label="ID 状态" min-width="110">
            <template #default="{ row }">
              <el-tag
                :type="
                  row.lossStatus === 'reported'
                    ? 'danger'
                    : row.status.code === 'normal'
                      ? 'success'
                      : 'warning'
                "
                effect="plain"
              >
                {{ row.lossStatus === 'reported' ? '已报损（冻结）' : row.status.name }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="recordStatus" label="资料状态" min-width="110" sortable="custom">
            <template #default="{ row }">
              <el-tag :type="row.recordStatus === 'active' ? 'success' : 'info'" effect="plain">
                {{ row.recordStatus === 'active' ? '启用' : '停用' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="updatedAt" label="更新时间" min-width="165" sortable="custom">
            <template #default="{ row }">{{ page.formatDate(row.updatedAt) }}</template>
          </el-table-column>
          <V2TableActionColumn layout="triple">
            <template #default="{ row }">
              <V2AccountRowActions
                :record-status="row.recordStatus"
                :loss-reported="row.lossStatus === 'reported'"
                :can-view-sensitive="canOpenSensitiveAccess(row)"
                :can-update="page.canUpdate && row.lossStatus !== 'reported'"
                :can-delete="page.canDelete && row.lossStatus !== 'reported'"
                :can-report-loss="page.canReportLoss"
                @view-sensitive="page.openSensitiveAccess(row)"
                @edit="page.openEdit(row)"
                @toggle-status="page.toggleStatus(row)"
                @report-loss="page.openReportLoss(row)"
                @delete="page.openDelete(row)"
              />
            </template>
          </V2TableActionColumn>
        </el-table>

        <div class="v2-records-mobile-list">
          <article v-for="item in page.items" :key="item.id" class="v2-records-mobile-item">
            <header>
              <div>
                <strong>{{ item.appleIdMasked }}</strong>
                <span>{{ item.country.name }} / {{ item.supplier?.name || '未设置供应商' }}</span>
              </div>
              <el-tag
                :type="
                  item.lossStatus === 'reported'
                    ? 'danger'
                    : item.recordStatus === 'active'
                      ? 'success'
                      : 'info'
                "
                effect="plain"
              >
                {{
                  item.lossStatus === 'reported'
                    ? '已报损（冻结）'
                    : item.recordStatus === 'active'
                      ? '启用'
                      : '停用'
                }}
              </el-tag>
            </header>
            <dl>
              <div>
                <dt>ID 状态</dt>
                <dd>
                  {{ item.lossStatus === 'reported' ? '已报损（冻结）' : item.status.name }}
                </dd>
              </div>
              <div>
                <dt>销售状态</dt>
                <dd>{{ item.saleState === 'sold' ? '已卖出' : '可用' }}</dd>
              </div>
              <div>
                <dt>来源订单</dt>
                <dd>{{ item.soldByOrder?.orderNo || '-' }}</dd>
              </div>
              <div>
                <dt>手机号</dt>
                <dd>{{ item.maskedPhone || '-' }}</dd>
              </div>
              <div>
                <dt>ID 密码</dt>
                <dd>{{ item.hasPassword ? '已保存' : '-' }}</dd>
              </div>
              <div>
                <dt>密保</dt>
                <dd class="v2-account-security-text">
                  {{ item.hasSecurityInfo ? '已保存' : '-' }}
                </dd>
              </div>
              <div>
                <dt>余额</dt>
                <dd>{{ page.formatDecimal(item.currentBalance) }}</dd>
              </div>
              <div>
                <dt>汇率</dt>
                <dd>{{ page.getAccountExchangeRate(item) }}</dd>
              </div>
              <div>
                <dt>人民币成本</dt>
                <dd>¥{{ page.formatDecimal(item.balanceCostAmount) }}</dd>
              </div>
              <div>
                <dt>ID购买成本</dt>
                <dd>¥{{ page.formatDecimal(item.purchaseCost) }}</dd>
              </div>
              <div>
                <dt>更新时间</dt>
                <dd>{{ page.formatDate(item.updatedAt) }}</dd>
              </div>
            </dl>
            <footer>
              <V2AccountRowActions
                :record-status="item.recordStatus"
                :loss-reported="item.lossStatus === 'reported'"
                :can-view-sensitive="canOpenSensitiveAccess(item)"
                :can-update="page.canUpdate && item.lossStatus !== 'reported'"
                :can-delete="page.canDelete && item.lossStatus !== 'reported'"
                :can-report-loss="page.canReportLoss"
                @view-sensitive="page.openSensitiveAccess(item)"
                @edit="page.openEdit(item)"
                @toggle-status="page.toggleStatus(item)"
                @report-loss="page.openReportLoss(item)"
                @delete="page.openDelete(item)"
              />
            </footer>
          </article>
          <div v-if="!page.items.length" class="v2-records-empty">
            <strong>暂无 ID 资料</strong>
            <span>当前筛选条件下没有数据</span>
            <AppButton v-if="page.canCreate" variant="primary" @click="page.openCreate"
              >新增 ID</AppButton
            >
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

    <V2AccountDialogs :page="page" />
  </section>
</template>

<script setup lang="ts">
import { reactive } from 'vue';
import { Lock, MoreFilled, Plus, Refresh, Search } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2FilterDisclosure from '@/v2/components/V2FilterDisclosure.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import V2AccountDialogs from './components/V2AccountDialogs.vue';
import V2AccountRowActions from './components/V2AccountRowActions.vue';
import { useAccountsPage } from './useAccountsPage';
import type { V2Account } from './contracts';
import '@/v2/styles/records.css';

const accountPage = useAccountsPage();
const importFileInput = accountPage.importFileInput;
const page = reactive(accountPage);

function canOpenSensitiveAccess(item: V2Account) {
  return (
    page.canRevealAppleId ||
    (item.hasPassword && page.canRevealPassword) ||
    (item.hasPhone && page.canRevealPhone) ||
    (item.hasSecurityInfo && page.canRevealSecurity)
  );
}
</script>
