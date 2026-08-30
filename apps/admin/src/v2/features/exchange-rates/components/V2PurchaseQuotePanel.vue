<template>
  <section class="v2-purchase-quotes" aria-label="人民币收购报价">
    <el-alert
      v-if="purchaseAttention"
      :type="purchaseAttention.type"
      :title="purchaseAttention.title"
      :description="page.purchaseQuoteMeta?.marketRateNotice"
      show-icon
      :closable="false"
    />

    <section
      ref="purchaseListRef"
      class="v2-records-list v2-exchange-list v2-purchase-workspace"
      :style="purchaseListFrameStyle"
    >
      <header class="v2-exchange-list__header">
        <V2SectionHeading
          title="人民币收购报价"
          :help="
            page.purchaseQuoteMeta?.calculationRule || '每个币种按自身市场汇率和收购比例独立计算。'
          "
        >
          <template #actions>
            <AppButton variant="primary" @click="page.purchaseAutomation.openText">
              生成报价
            </AppButton>
            <AppButton
              v-if="page.canCollect"
              variant="ghost"
              :loading="page.purchaseAutomation.refreshing"
              @click="page.purchaseAutomation.refreshNow"
            >
              更新汇率
            </AppButton>
            <el-dropdown trigger="click" @command="handleMoreCommand">
              <AppButton variant="ghost">
                更多操作
                <el-icon><ArrowDown /></el-icon>
              </AppButton>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="history">查看历史</el-dropdown-item>
                  <el-dropdown-item v-if="page.canManage" command="bulk">
                    批量设置比例
                  </el-dropdown-item>
                  <el-dropdown-item v-if="page.canManage" command="settings">
                    自动采集设置
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </template>
        </V2SectionHeading>
      </header>

      <dl class="v2-purchase-summary" aria-label="收购报价运行摘要">
        <div>
          <dt>最新数据</dt>
          <dd>
            {{
              page.purchaseAutomation.automationQuery.isInitialLoading
                ? '读取中'
                : page.formatDate(page.purchaseAutomation.latestRun?.providerUpdatedAt)
            }}
          </dd>
          <small>
            {{
              page.purchaseAutomation.automationQuery.isInitialLoading
                ? '正在读取采集状态'
                : page.purchaseAutomation.runtime?.provider.configured
                  ? 'ExchangeRate-API'
                  : '供应商待配置'
            }}
          </small>
        </div>
        <div>
          <dt>启用币种</dt>
          <dd>{{ enabledQuoteCount }} / {{ page.purchaseQuotes.length }}</dd>
          <small>启用 / 已配置</small>
        </div>
        <div :class="{ 'is-warning': quoteIssueCount > 0 || !page.purchaseQuotes.length }">
          <dt>报价状态</dt>
          <dd>{{ quoteStatusLabel }}</dd>
          <small>{{ quoteStatusDetail }}</small>
        </div>
      </dl>

      <div class="v2-exchange-filterbar v2-exchange-filterbar--purchase">
        <el-input
          v-model="keyword"
          clearable
          placeholder="搜索币种名称或代码"
          aria-label="搜索收购报价币种"
        >
          <template #prefix>
            <el-icon><Search /></el-icon>
          </template>
        </el-input>
        <div class="v2-purchase-toolbar-meta">
          <span>本页 {{ displayedQuotes.length }} 个</span>
          <V2TableColumnSettings inline :schema="v2TableSchemas.exchangeRates.purchaseQuotes" />
        </div>
      </div>

      <V2AsyncRegion
        skeleton="table"
        :phase="page.queryPhase"
        :previous-data="page.isParameterTransition"
        :error="page.purchaseError"
        loading-title="正在加载收购报价"
        refreshing-title="正在更新收购报价"
        error-title="收购报价加载失败"
        @retry="page.loadPurchaseQuotes"
      >
        <V2Table
          :schema="v2TableSchemas.exchangeRates.purchaseQuotes"
          :show-column-settings="false"
          :aria-busy="page.purchaseLoading"
          scrollbar-always-on
          show-overflow-tooltip
          class="v2-exchange-table"
          :data="displayedQuotes"
        >
          <template #empty>
            <div class="v2-records-empty">
              <strong>{{ keyword.trim() ? '没有匹配的收购报价' : '暂无收购报价' }}</strong>
              <span>{{ keyword.trim() ? '请调整搜索条件后重试' : '请先配置收购币种' }}</span>
            </div>
          </template>
          <V2TableColumn :definition="v2TableSchemas.exchangeRates.purchaseQuotes.columns[0]">
            <template #default="{ row }">
              <div class="v2-purchase-currency">
                <strong>{{ row.displayName || row.nameCn }}</strong>
                <span>{{ row.code }}</span>
              </div>
            </template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.exchangeRates.purchaseQuotes.columns[1]">
            <template #default="{ row }">
              <span v-if="row.latestSnapshot">
                1 {{ row.code }} = ¥{{ page.formatRate(row.latestSnapshot.marketRateCnyPerUnit) }}
              </span>
              <span v-else class="v2-purchase-muted">待录入</span>
            </template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.exchangeRates.purchaseQuotes.columns[2]">
            <template #default="{ row }">{{ page.formatRate(row.purchaseRatioPercent) }}%</template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.exchangeRates.purchaseQuotes.columns[3]">
            <template #default="{ row }">
              <strong v-if="row.latestSnapshot" class="v2-exchange-table-rate">
                {{ page.formatRate(row.quoteUnit) }} {{ row.code }} = ¥{{
                  row.latestSnapshot.purchaseRateFormatted
                }}
              </strong>
              <span v-else class="v2-purchase-muted">尚未计算</span>
            </template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.exchangeRates.purchaseQuotes.columns[4]">
            <template #default="{ row }">
              <el-tag
                :type="
                  !row.enabled
                    ? 'info'
                    : !row.latestSnapshot || row.latestSnapshot.stale
                      ? 'warning'
                      : 'success'
                "
                size="small"
                effect="plain"
              >
                {{
                  !row.enabled
                    ? '已停用'
                    : !row.latestSnapshot
                      ? '待获取汇率'
                      : row.latestSnapshot.stale
                        ? '报价已过期'
                        : '报价有效'
                }}
              </el-tag>
            </template>
          </V2TableColumn>
          <V2TableActionColumn :definition="v2TableSchemas.exchangeRates.purchaseQuotes.columns[5]">
            <template #default="{ row }">
              <AppButton
                v-if="page.canManage"
                size="small"
                variant="ghost"
                @click="page.openPurchaseQuote(row)"
              >
                {{ row.latestSnapshot ? '编辑' : '设置' }}
              </AppButton>
              <span v-else class="v2-purchase-muted">只读</span>
            </template>
          </V2TableActionColumn>
        </V2Table>

        <footer class="v2-records-pagination">
          <span>共 {{ filteredQuotes.length }} 个币种</span>
          <el-pagination
            v-if="filteredQuotes.length > pageSize"
            v-pagination-label
            :current-page="currentPage"
            :page-size="pageSize"
            background
            :page-sizes="[10, 20, 50]"
            layout="sizes, prev, pager, next"
            :total="filteredQuotes.length"
            @current-change="currentPage = $event"
            @size-change="pageSize = $event"
          />
        </footer>
      </V2AsyncRegion>

      <footer class="v2-purchase-workspace__footer">
        <p>各币种独立计算，不使用美元中转。</p>
        <span>
          {{
            page.purchaseAutomation.automationQuery.isInitialLoading
              ? '正在读取自动更新计划'
              : page.purchaseAutomation.runtime?.settings.autoEnabled
                ? `下次自动更新：${page.formatDate(page.purchaseAutomation.runtime?.settings.nextRunAt)}`
                : '自动更新已关闭'
          }}
          ·
          <a href="https://www.exchangerate-api.com" target="_blank" rel="noreferrer">
            {{ exchangeRateAttribution }}
          </a>
        </span>
      </footer>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch, type UnwrapNestedRefs } from 'vue';
import { ArrowDown, Search } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import V2Table from '@/v2/components/V2Table.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import V2TableColumnSettings from '@/v2/components/V2TableColumnSettings.vue';
import { useV2StableListFrame } from '@/v2/composables/useV2StableListFrame';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import type { useExchangeRatesPage } from '../useExchangeRatesPage';

type ExchangeRatesPage = UnwrapNestedRefs<ReturnType<typeof useExchangeRatesPage>>;

const props = defineProps<{
  page: ExchangeRatesPage;
}>();

const keyword = ref('');
const exchangeRateAttribution = 'Rates By Exchange Rate API';
const currentPage = ref(1);
const pageSize = ref(10);
const enabledQuoteCount = computed(
  () => props.page.purchaseQuotes.filter((quote) => quote.enabled).length
);
const quoteIssueCount = computed(
  () =>
    props.page.purchaseAutomation.staleQuoteCount + props.page.purchaseAutomation.missingQuoteCount
);
const quoteStatusLabel = computed(() => {
  if (!props.page.purchaseQuotes.length) return '尚未配置';
  return quoteIssueCount.value ? `${quoteIssueCount.value} 项需处理` : '全部有效';
});
const quoteStatusDetail = computed(() =>
  props.page.purchaseQuotes.length
    ? `${props.page.purchaseAutomation.staleQuoteCount} 个过期 · ${props.page.purchaseAutomation.missingQuoteCount} 个缺失`
    : '请先配置收购币种'
);
const purchaseAttention = computed(() => {
  const automation = props.page.purchaseAutomation;
  if (automation.runtime && !automation.runtime.provider.configured) {
    return { type: 'error' as const, title: '自动采集供应商尚未配置' };
  }
  if (automation.missingQuoteCount) {
    return { type: 'error' as const, title: '部分币种尚无有效收购报价' };
  }
  if (automation.staleQuoteCount) {
    return { type: 'error' as const, title: '部分收购报价已超过有效时限' };
  }
  if (automation.pendingReviewRun) {
    return { type: 'warning' as const, title: '检测到异常波动，候选报价尚未发布' };
  }
  if (automation.latestRun?.status === 'failed') {
    return { type: 'warning' as const, title: '最近一次更新失败，当前继续使用最后有效报价' };
  }
  return null;
});
const filteredQuotes = computed(() => {
  const normalized = keyword.value.trim().toLocaleLowerCase('zh-CN');
  if (!normalized) return props.page.purchaseQuotes;
  return props.page.purchaseQuotes.filter((quote) =>
    [quote.code, quote.nameCn, quote.displayName]
      .filter(Boolean)
      .some((value) => String(value).toLocaleLowerCase('zh-CN').includes(normalized))
  );
});
const displayedQuotes = computed(() => {
  const start = (currentPage.value - 1) * pageSize.value;
  return filteredQuotes.value.slice(start, start + pageSize.value);
});
const { listRef: purchaseListRef, listFrameStyle: purchaseListFrameStyle } = useV2StableListFrame({
  items: () => displayedQuotes.value,
  pageSize: () => pageSize.value
});

watch([keyword, pageSize, () => props.page.purchaseQuotes.length], () => {
  currentPage.value = 1;
});

function handleMoreCommand(command: string | number | object) {
  if (command === 'history') props.page.purchaseAutomation.openHistory();
  if (command === 'bulk') props.page.purchaseAutomation.openBulk();
  if (command === 'settings') props.page.purchaseAutomation.openSettings();
}
</script>
