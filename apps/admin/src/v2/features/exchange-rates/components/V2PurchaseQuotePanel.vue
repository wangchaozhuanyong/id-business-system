<template>
  <section class="v2-purchase-quotes" aria-label="收购报价计算">
    <el-alert
      :type="
        (page.purchaseAutomation.runtime && !page.purchaseAutomation.runtime.provider.configured) ||
        page.purchaseAutomation.staleQuoteCount ||
        page.purchaseAutomation.missingQuoteCount
          ? 'error'
          : page.purchaseAutomation.pendingReviewRun
            ? 'warning'
            : 'info'
      "
      :title="
        page.purchaseAutomation.runtime && !page.purchaseAutomation.runtime.provider.configured
          ? '自动采集供应商尚未配置'
          : page.purchaseAutomation.missingQuoteCount
            ? '部分币种尚无有效收购报价'
            : page.purchaseAutomation.staleQuoteCount
              ? '部分收购报价已超过有效时限'
              : page.purchaseAutomation.pendingReviewRun
                ? '检测到异常波动，候选报价尚未发布'
                : '多币种市场汇率每日免费自动采集已接入'
      "
      :description="page.purchaseQuoteMeta?.marketRateNotice"
      show-icon
      :closable="false"
    />

    <section class="v2-purchase-status-grid" aria-label="收购汇率运行状态">
      <article>
        <span>最新汇率更新时间</span>
        <strong>{{ page.formatDate(page.purchaseAutomation.latestRun?.providerUpdatedAt) }}</strong>
        <small>供应商数据时间</small>
      </article>
      <article>
        <span>数据供应商</span>
        <strong>{{
          page.purchaseAutomation.runtime?.provider.configured ? 'ExchangeRate-API' : '待配置'
        }}</strong>
        <small>
          <a href="https://www.exchangerate-api.com" target="_blank" rel="noreferrer">
            {{ exchangeRateAttribution }}
          </a>
        </small>
      </article>
      <article>
        <span>已启用币种</span>
        <strong>{{ enabledQuoteCount }} 个</strong>
        <small>共配置 {{ page.purchaseQuotes.length }} 个币种</small>
      </article>
      <article>
        <span>下一次更新时间</span>
        <strong>{{ page.formatDate(page.purchaseAutomation.runtime?.settings.nextRunAt) }}</strong>
        <small>
          {{
            page.purchaseAutomation.runtime?.settings.autoEnabled
              ? '每天北京时间 09:05 执行'
              : '自动采集已停用'
          }}
        </small>
      </article>
      <article>
        <span>汇率接口状态</span>
        <strong>{{
          !page.purchaseAutomation.runtime?.provider.configured
            ? '待配置'
            : page.purchaseAutomation.latestRun?.status === 'failed'
              ? '最近采集失败'
              : '已就绪'
        }}</strong>
        <small>失败时保留最后有效报价</small>
      </article>
      <article>
        <span>过期或缺失</span>
        <strong
          >{{ page.purchaseAutomation.staleQuoteCount }} /
          {{ page.purchaseAutomation.missingQuoteCount }}</strong
        >
        <small>超过有效时限 / 尚无报价</small>
      </article>
      <article>
        <span>最近批次</span>
        <strong>{{ runStatusLabel(page.purchaseAutomation.latestRun?.status) }}</strong>
        <small>{{ page.formatDate(page.purchaseAutomation.latestRun?.startedAt) }}</small>
      </article>
    </section>

    <section class="v2-exchange-command-panel" aria-label="收购报价筛选工具">
      <V2SectionHeading
        class="v2-exchange-command-panel__heading"
        title="人民币收购报价"
        :help="
          page.purchaseQuoteMeta?.calculationRule ||
          '每个币种使用自己的市场汇率和收购比例独立计算。'
        "
      >
        <template #actions>
          <AppButton variant="ghost" @click="page.purchaseAutomation.openText"
            >生成报价文本</AppButton
          >
          <AppButton variant="ghost" @click="page.purchaseAutomation.openHistory"
            >查看历史</AppButton
          >
          <AppButton
            v-if="page.canManage"
            variant="ghost"
            @click="page.purchaseAutomation.openBulk"
          >
            批量设置比例
          </AppButton>
          <AppButton
            v-if="page.canManage"
            variant="ghost"
            @click="page.purchaseAutomation.openSettings"
          >
            自动采集设置
          </AppButton>
          <AppButton
            v-if="page.canCollect"
            variant="primary"
            :loading="page.purchaseAutomation.refreshing"
            @click="page.purchaseAutomation.refreshNow"
          >
            立即刷新
          </AppButton>
        </template>
      </V2SectionHeading>

      <div class="v2-exchange-toolbar v2-exchange-toolbar--purchase">
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
      </div>

      <footer class="v2-exchange-command-panel__footer">
        <p>美元与其他币种完全独立，不作为欧元、英镑、马币等币种的计算基准。</p>
        <span>默认按排序数字升序</span>
      </footer>
    </section>

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
      <section class="v2-records-list v2-exchange-list">
        <header class="v2-exchange-list__header">
          <V2SectionHeading
            title="币种报价"
            help="国际人民币汇率和今日收购价分列展示，避免口径混淆。"
          >
            <template #actions>
              <V2TableColumnSettings inline :schema="v2TableSchemas.exchangeRates.purchaseQuotes" />
              <span>本页 {{ displayedQuotes.length }} 个</span>
            </template>
          </V2SectionHeading>
        </header>

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
              <strong>没有匹配的收购报价</strong>
              <span>请调整搜索条件后重试</span>
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
            <template #default="{ row }"
              >{{ page.formatRate(row.quoteUnit) }} {{ row.code }}</template
            >
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.exchangeRates.purchaseQuotes.columns[4]">
            <template #default="{ row }">
              <strong v-if="row.latestSnapshot" class="v2-exchange-table-rate">
                ¥{{ row.latestSnapshot.purchaseRateFormatted }}
              </strong>
              <span v-else class="v2-purchase-muted">尚未计算</span>
            </template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.exchangeRates.purchaseQuotes.columns[5]">
            <template #default="{ row }">
              {{ row.decimalPlaces }} 位 · {{ page.purchaseRoundingLabel(row.roundingMode) }}
            </template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.exchangeRates.purchaseQuotes.columns[6]">
            <template #default="{ row }">
              {{ page.formatDate(row.latestSnapshot?.marketRateCapturedAt) }}
            </template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.exchangeRates.purchaseQuotes.columns[7]">
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
          <V2TableActionColumn :definition="v2TableSchemas.exchangeRates.purchaseQuotes.columns[8]">
            <template #default="{ row }">
              <AppButton
                v-if="page.canManage"
                size="small"
                variant="ghost"
                @click="page.openPurchaseQuote(row)"
              >
                {{ row.latestSnapshot ? '编辑并重算' : '设置并计算' }}
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
      </section>
    </V2AsyncRegion>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch, type UnwrapNestedRefs } from 'vue';
import { Search } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import V2Table from '@/v2/components/V2Table.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import V2TableColumnSettings from '@/v2/components/V2TableColumnSettings.vue';
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

watch([keyword, pageSize], () => {
  currentPage.value = 1;
});

function runStatusLabel(status?: string) {
  if (status === 'running') return '运行中';
  if (status === 'success') return '已发布';
  if (status === 'failed') return '失败保留旧值';
  if (status === 'pending_review') return '等待异常审核';
  if (status === 'rejected') return '已驳回';
  return '暂无记录';
}
</script>
