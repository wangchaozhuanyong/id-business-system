<template>
  <section class="v2-records-page">
    <V2PageContext
      description="集中管理 ID 资料、余额成本、销售关系和敏感信息；状态变更与敏感资料访问均保留审计记录。"
      aria-label="ID 管理说明"
    >
      <template #meta>
        <span>ID 资料库 · 账号默认脱敏展示</span>
      </template>
      <template #actions>
        <div class="v2-account-command-panel__actions">
          <AppButton variant="ghost" :disabled="page.loading" @click="page.loadAccounts">
            <el-icon><Refresh /></el-icon>
            刷新
          </AppButton>
          <el-dropdown trigger="click" @command="page.handleToolbarCommand">
            <AppButton variant="ghost" :loading="page.exporting">
              <el-icon><MoreFilled /></el-icon>
              数据工具
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
        </div>
      </template>
    </V2PageContext>

    <section class="v2-account-command-panel" aria-label="ID 管理工具">
      <V2AccountLifecycleTabs :model-value="page.query.lifecycle" @select="selectLifecycle" />
      <div class="v2-account-filter-grid" aria-label="ID 筛选">
        <el-input
          v-model="page.query.keyword"
          class="v2-account-filter-grid__search"
          clearable
          placeholder="搜索 ID 账号、手机号或供应商"
          aria-label="搜索 ID 资料"
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
        <V2FilterDisclosure
          :label="page.activeFilterCount ? `更多筛选 · ${page.activeFilterCount}` : '更多筛选'"
        >
          <el-select
            v-model="page.query.statusOptionId"
            clearable
            placeholder="全部 ID 状态"
            aria-label="筛选 ID 状态"
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
            v-model="page.query.supplierOptionId"
            clearable
            placeholder="全部供应商"
            aria-label="筛选 ID 供应商"
            @change="page.handleFilterChange"
          >
            <el-option
              v-for="option in page.supplierOptions"
              :key="option.id"
              :label="option.name"
              :value="option.id"
            />
          </el-select>
        </V2FilterDisclosure>
        <AppButton variant="soft" @click="page.handleSearch">
          <el-icon><Search /></el-icon>
          查询
        </AppButton>
        <AppButton v-if="page.activeFilterCount" variant="ghost" @click="page.resetFilters">
          重置
        </AppButton>
      </div>

      <footer class="v2-account-command-panel__footer">
        <p class="v2-records-security-note">
          <el-icon><Lock /></el-icon>
          敏感资料默认脱敏，查看、复制和导出都会写入审计日志。
        </p>
        <span v-if="page.activeFilterCount">已启用 {{ page.activeFilterCount }} 个筛选条件</span>
        <span v-else>当前分类：{{ page.lifecycleLabel }}</span>
      </footer>

      <input
        ref="importFileInput"
        class="v2-sr-only"
        type="file"
        accept=".csv,text/csv"
        @change="page.handleImportFile"
      />
    </section>

    <div class="v2-account-list-heading">
      <div>
        <strong>{{ page.lifecycleLabel }} 列表</strong>
        <span>{{ page.hasLoadedOnce ? `共 ${page.total} 条结果` : '正在准备数据' }}</span>
      </div>
      <span>账号默认脱敏展示</span>
    </div>

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
        <V2Table
          :schema="v2TableSchemas.accounts.main"
          :aria-busy="page.loading"
          scrollbar-always-on
          show-overflow-tooltip
          class="v2-records-table"
          :data="page.items"
          @sort-change="page.handleSortChange"
        >
          <template #empty>
            <div class="v2-records-empty">
              <strong>{{ emptyTitle }}</strong>
              <span>
                {{ page.activeFilterCount ? '当前筛选条件下没有数据' : emptyDescription }}
              </span>
              <AppButton v-if="page.canCreate" variant="primary" @click="page.openCreate"
                >新增 ID</AppButton
              >
            </div>
          </template>

          <V2TableColumn
            :definition="v2TableSchemas.accounts.main.columns[0]"
            prop="appleId"
            sortable="custom"
            show-overflow-tooltip
          >
            <template #default="{ row }">
              <strong class="v2-table-cell">{{ row.appleIdMasked }}</strong>
            </template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.accounts.main.columns[1]">
            <template #default="{ row }">
              <el-tag :type="row.saleState === 'sold' ? 'danger' : 'success'" effect="plain">
                {{ row.saleState === 'sold' ? '已卖出' : '可用' }}
              </el-tag>
            </template>
          </V2TableColumn>
          <V2TableColumn
            :definition="v2TableSchemas.accounts.main.columns[2]"
            show-overflow-tooltip
          >
            <template #header>
              <span class="v2-records-help-title">
                来源订单
                <FeatureHelp
                  title="来源订单"
                  :text="sourceOrderHelp"
                  placement="bottom"
                  :width="300"
                />
              </span>
            </template>
            <template #default="{ row }">{{ row.soldByOrder?.orderNo || '—' }}</template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.accounts.main.columns[3]">
            <template #default="{ row }">{{ row.country.name }}</template>
          </V2TableColumn>
          <V2TableColumn
            :definition="v2TableSchemas.accounts.main.columns[4]"
            prop="currentBalance"
            sortable="custom"
          >
            <template #default="{ row }">{{ page.formatDecimal(row.currentBalance) }}</template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.accounts.main.columns[5]">
            <template #default="{ row }">{{ page.getAccountExchangeRate(row) }}</template>
          </V2TableColumn>
          <V2TableColumn
            :definition="v2TableSchemas.accounts.main.columns[6]"
            prop="balanceCostAmount"
            sortable="custom"
          >
            <template #default="{ row }">¥{{ page.formatDecimal(row.balanceCostAmount) }}</template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.accounts.main.columns[7]">
            <template #default="{ row }">{{ row.supplier?.name || '—' }}</template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.accounts.main.columns[8]">
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
                {{ row.lossStatus === 'reported' ? '已报损冻结' : row.status.name }}
              </el-tag>
            </template>
          </V2TableColumn>
          <V2TableColumn
            :definition="v2TableSchemas.accounts.main.columns[9]"
            prop="recordStatus"
            sortable="custom"
          >
            <template #default="{ row }">
              <V2AccountRecordStatusBadge
                :account="row"
                @view-reason="page.openDisabledReason(row)"
              />
            </template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.accounts.main.columns[10]">
            <template #default="{ row }">{{ operatorUsername(row.createdBy) }}</template>
          </V2TableColumn>
          <V2TableColumn
            :definition="v2TableSchemas.accounts.main.columns[11]"
            prop="updatedAt"
            sortable="custom"
          >
            <template #default="{ row }">{{ page.formatDate(row.updatedAt) }}</template>
          </V2TableColumn>
          <V2TableActionColumn :definition="v2TableSchemas.accounts.main.columns[12]">
            <template #default="{ row }">
              <V2AccountRowActions
                :record-status="row.recordStatus"
                :sale-state="row.saleState"
                :loss-reported="row.lossStatus === 'reported'"
                :can-view-sensitive="canOpenSensitiveAccess(row)"
                :can-update="page.canUpdate && row.lossStatus !== 'reported'"
                :can-report-loss="page.canReportLoss"
                @view-sensitive="page.openSensitiveAccess(row)"
                @edit="page.openEdit(row)"
                @toggle-status="page.openRecordStatusChange(row)"
                @report-loss="page.openReportLoss(row)"
                @unfreeze-loss="page.openUnfreezeLoss(row)"
              />
            </template>
          </V2TableActionColumn>
        </V2Table>

        <div class="v2-records-mobile-list" :data-mobile-for="v2TableSchemas.accounts.main.id">
          <article v-for="item in page.items" :key="item.id" class="v2-records-mobile-item">
            <header>
              <div>
                <strong v-v2-column-visibility="[v2TableSchemas.accounts.main.id, 'appleId']">
                  {{ item.appleIdMasked }}
                </strong>
                <span v-v2-column-visibility="[v2TableSchemas.accounts.main.id, '国家']">
                  {{ item.country.name }}
                </span>
                <span v-v2-column-visibility="[v2TableSchemas.accounts.main.id, '供应商']">
                  {{ item.supplier?.name || '未设置供应商' }}
                </span>
              </div>
              <V2AccountRecordStatusBadge
                v-v2-column-visibility="[v2TableSchemas.accounts.main.id, 'recordStatus']"
                :account="item"
                @view-reason="page.openDisabledReason(item)"
              />
            </header>
            <dl>
              <div v-v2-column-visibility="[v2TableSchemas.accounts.main.id, 'ID 状态']">
                <dt>ID 状态</dt>
                <dd>
                  {{ item.lossStatus === 'reported' ? '已报损冻结' : item.status.name }}
                </dd>
              </div>
              <div v-v2-column-visibility="[v2TableSchemas.accounts.main.id, '销售状态']">
                <dt>销售状态</dt>
                <dd>{{ item.saleState === 'sold' ? '已卖出' : '可用' }}</dd>
              </div>
              <div v-v2-column-visibility="[v2TableSchemas.accounts.main.id, '来源订单']">
                <dt class="v2-records-help-title">
                  来源订单
                  <FeatureHelp
                    title="来源订单"
                    :text="sourceOrderHelp"
                    placement="bottom"
                    :width="300"
                  />
                </dt>
                <dd>{{ item.soldByOrder?.orderNo || '—' }}</dd>
              </div>
              <div>
                <dt>手机号</dt>
                <dd>{{ item.maskedPhone || '—' }}</dd>
              </div>
              <div>
                <dt>ID 密码</dt>
                <dd>{{ item.hasPassword ? '已保存' : '—' }}</dd>
              </div>
              <div>
                <dt>密保</dt>
                <dd class="v2-account-security-text">
                  {{ item.hasSecurityInfo ? '已保存' : '—' }}
                </dd>
              </div>
              <div v-v2-column-visibility="[v2TableSchemas.accounts.main.id, 'currentBalance']">
                <dt>余额</dt>
                <dd>{{ page.formatDecimal(item.currentBalance) }}</dd>
              </div>
              <div v-v2-column-visibility="[v2TableSchemas.accounts.main.id, '汇率']">
                <dt>汇率</dt>
                <dd>{{ page.getAccountExchangeRate(item) }}</dd>
              </div>
              <div v-v2-column-visibility="[v2TableSchemas.accounts.main.id, 'balanceCostAmount']">
                <dt>人民币成本</dt>
                <dd>¥{{ page.formatDecimal(item.balanceCostAmount) }}</dd>
              </div>
              <div>
                <dt>ID购买成本</dt>
                <dd>¥{{ page.formatDecimal(item.purchaseCost) }}</dd>
              </div>
              <div v-v2-column-visibility="[v2TableSchemas.accounts.main.id, '操作人']">
                <dt>操作人</dt>
                <dd>{{ operatorUsername(item.createdBy) }}</dd>
              </div>
              <div v-v2-column-visibility="[v2TableSchemas.accounts.main.id, 'updatedAt']">
                <dt>更新时间</dt>
                <dd>{{ page.formatDate(item.updatedAt) }}</dd>
              </div>
            </dl>
            <footer>
              <V2AccountRowActions
                :record-status="item.recordStatus"
                :sale-state="item.saleState"
                :loss-reported="item.lossStatus === 'reported'"
                :can-view-sensitive="canOpenSensitiveAccess(item)"
                :can-update="page.canUpdate && item.lossStatus !== 'reported'"
                :can-report-loss="page.canReportLoss"
                @view-sensitive="page.openSensitiveAccess(item)"
                @edit="page.openEdit(item)"
                @toggle-status="page.openRecordStatusChange(item)"
                @report-loss="page.openReportLoss(item)"
                @unfreeze-loss="page.openUnfreezeLoss(item)"
              />
            </footer>
          </article>
          <div v-if="!page.items.length" class="v2-records-empty">
            <strong>{{ emptyTitle }}</strong>
            <span>
              {{ page.activeFilterCount ? '当前筛选条件下没有数据' : emptyDescription }}
            </span>
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
import V2Table from '@/v2/components/V2Table.vue';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import { computed, reactive } from 'vue';
import { useRouter } from 'vue-router';
import { Lock, MoreFilled, Plus, Refresh, Search } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import FeatureHelp from '@/components/ui/FeatureHelp.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2FilterDisclosure from '@/v2/components/V2FilterDisclosure.vue';
import V2PageContext from '@/v2/components/V2PageContext.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import { operatorUsername } from '@/v2/utils/operator';
import V2AccountDialogs from './components/V2AccountDialogs.vue';
import V2AccountLifecycleTabs from './components/V2AccountLifecycleTabs.vue';
import V2AccountRecordStatusBadge from './components/V2AccountRecordStatusBadge.vue';
import V2AccountRowActions from './components/V2AccountRowActions.vue';
import { useAccountsPage } from './useAccountsPage';
import type { V2Account, V2AccountLifecycle } from './contracts';
import '@/v2/styles/records.css';
import '@/v2/styles/accounts.css';

const accountPage = useAccountsPage();
const router = useRouter();
const importFileInput = accountPage.importFileInput;
const page = reactive(accountPage);
const sourceOrderHelp =
  '这个 ID 被订单卖出后，系统会在这里显示对应订单号；未卖出或没有关联订单时显示空横线。';
const emptyTitle = computed(() => `暂无${page.lifecycleLabel}`);
const emptyDescription = computed(
  () =>
    ({
      available: '当前没有可用于业务的 ID',
      disabled: '当前没有已停用的 ID',
      sold: '当前没有已售出的 ID',
      reported: '当前没有已报损的 ID'
    })[page.query.lifecycle]
);

function selectLifecycle(lifecycle: V2AccountLifecycle) {
  if (lifecycle === 'reported') {
    void router.push('/v2/records/account-losses');
    return;
  }
  page.changeLifecycle(lifecycle);
}

function canOpenSensitiveAccess(item: V2Account) {
  return (
    page.canRevealAppleId ||
    (item.hasPassword && page.canRevealPassword) ||
    (item.hasPhone && page.canRevealPhone) ||
    (item.hasSecurityInfo && page.canRevealSecurity)
  );
}
</script>
