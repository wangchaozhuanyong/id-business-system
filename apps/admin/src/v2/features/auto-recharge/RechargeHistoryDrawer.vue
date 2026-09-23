<template>
  <el-drawer
    v-model="model"
    title="最近执行记录"
    size="min(640px, 96vw)"
    direction="rtl"
    destroy-on-close
  >
    <p class="recharge-note">
      查看历史记录不会重新连接、建单或付款；付款结果未知时可单独确认银行卡未收到请求。
    </p>
    <ul class="recharge-history">
      <li v-for="job in jobs" :key="job.id">
        <button
          type="button"
          :aria-pressed="historyId === job.id"
          :class="{ 'is-selected': historyId === job.id }"
          @click="select(job.id)"
        >
          {{ planLabels[job.plan] }} · {{ statusLabel(job.result.status || job.state) }}
          <small>{{ formatV2DateTime(job.createdAt) }}</small>
        </button>
      </li>
    </ul>
    <RechargeResult v-if="historyJob" :job="historyJob" />
    <div v-if="canRecheck || canResolveNoBankRequest" class="recharge-actions">
      <el-button v-if="canRecheck" type="primary" :loading="busy" @click="$emit('recheck')">
        只读复查原订单
      </el-button>
      <el-button
        v-if="canResolveNoBankRequest"
        type="warning"
        :loading="busy"
        @click="$emit('resolve-no-bank-request')"
      >
        确认银行卡未收到付款请求
      </el-button>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { V2RechargeJob } from './contracts';
import { formatV2DateTime } from '@/v2/utils/dateTime';
import RechargeResult from './RechargeResult.vue';
import { planLabels, statusLabel } from './recharge-presentation';

const model = defineModel<boolean>({ required: true });
const props = defineProps<{
  jobs: V2RechargeJob[];
  canRecheck: boolean;
  canResolveNoBankRequest: boolean;
  busy: boolean;
}>();
const emit = defineEmits<{
  select: [id: string];
  recheck: [];
  'resolve-no-bank-request': [];
}>();
const historyId = ref('');
const historyJob = computed(() => props.jobs.find((job) => job.id === historyId.value));
function select(id: string) {
  historyId.value = id;
  emit('select', id);
}
</script>
