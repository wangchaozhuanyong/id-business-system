<template>
  <V2AsyncRegion
    skeleton="table"
    :phase="page.queryPhase"
    :previous-data="page.isParameterTransition"
    :error="page.listError"
    loading-title="正在加载续费记录"
    refreshing-title="正在更新续费记录"
    error-title="续费记录加载失败"
    @retry="page.loadWorkbench"
  >
    <section ref="listRef" class="v2-records-list" :style="listFrameStyle">
      <header class="v2-renewal-list__header">
        <V2SectionHeading
          title="续费待办列表"
          help="临期与到期行使用状态色提示；续费按钮继续受权限和执行时间窗控制。"
        >
          <template #actions>
            <V2TableColumnSettings inline :schema="v2TableSchemas.renewals.main" />
            <span>本页 {{ page.items.length }} 条</span>
            <span aria-hidden="true">·</span>
            <strong>共 {{ page.total }} 条</strong>
          </template>
        </V2SectionHeading>
      </header>

      <V2Table
        :schema="v2TableSchemas.renewals.main"
        :show-column-settings="false"
        :aria-busy="page.loading"
        scrollbar-always-on
        show-overflow-tooltip
        class="v2-records-table"
        :data="page.items"
        :row-class-name="page.renewalRowClassName"
        @sort-change="page.handleSortChange"
      >
        <template #empty>
          <div class="v2-records-empty">
            <strong>暂无续费待办</strong>
            <span>{{ page.emptyDescription }}</span>
          </div>
        </template>

        <V2TableColumn
          :definition="v2TableSchemas.renewals.main.columns[0]"
          prop="customer"
          sortable="custom"
        >
          <template #default="{ row }">{{ row.customer.name }}</template>
        </V2TableColumn>
        <V2TableColumn
          :definition="v2TableSchemas.renewals.main.columns[1]"
          prop="account"
          sortable="custom"
        >
          <template #default="{ row }">
            <div class="v2-table-cell">
              <strong>{{ row.account.appleIdMasked }}</strong>
              <el-tag v-if="row.account.saleState === 'sold'" type="warning" effect="plain">
                客户已购
              </el-tag>
              <small v-if="row.account.soldByOrder">
                {{ row.account.soldByOrder.orderNo }} · {{ row.account.soldByOrder.customer.name }}
              </small>
            </div>
          </template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.renewals.main.columns[2]">
          <template #default="{ row }">{{ row.account.country.name }}</template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.renewals.main.columns[3]">
          <template #default="{ row }">{{ row.maskedWebsiteAccount || '—' }}</template>
        </V2TableColumn>
        <V2TableColumn
          :definition="v2TableSchemas.renewals.main.columns[4]"
          prop="currentBalance"
          sortable="custom"
        >
          <template #default="{ row }">
            <strong class="v2-renewal-balance">{{
              page.formatDecimal(row.account.currentBalance)
            }}</strong>
          </template>
        </V2TableColumn>
        <V2TableColumn
          :definition="v2TableSchemas.renewals.main.columns[5]"
          prop="service"
          sortable="custom"
        >
          <template #default="{ row }">{{ row.service.name }}</template>
        </V2TableColumn>
        <V2TableColumn
          :definition="v2TableSchemas.renewals.main.columns[6]"
          prop="dueAt"
          sortable="custom"
        >
          <template #default="{ row }">{{ page.formatDate(row.dueAt) }}</template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.renewals.main.columns[7]">
          <template #default="{ row }">
            <span class="v2-renewal-status">
              <el-tag :type="page.statusType(row.status.code)" effect="plain">
                {{
                  row.warningState === 'upcoming' && row.status.code === 'active'
                    ? `${row.status.label} · 预警`
                    : row.status.label
                }}
              </el-tag>
            </span>
          </template>
        </V2TableColumn>
        <V2TableActionColumn :definition="v2TableSchemas.renewals.main.columns[8]">
          <template #default="{ row }">
            <el-tooltip
              :disabled="!page.renewalActionDisabledReason(row)"
              :content="page.renewalActionDisabledReason(row)"
            >
              <span>
                <AppButton
                  v-if="page.canRenew"
                  size="small"
                  variant="primary"
                  :disabled="!row.withinActionWindow"
                  title="录入续费订单"
                  @click="page.openRenewalDrawer(row)"
                >
                  <el-icon><CirclePlus /></el-icon>
                  续费
                </AppButton>
                <span v-else>—</span>
              </span>
            </el-tooltip>
          </template>
        </V2TableActionColumn>
      </V2Table>

      <div class="v2-records-mobile-list" :data-mobile-for="v2TableSchemas.renewals.main.id">
        <article
          v-for="item in page.items"
          :key="item.id"
          class="v2-records-mobile-item"
          :class="{
            'is-renewal-warning': item.warningState === 'upcoming',
            'is-renewal-expired': item.warningState === 'expired'
          }"
        >
          <header>
            <div>
              <strong v-v2-column-visibility="[v2TableSchemas.renewals.main.id, 'customer']">
                {{ item.customer.name }}
              </strong>
              <span v-v2-column-visibility="[v2TableSchemas.renewals.main.id, 'service']">
                {{ item.service.name }}
              </span>
            </div>
            <el-tag
              v-v2-column-visibility="[v2TableSchemas.renewals.main.id, '状态']"
              :type="page.statusType(item.status.code)"
              effect="plain"
            >
              {{ item.status.label }}
            </el-tag>
          </header>
          <dl>
            <div v-v2-column-visibility="[v2TableSchemas.renewals.main.id, 'account']">
              <dt>ID账号</dt>
              <dd>
                {{ item.account.appleIdMasked }}
                <el-tag v-if="item.account.saleState === 'sold'" type="warning" effect="plain">
                  客户已购
                </el-tag>
              </dd>
            </div>
            <div v-if="item.account.soldByOrder">
              <dt>原销售归属</dt>
              <dd>
                {{ item.account.soldByOrder.orderNo }} ·
                {{ item.account.soldByOrder.customer.name }}
              </dd>
            </div>
            <div v-v2-column-visibility="[v2TableSchemas.renewals.main.id, 'currentBalance']">
              <dt>ID余额</dt>
              <dd>{{ page.formatDecimal(item.account.currentBalance) }}</dd>
            </div>
            <div v-v2-column-visibility="[v2TableSchemas.renewals.main.id, '客户网站账号']">
              <dt>网站账号</dt>
              <dd>{{ item.maskedWebsiteAccount || '—' }}</dd>
            </div>
            <div v-v2-column-visibility="[v2TableSchemas.renewals.main.id, 'dueAt']">
              <dt>到期时间</dt>
              <dd>{{ page.formatDate(item.dueAt) }}</dd>
            </div>
          </dl>
          <footer>
            <span>{{ item.orderNo }}</span>
            <AppButton
              v-if="page.canRenew"
              size="small"
              variant="primary"
              :disabled="!item.withinActionWindow"
              :title="page.renewalActionDisabledReason(item) || '录入续费订单'"
              @click="page.openRenewalDrawer(item)"
            >
              <el-icon><CirclePlus /></el-icon>
              续费
            </AppButton>
          </footer>
        </article>
        <div v-if="!page.items.length" class="v2-records-empty">
          <strong>暂无续费待办</strong>
          <span>当前筛选条件下没有数据</span>
        </div>
      </div>

      <footer class="v2-records-pagination">
        <span>
          共 {{ page.total }} 条
          <template v-if="page.evaluatedAt">
            · 状态计算于 {{ page.formatTime(page.evaluatedAt) }}
          </template>
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
import { CirclePlus } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import V2Table from '@/v2/components/V2Table.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import V2TableColumnSettings from '@/v2/components/V2TableColumnSettings.vue';
import { useV2StableListFrame } from '@/v2/composables/useV2StableListFrame';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import type { useRenewalsPage } from '../useRenewalsPage';

type RenewalsPage = UnwrapNestedRefs<ReturnType<typeof useRenewalsPage>>;

const props = defineProps<{
  page: RenewalsPage;
}>();

const { listRef, listFrameStyle } = useV2StableListFrame({
  items: () => props.page.items,
  pageSize: () => props.page.displayedPageSize
});
</script>
