<template>
  <el-drawer
    v-model="model"
    title="最近执行记录"
    size="min(640px, 96vw)"
    direction="rtl"
    :before-close="closeDrawer"
    destroy-on-close
  >
    <p v-if="reviewBusy" class="recharge-note" role="status">正在保存拒付核实，请完成后再关闭。</p>
    <p class="recharge-note">
      失败记录不会继续占执行名额；历史付款保护只限制相关账号的新付款。仅登录、查单和其他账号仍可操作。
    </p>
    <AppButton :disabled="reviewBusy || busy" @click="reviewOpen = !reviewOpen">{{
      reviewOpen ? '收起全部记录核对' : '分页核对全部执行记录'
    }}</AppButton>
    <RechargePaymentReview
      v-if="reviewOpen"
      :busy="busy"
      :inspection-ready="inspectionReady"
      @recheck="$emit('review-recheck', $event)"
      @busy-change="reviewBusy = $event"
    />
    <p class="recharge-note">
      原窗口不可用时，先仅登录并核实同一账号，再只读复查原单；更换窗口不解除付款保护。
    </p>
    <AppButton :disabled="busy" @click="$emit('prepare-inspection')">切换到仅登录</AppButton>
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
      <AppButton v-if="canRecheck" variant="primary" :loading="busy" @click="$emit('recheck')">
        只读复查原订单
      </AppButton>
      <AppButton
        v-if="canResolveNoBankRequest"
        variant="warning"
        :loading="busy"
        @click="$emit('resolve-no-bank-request')"
      >
        确认银行卡未收到付款请求
      </AppButton>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import AppButton from '@/components/ui/AppButton.vue';
import { computed, reactive, ref } from 'vue';
import { useV2SessionDraft } from '@/v2/composables/useV2SessionDraft';
import RechargePaymentReview from './RechargePaymentReview.vue';
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
  inspectionReady: boolean;
}>();
const emit = defineEmits<{
  select: [id: string];
  recheck: [];
  'resolve-no-bank-request': [];
  'review-recheck': [job: V2RechargeJob];
  'prepare-inspection': [];
}>();
const reviewBusy = ref(false);
function closeDrawer(done: () => void) {
  if (!reviewBusy.value && !props.busy) done();
}
const draft = useV2SessionDraft('auto-recharge-history-selection', () =>
  reactive({
    historyId: '',
    reviewOpen: false
  })
);
const historyId = computed({
  get: () => draft.historyId,
  set: (value) => {
    draft.historyId = value;
  }
});
const reviewOpen = computed({
  get: () => draft.reviewOpen,
  set: (value) => {
    draft.reviewOpen = value;
  }
});
const historyJob = computed(() => props.jobs.find((job) => job.id === historyId.value));
function select(id: string) {
  historyId.value = id;
  emit('select', id);
}
</script>
