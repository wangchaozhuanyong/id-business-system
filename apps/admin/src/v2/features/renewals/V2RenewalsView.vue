<template>
  <section class="v2-records-page">
    <V2StatusStrip
      :items="renewalStatusStripItems"
      :active-key="activeWarningScope"
      aria-label="续费到期预警汇总"
      @select="selectWarningScope"
    />

    <section class="v2-records-toolbar v2-renewals-toolbar" aria-label="续费记录筛选">
      <el-input
        v-model="query.keyword"
        clearable
        placeholder="订单、客户、ID账号、网站账号"
        aria-label="搜索续费记录"
        @keyup.enter="handleSearch"
        @clear="handleSearch"
      />
      <el-select
        v-model="query.dueStatus"
        clearable
        placeholder="全部到期状态"
        aria-label="筛选到期状态"
        @change="handleTimeFilterChange"
      >
        <el-option
          v-for="option in dueStatusOptions"
          :key="option.value"
          :label="option.label"
          :value="option.value"
        />
      </el-select>
      <el-date-picker
        v-model="dueRange"
        type="daterange"
        value-format="YYYY-MM-DD"
        range-separator="至"
        start-placeholder="到期开始"
        end-placeholder="到期结束"
        aria-label="自行设定到期日期范围"
        @change="handleTimeFilterChange"
      />
      <V2FilterDisclosure>
        <el-select
          v-model="query.customerId"
          clearable
          filterable
          placeholder="全部客户"
          aria-label="筛选客户"
          @change="handleFilterChange"
        >
          <el-option
            v-for="option in filterOptions.customers"
            :key="option.id"
            :label="option.name"
            :value="option.id"
          />
        </el-select>
        <el-select
          v-model="query.serviceOptionId"
          clearable
          filterable
          placeholder="全部业务"
          aria-label="筛选业务"
          @change="handleFilterChange"
        >
          <el-option
            v-for="option in filterOptions.services"
            :key="option.id"
            :label="serviceLabel(option)"
            :value="option.id"
          />
        </el-select>
        <el-select
          v-model="query.accountId"
          clearable
          filterable
          placeholder="全部 ID"
          aria-label="筛选苹果 ID"
          @change="handleFilterChange"
        >
          <el-option
            v-for="option in filterOptions.accounts"
            :key="option.id"
            :label="option.appleIdMasked"
            :value="option.id"
          />
        </el-select>
      </V2FilterDisclosure>
      <div class="v2-records-toolbar__actions">
        <AppButton
          v-if="canManageWarning"
          variant="ghost"
          title="设置续费提前预警天数"
          @click="openWarningSettings"
        >
          <el-icon><Setting /></el-icon>
          预警设置
        </AppButton>
        <AppButton variant="ghost" :disabled="loading" title="刷新续费记录" @click="loadWorkbench">
          <el-icon><Refresh /></el-icon>
          刷新
        </AppButton>
        <AppButton variant="primary" @click="handleSearch">
          <el-icon><Search /></el-icon>
          查询
        </AppButton>
      </div>
    </section>

    <V2AsyncRegion
      skeleton="table"
      :loading="loading || isInitialLoading"
      :resolved="hasLoadedOnce"
      :error="listError"
      loading-title="正在加载续费记录"
      refreshing-title="正在更新续费记录"
      error-title="续费记录加载失败"
      @retry="loadWorkbench"
    >
      <section class="v2-records-list">
        <el-table
          :aria-busy="loading"
          scrollbar-always-on
          show-overflow-tooltip
          class="v2-records-table"
          :data="items"
          row-key="id"
          :row-class-name="renewalRowClassName"
          @sort-change="handleSortChange"
        >
          <template #empty>
            <div class="v2-records-empty">
              <strong>暂无续费待办</strong>
              <span>{{ emptyDescription }}</span>
            </div>
          </template>

          <V2TableColumn
            kind="text"
            prop="customer"
            label="客户"
            min-width="120"
            fixed="left"
            sortable="custom"
          >
            <template #default="{ row }">{{ row.customer.name }}</template>
          </V2TableColumn>
          <V2TableColumn
            kind="identifier"
            width-preset="identifier"
            prop="account"
            label="ID账号"
            sortable="custom"
          >
            <template #default="{ row }">{{ row.account.appleIdMasked }}</template>
          </V2TableColumn>
          <V2TableColumn kind="text" label="国家" min-width="105">
            <template #default="{ row }">{{ row.account.country.name }}</template>
          </V2TableColumn>
          <V2TableColumn kind="identifier" width-preset="wide" label="客户网站账号">
            <template #default="{ row }">{{ row.maskedWebsiteAccount || '—' }}</template>
          </V2TableColumn>
          <V2TableColumn
            kind="numeric"
            width-preset="compact"
            prop="currentBalance"
            label="ID余额"
            sortable="custom"
          >
            <template #default="{ row }">
              <strong class="v2-renewal-balance">{{
                formatDecimal(row.account.currentBalance)
              }}</strong>
            </template>
          </V2TableColumn>
          <V2TableColumn
            kind="text"
            prop="service"
            label="当前业务"
            min-width="125"
            sortable="custom"
          >
            <template #default="{ row }">{{ row.service.name }}</template>
          </V2TableColumn>
          <V2TableColumn
            kind="date"
            width-preset="dateTime"
            prop="dueAt"
            label="到期时间"
            sortable="custom"
          >
            <template #default="{ row }">{{ formatDate(row.dueAt) }}</template>
          </V2TableColumn>
          <V2TableColumn kind="status" width-preset="compact" label="状态" fixed="right">
            <template #default="{ row }">
              <span class="v2-renewal-status">
                <el-tag :type="statusType(row.status.code)" effect="plain">
                  {{
                    row.warningState === 'upcoming' && row.status.code === 'active'
                      ? `${row.status.label} · 预警`
                      : row.status.label
                  }}
                </el-tag>
              </span>
            </template>
          </V2TableColumn>
          <V2TableActionColumn layout="single">
            <template #default="{ row }">
              <el-tooltip
                :disabled="!renewalActionDisabledReason(row)"
                :content="renewalActionDisabledReason(row)"
              >
                <span>
                  <AppButton
                    v-if="canRenew"
                    size="small"
                    variant="primary"
                    :disabled="!row.withinActionWindow"
                    title="录入续费订单"
                    @click="openRenewalDrawer(row)"
                  >
                    <el-icon><CirclePlus /></el-icon>
                    续费
                  </AppButton>
                  <span v-else>—</span>
                </span>
              </el-tooltip>
            </template>
          </V2TableActionColumn>
        </el-table>

        <div class="v2-records-mobile-list">
          <article
            v-for="item in items"
            :key="item.id"
            class="v2-records-mobile-item"
            :class="{
              'is-renewal-warning': item.warningState === 'upcoming',
              'is-renewal-expired': item.warningState === 'expired'
            }"
          >
            <header>
              <div>
                <strong>{{ item.customer.name }}</strong>
                <span>{{ item.service.name }}</span>
              </div>
              <el-tag :type="statusType(item.status.code)" effect="plain">
                {{ item.status.label }}
              </el-tag>
            </header>
            <dl>
              <div>
                <dt>ID账号</dt>
                <dd>{{ item.account.appleIdMasked }}</dd>
              </div>
              <div>
                <dt>ID余额</dt>
                <dd>{{ formatDecimal(item.account.currentBalance) }}</dd>
              </div>
              <div>
                <dt>网站账号</dt>
                <dd>{{ item.maskedWebsiteAccount || '—' }}</dd>
              </div>
              <div>
                <dt>到期时间</dt>
                <dd>{{ formatDate(item.dueAt) }}</dd>
              </div>
            </dl>
            <footer>
              <span>{{ item.orderNo }}</span>
              <AppButton
                v-if="canRenew"
                size="small"
                variant="primary"
                :disabled="!item.withinActionWindow"
                :title="renewalActionDisabledReason(item) || '录入续费订单'"
                @click="openRenewalDrawer(item)"
              >
                <el-icon><CirclePlus /></el-icon>
                续费
              </AppButton>
            </footer>
          </article>
          <div v-if="!items.length" class="v2-records-empty">
            <strong>暂无续费待办</strong>
            <span>当前筛选条件下没有数据</span>
          </div>
        </div>

        <footer class="v2-records-pagination">
          <span>
            共 {{ total }} 条
            <template v-if="evaluatedAt"> · 状态计算于 {{ formatTime(evaluatedAt) }}</template>
          </span>
          <el-pagination
            v-model:current-page="query.page"
            v-model:page-size="query.pageSize"
            v-pagination-label
            background
            :page-sizes="[10, 20, 50, 100]"
            layout="sizes, prev, pager, next"
            :total="total"
            @current-change="handlePageChange"
            @size-change="handlePageSizeChange"
          />
        </footer>
      </section>
    </V2AsyncRegion>

    <V2RenewalWarningSettingsDialog
      v-model="warningSettingsVisible"
      v-model:warning-days="warningDaysInput"
      :settings="warningSettings"
      :loading="warningSettingsLoading"
      :saving="warningSettingsSaving"
      :error="warningSettingsError"
      :can-manage="canManageWarning"
      @save="saveWarningSettings"
    />

    <V2RenewalOrderDrawer
      v-model="drawerVisible"
      v-model:confirmation-visible="confirmationVisible"
      v-model:service-option-id="form.serviceOptionId"
      v-model:settlement-platform-option-id="form.settlementPlatformOptionId"
      v-model:platform-order-no="form.platformOrderNo"
      v-model:received-amount="form.receivedAmount"
      v-model:balance-amount="form.balanceAmount"
      v-model:opened-at="form.openedAt"
      v-model:due-at="form.dueAt"
      v-model:remark="form.remark"
      :renewal="selectedRenewal"
      :services="availableServices"
      :settlement-platforms="options.settlementPlatforms"
      :selected-service="selectedManualService"
      :options-loading="optionsLoading"
      :options-error="optionsError"
      :submitting="submitting"
      :submit-disabled-reason="renewalSubmitDisabledReason"
      :platform-fee-preview="platformFeePreview"
      :balance-after-preview="balanceAfterPreview"
      :confirmation-message="confirmationMessage"
      @opened-at-change="handleRenewalOpenedAtChange"
      @settlement-platform-change="handleSettlementPlatformChange"
      @open-confirmation="openConfirmation"
      @submit="submitRenewal"
    />
  </section>
</template>

<script setup lang="ts">
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import { CirclePlus, Refresh, Search, Setting } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2FilterDisclosure from '@/v2/components/V2FilterDisclosure.vue';
import V2StatusStrip from '@/v2/components/V2StatusStrip.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import V2RenewalOrderDrawer from './components/V2RenewalOrderDrawer.vue';
import V2RenewalWarningSettingsDialog from './components/V2RenewalWarningSettingsDialog.vue';
import { useRenewalsPage } from './useRenewalsPage';
import '@/v2/styles/records.css';
import '@/v2/styles/renewals.css';

const {
  dueStatusOptions,
  canRenew,
  canManageWarning,
  items,
  total,
  evaluatedAt,
  loading,
  listError,
  dueRange,
  warningSettings,
  warningSettingsVisible,
  warningSettingsLoading,
  warningSettingsSaving,
  warningSettingsError,
  warningDaysInput,
  filterOptions,
  options,
  optionsLoading,
  optionsError,
  drawerVisible,
  confirmationVisible,
  submitting,
  selectedRenewal,
  form,
  query,
  availableServices,
  selectedManualService,
  platformFeePreview,
  balanceAfterPreview,
  renewalSubmitDisabledReason,
  renewalStatusStripItems,
  activeWarningScope,
  emptyDescription,
  confirmationMessage,
  hasLoadedOnce,
  isInitialLoading,
  loadWorkbench,
  handleSearch,
  handleFilterChange,
  handleTimeFilterChange,
  selectWarningScope,
  handlePageSizeChange,
  handlePageChange,
  handleSortChange,
  openRenewalDrawer,
  renewalActionDisabledReason,
  renewalRowClassName,
  openWarningSettings,
  saveWarningSettings,
  handleRenewalOpenedAtChange,
  handleSettlementPlatformChange,
  openConfirmation,
  submitRenewal,
  serviceLabel,
  formatDecimal,
  formatDate,
  formatTime,
  statusType
} = useRenewalsPage();
</script>
