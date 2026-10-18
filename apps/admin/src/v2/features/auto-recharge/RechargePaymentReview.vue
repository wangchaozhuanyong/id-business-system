<template>
  <section class="v2-page-layout" aria-label="历史任务只读核对">
    <p class="recharge-note">
      批量读取现有记录，不重新建单或付款。租约结束会释放执行名额；付款未知不会因超时自动解锁。
    </p>
    <el-form label-position="left" require-asterisk-position="right" @submit.prevent="search">
      <el-form-item label="查找记录">
        <V2SearchInput
          v-model="draft.search"
          draft-key="auto-recharge:payment-review:search"
          placeholder="任务编号或窗口名称"
          clearable
          @search="search"
        />
      </el-form-item>
      <div class="recharge-actions">
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
        v-if="verificationResolution"
        :disabled="busy || resolving || query.phase.value !== 'ready'"
        @click="openVerificationResolution"
        >核实验证失败并结束原单</AppButton
      >
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
    <V2ConfirmDialog
      v-model="verificationDialogOpen"
      title="核实支付方式验证失败原单"
      message="请本人核对所选原单的官网提示和银行流水。"
      width="min(620px, 96vw)"
      confirm-text="核实并结束所选原单"
      cancel-text="暂不处理"
      :confirm-loading="resolving"
      :confirm-disabled-reason="verificationDisabledReason"
      @confirm="resolveVerificationFailure"
    >
      <template v-if="verificationSnapshot">
        <dl class="recharge-summary">
          <dt>原任务编号</dt>
          <dd>{{ verificationSnapshot.sourceId }}</dd>
          <dt>官网原单</dt>
          <dd>{{ verificationSnapshot.proof.checkoutIdentifier }}</dd>
          <dt>目标套餐</dt>
          <dd>{{ planLabels[verificationSnapshot.plan] }}</dd>
          <dt>原任务时间</dt>
          <dd>{{ formatV2DateTime(verificationSnapshot.createdAt) }}</dd>
          <template v-if="verificationSnapshot.cardLast4">
            <dt>银行卡尾号</dt>
            <dd>{{ verificationSnapshot.cardLast4 }}</dd>
          </template>
          <dt>账号核验</dt>
          <dd>官网已核实为同一账号，当前为免费版</dd>
          <dt>核验任务编号</dt>
          <dd>{{ verificationSnapshot.proof.verificationJobId }}</dd>
          <dt>付款后核验时间</dt>
          <dd>{{ formatV2DateTime(verificationSnapshot.proof.verifiedAt) }}</dd>
          <dt>官网提示记录</dt>
          <dd>
            {{
              verificationSnapshot.proof.basis === 'captured_official_failure'
                ? '已记录支付方式验证失败提示'
                : '需本人对照原单确认支付方式验证失败提示'
            }}
          </dd>
        </dl>
        <p class="recharge-note">
          请核对上方官网原单。卡内没有余额不能证明银行没有扣款或待入账交易。
        </p>
        <el-form
          label-position="left"
          label-width="88px"
          require-asterisk-position="right"
          @submit.prevent="resolveVerificationFailure"
        >
          <el-form-item label="官网提示" required>
            <el-checkbox v-model="officialFailureConfirmed" :disabled="resolving">
              我已在该原单官网页面看到“我们未能验证您的支付方式，请选择另一支付方式并重试”。
            </el-checkbox>
          </el-form-item>
          <el-form-item label="银行流水" required>
            <el-checkbox v-model="bankNoDebitConfirmed" :disabled="resolving">
              我已核对这笔原单的银行流水，确认没有扣款，也没有待入账交易。
            </el-checkbox>
          </el-form-item>
        </el-form>
        <p class="recharge-note">
          处理后保留原付款尝试和次数，仅结束所选原单的内部付款保护；其他待核实原单继续保护。此操作不会充值或付款。
        </p>
        <p v-if="commandError" class="recharge-note" role="alert">{{ commandError }}</p>
      </template>
    </V2ConfirmDialog>
  </section>
</template>

<script setup lang="ts">
import V2SearchInput from '@/v2/components/V2SearchInput.vue';
import { computed, onBeforeUnmount, reactive, ref, toRefs, watch } from 'vue';
import { ElMessageBox } from 'element-plus/es/components/message-box/index.mjs';
import { getApiErrorMessage } from '@/api/client';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2ConfirmDialog from '@/v2/components/V2ConfirmDialog.vue';
import { useV2SessionDraft } from '@/v2/composables/useV2SessionDraft';
import { createV2QueryKey, useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { formatV2DateTime } from '@/v2/utils/dateTime';
import RechargeResult from './RechargeResult.vue';
import { rechargeApi } from './api';
import { planLabels, statusLabel } from './recharge-presentation';
import { executionAvailabilityLabels, paymentAvailabilityLabels } from './recharge-availability';
import type { V2RechargeResolveDeclinedInput } from '@apple-business/shared';
import type { V2RechargeJob } from './contracts';
const props = defineProps<{ busy: boolean; inspectionReady: boolean }>();
const emit = defineEmits<{ recheck: [job: V2RechargeJob]; 'busy-change': [value: boolean] }>();
function canReviewPayment(job: V2RechargeJob) {
  return (
    job.action === 'bitbrowser' &&
    ['finished', 'unknown'].includes(job.state) &&
    job.result.recheck_only !== true &&
    ![
      'confirmed_no_bank_request',
      'confirmed_declined_no_charge',
      'confirmed_verification_failed_no_charge'
    ].includes(String(job.result.operator_resolution)) &&
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
const pageItems = computed(() => query.data.value?.items ?? []);
const selected = computed(() => pageItems.value.find((job) => job.id === draft.selectedId));
const verificationResolution = computed(() => {
  const job = selected.value,
    proof = job?.result.payment_verification_resolution;
  if (
    !job ||
    job.action !== 'bitbrowser' ||
    job.state !== 'finished' ||
    job.result.operator_resolution ||
    job.availability?.execution === 'active' ||
    !proof ||
    !['captured_official_failure', 'operator_observation_required'].includes(proof.basis) ||
    proof.accountMatched !== true ||
    proof.currentPlan !== 'free' ||
    proof.checkoutIdentifier !== job.result.checkout_identifier ||
    !proof.verificationJobId ||
    !Number.isFinite(Date.parse(proof.verifiedAt))
  )
    return;
  return proof;
});
const verificationBinding = computed(() => {
  const job = selected.value,
    proof = verificationResolution.value;
  return job && proof
    ? JSON.stringify([
        job.id,
        job.plan,
        job.updatedAt,
        job.createdAt,
        job.result.card_last4,
        job.result.payment_status,
        job.result.payment_attempted,
        job.result.payment_requests_sent,
        job.result.confirmation_requests_sent,
        job.availability,
        proof
      ])
    : '';
});
type VerificationProof = NonNullable<V2RechargeJob['result']['payment_verification_resolution']>;
const verificationDialogOpen = ref(false),
  officialFailureConfirmed = ref(false),
  bankNoDebitConfirmed = ref(false),
  verificationSnapshot = ref<{
    sourceId: string;
    plan: V2RechargeJob['plan'];
    createdAt: string;
    cardLast4?: string;
    binding: string;
    proof: VerificationProof;
  }>();
let verificationGeneration = 0,
  disposed = false;
function clearVerificationResolution() {
  verificationGeneration += 1;
  officialFailureConfirmed.value = false;
  bankNoDebitConfirmed.value = false;
  verificationSnapshot.value = undefined;
  verificationDialogOpen.value = false;
}
watch(
  verificationDialogOpen,
  (open) => {
    if (!open && verificationSnapshot.value) clearVerificationResolution();
  },
  { flush: 'sync' }
);
watch(
  verificationBinding,
  (binding) => {
    if (verificationSnapshot.value && verificationSnapshot.value.binding !== binding) {
      clearVerificationResolution();
      commandError.value = '原单或账号核验记录已变化，请重新核对后再处理。';
    }
  },
  { flush: 'sync' }
);
const verificationDisabledReason = computed(() => {
  if (
    !verificationSnapshot.value ||
    verificationSnapshot.value.binding !== verificationBinding.value
  )
    return '原单或核验记录已变化，请重新核对';
  if (props.busy || query.phase.value !== 'ready') return '请等待当前核对完成';
  if (!officialFailureConfirmed.value || !bankNoDebitConfirmed.value)
    return '请本人完成官网提示及银行流水两项确认';
  return '';
});
function openVerificationResolution() {
  const job = selected.value,
    proof = verificationResolution.value;
  if (!job || !proof || props.busy || resolving.value || query.phase.value !== 'ready') return;
  clearVerificationResolution();
  commandError.value = '';
  verificationSnapshot.value = {
    sourceId: job.id,
    plan: job.plan,
    createdAt: job.createdAt,
    ...(typeof job.result.card_last4 === 'string' && /^\d{4}$/.test(job.result.card_last4)
      ? { cardLast4: job.result.card_last4 }
      : {}),
    binding: verificationBinding.value,
    proof: { ...proof }
  };
  verificationDialogOpen.value = true;
}
async function resolveVerificationFailure() {
  const snapshot = verificationSnapshot.value;
  if (
    !verificationDialogOpen.value ||
    !snapshot ||
    resolving.value ||
    verificationDisabledReason.value
  )
    return;
  const generation = verificationGeneration;
  const input: V2RechargeResolveDeclinedInput = {
    confirmNoDebit: true,
    verificationJobId: snapshot.proof.verificationJobId,
    ...(snapshot.proof.basis === 'operator_observation_required'
      ? {
          verificationFailureObservation: {
            checkoutIdentifier: snapshot.proof.checkoutIdentifier,
            officialMessage: 'payment_method_verification_failed' as const
          }
        }
      : {})
  };
  resolving.value = true;
  commandError.value = '';
  try {
    await rechargeApi.resolveDeclined(snapshot.sourceId, input);
    if (disposed || generation !== verificationGeneration) return;
    clearVerificationResolution();
    await query.refresh();
  } catch (error) {
    if (!disposed && generation === verificationGeneration)
      commandError.value = getApiErrorMessage(error);
  } finally {
    if (!disposed) resolving.value = false;
  }
}
onBeforeUnmount(() => {
  disposed = true;
  clearVerificationResolution();
  if (resolving.value) emit('busy-change', false);
});
async function resolveDeclined() {
  const job = selected.value,
    verification = job?.result.resolution_verification_job_id;
  if (
    !job ||
    typeof verification !== 'string' ||
    resolving.value ||
    props.busy ||
    verificationDialogOpen.value
  )
    return;
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
