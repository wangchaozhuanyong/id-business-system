<template>
  <section class="v2-page-layout" aria-label="历史任务只读核对">
    <p class="recharge-note">
      批量读取现有记录，不重新建单或付款。租约结束会释放执行名额；付款未知不会因超时自动解锁。
    </p>
    <el-form label-position="left" require-asterisk-position="right" @submit.prevent="search">
      <el-form-item label="查找记录">
        <el-input
          v-model="draft.search"
          placeholder="任务编号或窗口名称"
          clearable
          @keyup.enter="search"
        />
      </el-form-item>
      <div class="recharge-actions">
        <AppButton
          :disabled="busy || resolving || query.phase.value === 'refreshing'"
          @click="search"
          >查询记录</AppButton
        >
        <AppButton
          :disabled="busy || resolving || query.phase.value === 'refreshing'"
          @click="query.refresh()"
          >只读刷新</AppButton
        >
      </div>
    </el-form>
    <V2AsyncRegion
      :phase="query.phase.value"
      :resolved="query.hasLoadedOnce.value"
      loading-title="正在核对执行记录"
      :error="query.error.value ? getApiErrorMessage(query.error.value) : undefined"
      skeleton="cards"
      variant="section"
      @retry="query.refresh()"
    >
      <p v-if="!pageItems.length" class="recharge-note">没有符合条件的执行记录。</p>
      <ul v-else class="recharge-history">
        <li v-for="job in pageItems" :key="job.id">
          <button
            type="button"
            :aria-pressed="draft.selectedId === job.id"
            :disabled="busy || resolving"
            @click="draft.selectedId = job.id"
          >
            {{ planLabels[job.plan] }} ·
            {{
              job.availability
                ? paymentAvailabilityLabels[job.availability.payment]
                : statusLabel(job.result.status || job.state)
            }}
            <small
              >{{
                job.availability
                  ? executionAvailabilityLabels[job.availability.execution]
                  : '执行状态待核对'
              }}
              · {{ formatV2DateTime(job.createdAt) }}</small
            >
            <small>任务编号：{{ job.id }}</small>
          </button>
        </li>
      </ul>
      <el-pagination
        v-pagination-label
        :current-page="query.data.value?.page ?? draft.page"
        :page-size="20"
        :total="query.data.value?.total ?? 0"
        :disabled="busy || resolving"
        layout="total, prev, pager, next"
        @current-change="draft.page = $event"
      />
      <RechargeResult v-if="selected" :job="selected" />
      <AppButton
        v-if="
          selected?.availability?.payment === 'declined' &&
          selected.result.resolution_verification_job_id
        "
        :loading="resolving"
        :disabled="busy || resolving"
        @click="resolveDeclined"
        >核实拒付并结束原单</AppButton
      >
      <p v-if="commandError" class="recharge-note" role="alert">{{ commandError }}</p>
      <AppButton
        v-if="selected && canReviewPayment(selected)"
        :disabled="busy || resolving || !inspectionReady"
        @click="$emit('recheck', selected)"
        >只读复查该原单</AppButton
      >
      <p v-if="selected" class="recharge-note">
        可直接只读复查所选原单；原窗口不可用时，先通过“仅登录”核实同一账号。银行扣款仍需单独核实。
      </p>
    </V2AsyncRegion>
  </section>
</template>

<script setup lang="ts">
import { computed, reactive, ref, toRefs, watch } from 'vue';
import { ElMessageBox } from 'element-plus/es/components/message-box/index.mjs';
import { getApiErrorMessage } from '@/api/client';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import { useV2SessionDraft } from '@/v2/composables/useV2SessionDraft';
import { createV2QueryKey, useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { formatV2DateTime } from '@/v2/utils/dateTime';
import RechargeResult from './RechargeResult.vue';
import { rechargeApi } from './api';
import { planLabels, statusLabel } from './recharge-presentation';
import { executionAvailabilityLabels, paymentAvailabilityLabels } from './recharge-availability';
import type { V2RechargeJob } from './contracts';
defineProps<{ busy: boolean; inspectionReady: boolean }>();
const emit = defineEmits<{ recheck: [job: V2RechargeJob]; 'busy-change': [value: boolean] }>();
function canReviewPayment(job: V2RechargeJob) {
  return (
    job.action === 'bitbrowser' &&
    ['finished', 'unknown'].includes(job.state) &&
    job.result.recheck_only !== true &&
    job.result.operator_resolution !== 'confirmed_no_bank_request' &&
    ['unknown', 'declined', 'paid_pending'].includes(job.availability?.payment ?? '') &&
    job.availability?.execution !== 'active'
  );
}
const draft = useV2SessionDraft('auto-recharge-payment-review', () =>
  reactive({
    search: '',
    appliedSearch: '',
    page: 1,
    selectedId: ''
  })
);
const query = useV2ModuleQuery({
  moduleKey: 'auto-recharge',
  scope: 'auto-recharge',
  key: () =>
    createV2QueryKey({ region: 'payment-review', page: draft.page, search: draft.appliedSearch }),
  keepPreviousData: true,
  query: ({ signal }) =>
    rechargeApi.review({ page: draft.page, pageSize: 20, search: draft.appliedSearch }, { signal })
});
const resolving = ref(false),
  commandError = ref('');
watch(resolving, (value) => emit('busy-change', value), { flush: 'sync' });
async function resolveDeclined() {
  const job = selected.value,
    verification = job?.result.resolution_verification_job_id;
  if (!job || typeof verification !== 'string' || resolving.value) return;
  try {
    await ElMessageBox.confirm(
      '请先核对银行账单，确认该原单没有扣款或待入账交易。此操作仅处理已明确拒付且账号已核实为免费版的原单，保留原付款尝试；不会充值或付款。',
      '核实拒付原单',
      {
        confirmButtonText: '已核对银行无扣款，确认结束',
        cancelButtonText: '暂不处理',
        type: 'warning'
      }
    );
  } catch {
    return;
  }
  resolving.value = true;
  commandError.value = '';
  try {
    await rechargeApi.resolveDeclined(job.id, verification);
    await query.refresh();
  } catch (error) {
    commandError.value = getApiErrorMessage(error);
  } finally {
    resolving.value = false;
  }
}
const pageItems = computed(() => query.data.value?.items ?? []);
const selected = computed(() => pageItems.value.find((job) => job.id === draft.selectedId));
const { page, appliedSearch } = toRefs(draft);
watch([page, appliedSearch], () => {
  void query.ensureFresh();
});
function search() {
  draft.page = 1;
  draft.appliedSearch = draft.search.trim();
  void query.ensureFresh();
}
</script>
