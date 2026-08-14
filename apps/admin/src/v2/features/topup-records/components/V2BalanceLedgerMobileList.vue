<template>
  <article v-for="item in items" :key="item.id" class="v2-records-mobile-item">
    <header>
      <div>
        <strong v-v2-column-visibility="[v2TableSchemas.topupRecords.balanceLedger.id, '变动类型']">
          {{ ledgerTypeLabel(item.entryType) }}
        </strong>
        <span v-v2-column-visibility="[v2TableSchemas.topupRecords.balanceLedger.id, 'ID 账号']">
          {{ item.account.displayAppleId || '—' }}
        </span>
        <span v-v2-column-visibility="[v2TableSchemas.topupRecords.balanceLedger.id, '国家']">
          {{ item.account.country.name }}
        </span>
      </div>
      <strong
        v-v2-column-visibility="[v2TableSchemas.topupRecords.balanceLedger.id, 'balanceAmount']"
        :class="`v2-ledger-amount--${deltaType(item.balanceDelta)}`"
      >
        {{ formatSignedDecimal(item.balanceDelta) }}
      </strong>
    </header>
    <dl>
      <div v-v2-column-visibility="[v2TableSchemas.topupRecords.balanceLedger.id, '礼品卡']">
        <dt>礼品卡</dt>
        <dd>{{ item.giftCard?.code || '—' }}</dd>
      </div>
      <div v-v2-column-visibility="[v2TableSchemas.topupRecords.balanceLedger.id, '变动前余额']">
        <dt>变动前余额</dt>
        <dd>{{ formatDecimal(item.balanceBefore) }}</dd>
      </div>
      <div v-v2-column-visibility="[v2TableSchemas.topupRecords.balanceLedger.id, '变动后余额']">
        <dt>变动后余额</dt>
        <dd>{{ formatDecimal(item.balanceAfter) }}</dd>
      </div>
      <div v-v2-column-visibility="[v2TableSchemas.topupRecords.balanceLedger.id, 'costAmount']">
        <dt>成本变动</dt>
        <dd>{{ formatSignedCurrency(item.costDelta) }}</dd>
      </div>
      <div v-v2-column-visibility="[v2TableSchemas.topupRecords.balanceLedger.id, '平均成本']">
        <dt>平均成本</dt>
        <dd>¥{{ formatDecimal(item.averageCostAfter) }}</dd>
      </div>
      <div v-v2-column-visibility="[v2TableSchemas.topupRecords.balanceLedger.id, '关联']">
        <dt>冲正状态</dt>
        <dd>
          <el-tag v-if="item.reversalOf" type="warning" effect="plain">反向流水</el-tag>
          <el-tag v-else-if="item.reversedBy" type="info" effect="plain">已反冲</el-tag>
          <span v-else>正常</span>
        </dd>
      </div>
    </dl>
    <footer>
      <span v-v2-column-visibility="[v2TableSchemas.topupRecords.balanceLedger.id, 'createdAt']">
        {{ formatDate(item.createdAt) }}
      </span>
    </footer>
  </article>
  <div v-if="!items.length" class="v2-records-empty">
    <strong>暂无余额变动</strong>
    <span>当前筛选条件下没有账务流水</span>
  </div>
</template>

<script setup lang="ts">
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import type { V2BalanceLedgerRecord } from '../contracts';
import {
  deltaType,
  formatDate,
  formatDecimal,
  formatSignedCurrency,
  formatSignedDecimal,
  ledgerTypeLabel
} from '../topup-records-format';

defineProps<{ items: V2BalanceLedgerRecord[] }>();
</script>
