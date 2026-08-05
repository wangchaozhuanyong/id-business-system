<template>
  <section class="v2-finance-profit-overview" aria-label="经营利润结论">
    <article class="v2-finance-profit-lead">
      <header>
        <div>
          <span class="v2-finance-eyebrow">已实现经营结果</span>
          <strong>人民币净利润</strong>
        </div>
        <el-tag
          :type="overview.settings.historyStatus === 'completed' ? 'success' : 'warning'"
          effect="plain"
        >
          {{ overview.settings.historyStatus === 'completed' ? '口径已确认' : '历史待完善' }}
        </el-tag>
      </header>
      <strong
        class="v2-finance-profit-lead__value"
        :class="amountTone(overview.profitLoss.netProfitCny)"
      >
        {{ formatCny(overview.profitLoss.netProfitCny) }}
      </strong>
      <p>只包含已完成订单和已确认成本、损失与开支，不把处理中订单并入当期利润。</p>
      <footer>
        <div>
          <span>待确认利润</span>
          <strong>{{ formatCny(overview.profitLoss.estimatedProfitCny) }}</strong>
        </div>
        <small>{{ analysisRangeLabel }}</small>
      </footer>
    </article>

    <article class="v2-finance-profit-bridge">
      <header>
        <div>
          <span class="v2-finance-eyebrow">利润拆解</span>
          <strong>从收入到净利润</strong>
        </div>
        <small>以 CNY 已确认金额展示</small>
      </header>
      <dl>
        <div>
          <dt>销售收入</dt>
          <dd class="is-positive">{{ formatCny(overview.profitLoss.salesRevenueCny) }}</dd>
        </div>
        <div>
          <dt>余额与 ID 销售成本</dt>
          <dd>
            {{
              formatCny(
                addAmounts(overview.profitLoss.giftCardCostCny, overview.profitLoss.idCostCny)
              )
            }}
          </dd>
        </div>
        <div>
          <dt>平台费与经营开支</dt>
          <dd>
            {{
              formatCny(
                addAmounts(
                  overview.profitLoss.platformFeeCny,
                  overview.profitLoss.operatingExpenseCny
                )
              )
            }}
          </dd>
        </div>
        <div>
          <dt>退款、赎回与报损</dt>
          <dd>
            {{
              formatCny(
                addAmounts(
                  overview.profitLoss.refundLossCny,
                  overview.profitLoss.redemptionLossCny,
                  overview.profitLoss.balanceLossCny,
                  overview.profitLoss.idPurchaseLossCny
                )
              )
            }}
          </dd>
        </div>
        <div>
          <dt>已实现汇兑损益</dt>
          <dd :class="amountTone(overview.profitLoss.realizedFxGainLossCny)">
            {{ formatCny(overview.profitLoss.realizedFxGainLossCny) }}
          </dd>
        </div>
      </dl>
    </article>
  </section>
</template>

<script setup lang="ts">
import type { V2FinanceOverview } from '@apple-business/shared';

defineProps<{
  overview: V2FinanceOverview;
  analysisRangeLabel: string;
  formatCny: (value: string | null | undefined) => string;
  addAmounts: (...values: string[]) => string;
  amountTone: (value: string | null | undefined) => string;
}>();
</script>
