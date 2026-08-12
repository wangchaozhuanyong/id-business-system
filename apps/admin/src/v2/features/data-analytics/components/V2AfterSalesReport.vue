<template>
  <section class="v2-after-sales-report" aria-label="已售 ID 售后业务分析">
    <header>
      <V2SectionHeading
        title="售后业务"
        help="只汇总客户已购 ID 订单，已实现数据以总账凭证为准，处理中订单仅用于预估。"
      >
        <template #actions>
          <el-tag :type="hasUnexpectedIdCost ? 'danger' : 'success'" effect="plain">
            {{ hasUnexpectedIdCost ? 'ID 成本异常' : 'ID 成本正常' }}
          </el-tag>
        </template>
      </V2SectionHeading>
    </header>

    <el-alert
      v-if="hasUnexpectedIdCost"
      type="error"
      title="售后订单出现非零 ID 成本"
      :description="`当前范围售后 ID 成本为 ${formatCny(
        report.idCostCny
      )}，请立即到账务对账核查重复成本分录。`"
      show-icon
      :closable="false"
    />

    <div class="v2-after-sales-report__metrics" aria-label="售后业务核心指标">
      <article>
        <span>已完成订单</span>
        <strong>{{ report.completedOrderCount }}</strong>
        <small>已记账售后业务</small>
      </article>
      <article>
        <span>毛收入</span>
        <strong>{{ formatCny(report.grossRevenueCny) }}</strong>
        <small>已完成订单实收</small>
      </article>
      <article>
        <span>售后净利润</span>
        <strong :class="amountTone(report.netProfitCny)">
          {{ formatCny(report.netProfitCny) }}
        </strong>
        <small>已实现经营结果</small>
      </article>
      <article>
        <span>待处理订单</span>
        <strong>{{ report.pendingOrderCount }}</strong>
        <small>预计收入 {{ formatCny(report.pendingRevenueCny) }}</small>
      </article>
    </div>

    <div class="v2-after-sales-report__details">
      <section>
        <header>
          <strong>已实现利润拆解</strong>
          <small>订单完成及退款凭证</small>
        </header>
        <dl>
          <div>
            <dt>毛收入</dt>
            <dd class="is-positive">{{ formatCny(report.grossRevenueCny) }}</dd>
          </div>
          <div>
            <dt>退款收入冲减</dt>
            <dd>{{ formatCny(report.refundedRevenueCny) }}</dd>
          </div>
          <div>
            <dt>平台手续费</dt>
            <dd>{{ formatCny(report.platformFeeCny) }}</dd>
          </div>
          <div>
            <dt>本次消耗余额成本</dt>
            <dd>{{ formatCny(report.balanceCostCny) }}</dd>
          </div>
          <div>
            <dt>ID 成本</dt>
            <dd :class="{ 'is-negative': hasUnexpectedIdCost }">
              {{ formatCny(report.idCostCny) }}
            </dd>
          </div>
          <div>
            <dt>退款损失</dt>
            <dd>{{ formatCny(report.refundLossCny) }}</dd>
          </div>
        </dl>
      </section>

      <aside>
        <span>处理中预估</span>
        <strong :class="amountTone(report.pendingProfitCny)">
          {{ formatCny(report.pendingProfitCny) }}
        </strong>
        <small>
          {{ report.pendingOrderCount }} 笔订单，预计收入
          {{ formatCny(report.pendingRevenueCny) }}
        </small>
        <p>预估值不进入当期总账利润，订单完成后才转为已实现金额。</p>
      </aside>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { V2FinanceAfterSales } from '@apple-business/shared';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';

const props = defineProps<{
  report: V2FinanceAfterSales;
  formatCny: (value: string | null | undefined) => string;
  amountTone: (value: string | null | undefined) => string;
}>();

const hasUnexpectedIdCost = computed(() => !/^(?:0|0\.0+)$/.test(props.report.idCostCny));
</script>
