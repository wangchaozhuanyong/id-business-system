<template>
  <dl>
    <div v-v2-column-visibility="[schemaId, 'currentBalance']">
      <dt>ID 余额</dt>
      <dd>{{ page.formatDecimal(item.currentBalance) }}</dd>
    </div>
    <div>
      <dt>人民币成本</dt>
      <dd>¥{{ page.formatDecimal(item.balanceCostAmount) }}</dd>
    </div>
    <div v-v2-column-visibility="[schemaId, '平均成本']">
      <dt>平均成本</dt>
      <dd>¥{{ page.formatDecimal(item.averageCost) }}</dd>
    </div>
    <div v-v2-column-visibility="[schemaId, '最近加卡']">
      <dt>最近加卡</dt>
      <dd>{{ page.formatElapsed(item.lastTopupAt) }}</dd>
    </div>
    <div v-v2-column-visibility="[schemaId, '加卡记录']">
      <dt>加卡记录</dt>
      <dd><V2TopupRecordActions :page="page" :item="item" /></dd>
    </div>
    <div v-v2-column-visibility="[schemaId, '余额流水']">
      <dt>余额变动</dt>
      <dd><V2TopupLedgerAction :page="page" :item="item" /></dd>
    </div>
    <div class="v2-topup-mobile-service">
      <dt>历史开通业务</dt>
      <dd>
        <div v-if="item.historicalServices.length" class="v2-topup-service-tags">
          <el-tag
            v-for="service in item.historicalServices"
            :key="service.id"
            type="info"
            effect="plain"
            :title="page.servicePath(service)"
          >
            {{ service.name }}
          </el-tag>
        </div>
        <span v-else>—</span>
      </dd>
    </div>
    <div v-v2-column-visibility="[schemaId, '当前业务']" class="v2-topup-mobile-service">
      <dt>当前开通业务</dt>
      <dd><V2TopupCurrentServices :page="page" :item="item" /></dd>
    </div>
  </dl>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import V2TopupCurrentServices from './V2TopupCurrentServices.vue';
import V2TopupLedgerAction from './V2TopupLedgerAction.vue';
import V2TopupRecordActions from './V2TopupRecordActions.vue';
import type { V2TopupWorkbenchItem } from '../contracts';
import type { useTopupWorkbenchPage } from '../useTopupWorkbenchPage';

type TopupWorkbenchPage = UnwrapNestedRefs<ReturnType<typeof useTopupWorkbenchPage>>;

defineProps<{
  page: TopupWorkbenchPage;
  item: V2TopupWorkbenchItem;
  schemaId: string;
}>();
</script>
