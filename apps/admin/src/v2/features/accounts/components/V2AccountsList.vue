<template>
  <V2AsyncRegion
    skeleton="table"
    :phase="page.queryPhase"
    :previous-data="page.isParameterTransition"
    :error="page.listError"
    loading-title="正在加载 ID 资料"
    refreshing-title="正在更新 ID 资料"
    error-title="ID 资料加载失败"
    @retry="page.loadAccounts"
  >
    <section ref="listRef" class="v2-records-list" :style="listFrameStyle">
      <header class="v2-account-list-heading">
        <V2SectionHeading
          :title="`${page.lifecycleLabel} 列表`"
          help="账号默认脱敏展示；固定操作列保留敏感查看、编辑和状态操作入口。"
        >
          <template #actions>
            <V2TableColumnSettings inline :schema="v2TableSchemas.accounts.main" />
            <span>本页 {{ page.items.length }} 条</span>
            <span aria-hidden="true">·</span>
            <strong>共 {{ page.total }} 条</strong>
          </template>
        </V2SectionHeading>
      </header>

      <V2Table
        :schema="v2TableSchemas.accounts.main"
        :show-column-settings="false"
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
            <span>{{ page.activeFilterCount ? '当前筛选条件下没有数据' : emptyDescription }}</span>
            <AppButton v-if="page.canCreate" variant="primary" @click="page.openCreate">
              新增 ID
            </AppButton>
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
        <V2TableColumn :definition="v2TableSchemas.accounts.main.columns[2]" show-overflow-tooltip>
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
              :disabled="page.isParameterTransition"
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
              <dd>{{ item.lossStatus === 'reported' ? '已报损冻结' : item.status.name }}</dd>
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
              <dd class="v2-account-security-text">{{ item.hasSecurityInfo ? '已保存' : '—' }}</dd>
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
              :disabled="page.isParameterTransition"
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
          <span>{{ page.activeFilterCount ? '当前筛选条件下没有数据' : emptyDescription }}</span>
          <AppButton v-if="page.canCreate" variant="primary" @click="page.openCreate">
            新增 ID
          </AppButton>
        </div>
      </div>

      <footer class="v2-records-pagination">
        <span>共 {{ page.total }} 条</span>
        <el-pagination
          v-pagination-label
          :current-page="page.displayedPage"
          :page-size="page.displayedPageSize"
          background
          :disabled="page.isParameterTransition"
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
import { computed } from 'vue';
import type { UnwrapNestedRefs } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import FeatureHelp from '@/components/ui/FeatureHelp.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import V2Table from '@/v2/components/V2Table.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import V2TableColumnSettings from '@/v2/components/V2TableColumnSettings.vue';
import { useV2StableListFrame } from '@/v2/composables/useV2StableListFrame';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import { operatorUsername } from '@/v2/utils/operator';
import V2AccountRecordStatusBadge from './V2AccountRecordStatusBadge.vue';
import V2AccountRowActions from './V2AccountRowActions.vue';
import type { useAccountsPage } from '../useAccountsPage';
import type { V2Account } from '../contracts';

type AccountsPage = UnwrapNestedRefs<ReturnType<typeof useAccountsPage>>;

const props = defineProps<{
  page: AccountsPage;
}>();

const sourceOrderHelp =
  '这个 ID 被订单卖出后，系统会在这里显示对应订单号；未卖出或没有关联订单时显示空横线。';
const emptyTitle = computed(() => `暂无${props.page.lifecycleLabel}`);
const emptyDescription = computed(
  () =>
    ({
      available: '当前没有可用于业务的 ID',
      disabled: '当前没有已停用的 ID',
      sold: '当前没有已售出的 ID',
      reported: '当前没有已报损的 ID'
    })[props.page.query.lifecycle]
);
const { listRef, listFrameStyle } = useV2StableListFrame({
  items: () => props.page.items,
  pageSize: () => props.page.displayedPageSize
});

function canOpenSensitiveAccess(item: V2Account) {
  return (
    props.page.canRevealAppleId ||
    (item.hasPassword && props.page.canRevealPassword) ||
    (item.hasPhone && props.page.canRevealPhone) ||
    (item.hasSecurityInfo && props.page.canRevealSecurity)
  );
}
</script>
