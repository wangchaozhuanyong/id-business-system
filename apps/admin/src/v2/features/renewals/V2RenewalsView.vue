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

          <el-table-column
            prop="customer"
            label="客户"
            min-width="120"
            fixed="left"
            sortable="custom"
          >
            <template #default="{ row }">{{ row.customer.name }}</template>
          </el-table-column>
          <el-table-column prop="account" label="ID账号" min-width="165" sortable="custom">
            <template #default="{ row }">{{ row.account.appleIdMasked }}</template>
          </el-table-column>
          <el-table-column label="国家" min-width="105">
            <template #default="{ row }">{{ row.account.country.name }}</template>
          </el-table-column>
          <el-table-column label="客户网站账号" min-width="150">
            <template #default="{ row }">{{ row.maskedWebsiteAccount || '-' }}</template>
          </el-table-column>
          <el-table-column prop="currentBalance" label="ID余额" min-width="92" sortable="custom">
            <template #default="{ row }">
              <strong class="v2-renewal-balance">{{
                formatDecimal(row.account.currentBalance)
              }}</strong>
            </template>
          </el-table-column>
          <el-table-column prop="service" label="当前业务" min-width="125" sortable="custom">
            <template #default="{ row }">{{ row.service.name }}</template>
          </el-table-column>
          <el-table-column prop="dueAt" label="到期时间" min-width="150" sortable="custom">
            <template #default="{ row }">{{ formatDate(row.dueAt) }}</template>
          </el-table-column>
          <el-table-column label="状态" width="116" fixed="right">
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
          </el-table-column>
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
                  <span v-else>-</span>
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
                <dd>{{ item.maskedWebsiteAccount || '-' }}</dd>
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

    <el-dialog
      v-model="warningSettingsVisible"
      title="续费到期预警设置"
      width="min(460px, 92vw)"
      :close-on-click-modal="!warningSettingsSaving"
      :close-on-press-escape="!warningSettingsSaving"
    >
      <section class="v2-renewal-warning-settings">
        <el-alert
          type="info"
          :closable="false"
          show-icon
          title="此设置全局生效"
          :description="`设为 ${warningDaysInput} 天后，工作台和右上角提醒会显示未来 ${warningDaysInput} 天内到期的记录；已到期记录会单独统计。`"
        />
        <p v-if="warningSettingsLoading" class="v2-renewal-warning-settings__state">
          正在读取当前设置…
        </p>
        <el-alert
          v-else-if="warningSettingsError"
          type="error"
          :closable="false"
          show-icon
          :title="warningSettingsError"
        />
        <label v-else>
          <span>提前预警天数</span>
          <el-input-number
            v-model="warningDaysInput"
            :min="warningSettings.minWarningDays"
            :max="warningSettings.maxWarningDays"
            :step="1"
            step-strictly
            controls-position="right"
            aria-label="提前预警天数"
          />
        </label>
        <small>
          可设置 {{ warningSettings.minWarningDays }}–{{ warningSettings.maxWarningDays }} 天。
          实际录入续费仍只允许处理 7 天内到期或已到期记录。
        </small>
      </section>
      <template #footer>
        <AppButton
          variant="ghost"
          :disabled="warningSettingsSaving"
          @click="warningSettingsVisible = false"
        >
          取消
        </AppButton>
        <AppButton
          variant="primary"
          :loading="warningSettingsSaving"
          :disabled="warningSettingsLoading || Boolean(warningSettingsError)"
          @click="saveWarningSettings"
        >
          保存设置
        </AppButton>
      </template>
    </el-dialog>

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
      :can-submit="canSubmitRenewal"
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
import { CirclePlus, Refresh, Search, Setting } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2FilterDisclosure from '@/v2/components/V2FilterDisclosure.vue';
import V2StatusStrip from '@/v2/components/V2StatusStrip.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import V2RenewalOrderDrawer from './components/V2RenewalOrderDrawer.vue';
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
  canSubmitRenewal,
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
