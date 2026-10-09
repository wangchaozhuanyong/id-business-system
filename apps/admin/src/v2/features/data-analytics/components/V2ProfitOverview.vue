<template>
  <section class="v2-finance-profit-overview" aria-label="经营利润结论">
    <article class="v2-finance-profit-lead">
      <header>
        <div>
          <span class="v2-finance-eyebrow">已实现经营结果</span>
          <strong>{{ accountRelated ? '账户关联业务损益' : '人民币净利润' }}</strong>
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
      <p>只包含已记账收入与已确认成本、退款、损失和开支，不把处理中订单并入当期利润。</p>
      <p v-if="accountRelated">
        按参与现金收支的凭证汇总完整损益；多账户凭证可能同时归属多个账户，此视图不可按账户相加。无现金的库存损耗仍计入全局损益。
      </p>
      <footer>
        <div>
          <span>{{ accountRelated ? '全局待确认利润' : '待确认利润' }}</span>
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
          <dt>其他经营收入</dt>
          <dd class="is-positive">
            {{ formatCny(overview.profitLoss.otherOperatingRevenueCny) }}
          </dd>
        </div>
        <div>
          <dt>比特充值代充收入</dt>
          <dd class="is-positive">
            {{ formatCny(overview.profitLoss.bankRechargeRevenueCny ?? '0') }}
          </dd>
        </div>
        <div>
          <dt>旧口径客户手续费收入</dt>
          <dd class="is-positive">
            {{ formatCny(overview.profitLoss.bankRechargeServiceFeeCny ?? '0') }}
          </dd>
        </div>
        <div>
          <dt>经营收入合计</dt>
          <dd class="is-positive">
            {{ formatCny(overview.profitLoss.totalOperatingRevenueCny) }}
          </dd>
        </div>
        <div>
          <dt>余额、ID 与客户资产转移成本</dt>
          <dd>
            {{
              formatCny(
                addAmounts(
                  overview.profitLoss.giftCardCostCny,
                  overview.profitLoss.idCostCny,
                  overview.profitLoss.customerOwnedBalanceCostCny
                )
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
          <dt>比特充值官网代付成本</dt>
          <dd>{{ formatCny(overview.profitLoss.bankRechargeCostCny ?? '0') }}</dd>
        </div>
        <div>
          <dt>旧口径银行手续费</dt>
          <dd>{{ formatCny(overview.profitLoss.bankRechargeBankFeeCny ?? '0') }}</dd>
        </div>
        <div>
          <dt>订阅 USDT 手续费</dt>
          <dd>{{ formatCny(overview.profitLoss.bankRechargeUsdtFeeCny ?? '0') }}</dd>
        </div>
        <div>
          <dt>订阅购物网手续费</dt>
          <dd>{{ formatCny(overview.profitLoss.bankRechargeShoppingFeeCny ?? '0') }}</dd>
        </div>
        <div>
          <dt>换汇费用</dt>
          <dd>{{ formatCny(overview.profitLoss.exchangeFeeCny ?? '0') }}</dd>
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
  accountRelated?: boolean;
  analysisRangeLabel: string;
  formatCny: (value: string | null | undefined) => string;
  addAmounts: (...values: string[]) => string;
  amountTone: (value: string | null | undefined) => string;
}>();
</script>
