<template>
  <footer class="v2-order-entry-actions">
    <dl class="v2-order-entry-action-status">
      <div>
        <dt>订单状态</dt>
        <dd>待处理</dd>
      </div>
    </dl>
    <dl class="v2-order-entry-action-metrics" aria-live="polite">
      <div>
        <dt>当前选中 ID</dt>
        <dd>{{ selectedId || '等待匹配' }}</dd>
      </div>
      <div>
        <dt>匹配余额</dt>
        <dd>
          {{ formatDecimal(selectedBalance) }}
          <small v-if="selectedCurrency">{{ selectedCurrency }}</small>
        </dd>
      </div>
      <div class="is-profit">
        <dt>预计利润</dt>
        <dd>
          ¥{{ formatDecimal(estimatedProfit) }}
          <small v-if="estimatedProfitRate">({{ formatDecimal(estimatedProfitRate) }}%)</small>
        </dd>
      </div>
    </dl>
    <div class="v2-order-entry-action-buttons">
      <span v-if="disabledReason" class="v2-submit-disabled-reason" role="status">
        {{ disabledReason }}
      </span>
      <span v-else class="v2-order-entry-draft-state">当前页面自动保留草稿</span>
      <AppButton
        variant="primary"
        :loading="submitting"
        :disabled="Boolean(disabledReason)"
        :aria-label="disabledReason ? `创建并扣减余额：${disabledReason}` : '创建并扣减余额'"
        @click="$emit('submit')"
      >
        <el-icon><CircleCheck /></el-icon>
        创建并扣减余额
      </AppButton>
    </div>
  </footer>
</template>

<script setup lang="ts">
import { CircleCheck } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';

defineProps<{
  submitting: boolean;
  disabledReason: string;
  selectedId: string;
  selectedBalance: string;
  selectedCurrency: string;
  estimatedProfit: string;
  estimatedProfitRate: string | null;
  formatDecimal: (value: string) => string;
}>();

defineEmits<{
  submit: [];
}>();
</script>
