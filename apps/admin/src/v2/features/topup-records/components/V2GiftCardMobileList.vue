<template>
  <article v-for="item in items" :key="item.id" class="v2-records-mobile-item">
    <header>
      <div>
        <strong v-v2-column-visibility="[v2TableSchemas.topupRecords.giftCards.id, '卡片名称']">
          {{ item.cardName.name }}
        </strong>
        <strong v-v2-column-visibility="[v2TableSchemas.topupRecords.giftCards.id, '礼品卡号']">
          {{ item.code }}
        </strong>
        <span v-v2-column-visibility="[v2TableSchemas.topupRecords.giftCards.id, '加入 ID']">
          {{ item.account.displayAppleId || '—' }}
        </span>
        <span v-v2-column-visibility="[v2TableSchemas.topupRecords.giftCards.id, '国家']">
          {{ item.country.name }}
        </span>
      </div>
      <el-tag
        v-v2-column-visibility="[v2TableSchemas.topupRecords.giftCards.id, 'status']"
        :type="giftCardStatusType(item.status)"
        effect="plain"
      >
        {{ giftCardStatusLabel(item.status) }}
      </el-tag>
    </header>
    <dl>
      <div v-v2-column-visibility="[v2TableSchemas.topupRecords.giftCards.id, 'faceValue']">
        <dt>面值</dt>
        <dd>{{ formatDecimal(item.faceValue) }} {{ item.country.currencyCode || '' }}</dd>
      </div>
      <div v-v2-column-visibility="[v2TableSchemas.topupRecords.giftCards.id, 'exchangeRate']">
        <dt>汇率</dt>
        <dd>¥{{ formatDecimal(item.exchangeRate) }}</dd>
      </div>
      <div v-v2-column-visibility="[v2TableSchemas.topupRecords.giftCards.id, 'costAmount']">
        <dt>卡值（RMB）</dt>
        <dd>¥{{ formatDecimal(item.costAmount) }}</dd>
      </div>
      <div v-v2-column-visibility="[v2TableSchemas.topupRecords.giftCards.id, 'remark']">
        <dt>备注</dt>
        <dd>{{ item.remark || '—' }}</dd>
      </div>
      <div v-v2-column-visibility="[v2TableSchemas.topupRecords.giftCards.id, '供应商']">
        <dt>供应商</dt>
        <dd>{{ item.supplier?.name || '—' }}</dd>
      </div>
      <div v-v2-column-visibility="[v2TableSchemas.topupRecords.giftCards.id, 'ID 加卡前余额']">
        <dt>ID 加卡前余额</dt>
        <dd>{{ formatOptionalDecimal(item.creditedLedger?.balanceBefore) }}</dd>
      </div>
      <div v-v2-column-visibility="[v2TableSchemas.topupRecords.giftCards.id, 'ID 加卡后余额']">
        <dt>ID 加卡后余额</dt>
        <dd>{{ formatOptionalDecimal(item.creditedLedger?.balanceAfter) }}</dd>
      </div>
      <div v-v2-column-visibility="[v2TableSchemas.topupRecords.giftCards.id, '操作人']">
        <dt>操作人</dt>
        <dd>{{ operatorUsername(item.createdBy, 'system') }}</dd>
      </div>
    </dl>
    <footer>
      <span v-v2-column-visibility="[v2TableSchemas.topupRecords.giftCards.id, 'creditedAt']">
        {{ formatDate(item.creditedAt) }}
      </span>
      <div
        v-if="item.account.lossStatus === 'active' && (canAdjustBalance || canReassignSupplier)"
        class="v2-record-actions"
      >
        <AppButton
          v-if="canReassignSupplier"
          size="small"
          variant="soft"
          @click="emit('reassignSupplier', item)"
        >
          更正供应商
        </AppButton>
        <el-dropdown
          v-if="canAdjustBalance"
          trigger="click"
          @command="emit('financialCommand', item, $event)"
        >
          <AppButton size="small" variant="soft">更多操作</AppButton>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="metadata">备注</el-dropdown-item>
              <el-dropdown-item v-if="item.status === 'credited'" command="redeemed" divided>
                被赎回
              </el-dropdown-item>
              <el-dropdown-item v-if="item.status === 'credited'" command="withdrawn">
                撤回
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </footer>
  </article>
  <div v-if="!items.length" class="v2-records-empty">
    <strong>暂无加卡记录</strong>
    <span>当前筛选条件下没有入账记录</span>
  </div>
</template>

<script setup lang="ts">
import AppButton from '@/components/ui/AppButton.vue';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import { operatorUsername } from '@/v2/utils/operator';
import type { V2GiftCardRecord } from '../contracts';
import {
  formatDate,
  formatDecimal,
  formatOptionalDecimal,
  giftCardStatusLabel,
  giftCardStatusType
} from '../topup-records-format';

defineProps<{
  items: V2GiftCardRecord[];
  canAdjustBalance: boolean;
  canReassignSupplier: boolean;
}>();
const emit = defineEmits<{
  reassignSupplier: [item: V2GiftCardRecord];
  financialCommand: [item: V2GiftCardRecord, command: unknown];
}>();
</script>
