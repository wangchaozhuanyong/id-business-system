import { computed, onScopeDispose, ref, watch } from 'vue';
import { getApiErrorMessage } from '@/api/client';
import { useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { rechargeApi } from './api';
import { rechargeDetailsReady } from './recharge-form';
import type {
  V2RechargeAction,
  V2RechargeAddress,
  V2RechargeAddressList,
  V2RechargeDetails,
  V2RechargeJob,
  V2RechargePlan
} from './contracts';

const isActive = (job: V2RechargeJob) =>
  ['running', 'awaiting_details', 'awaiting_confirmation', 'confirming'].includes(job.state);
const requiresStatusPolling = (job: V2RechargeJob) => ['running', 'confirming'].includes(job.state);
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function registrationEmail(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const document = value as Record<string, unknown>;
  const candidates: string[] = [];
  const user = document.user;
  if (user && typeof user === 'object' && !Array.isArray(user)) {
    const email = (user as Record<string, unknown>).email;
    if (typeof email === 'string' && emailPattern.test(email.trim())) candidates.push(email.trim());
  }
  for (const key of ['accessToken', 'access_token'] as const) {
    const token = document[key];
    if (typeof token !== 'string' || typeof atob !== 'function') continue;
    try {
      const encoded = token.split('.')[1];
      if (!encoded) continue;
      const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
      const binary = atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4));
      const payload = JSON.parse(
        new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)))
      ) as Record<string, unknown>;
      const profile = payload['https://api.openai.com/profile'];
      if (profile && typeof profile === 'object' && !Array.isArray(profile)) {
        const email = (profile as Record<string, unknown>).email;
        if (typeof email === 'string' && emailPattern.test(email.trim()))
          candidates.push(email.trim());
      }
    } catch {
      /* 完整凭据仍由 Worker 验证；本地只提取可用的注册邮箱。 */
    }
  }
  const unique = [...new Set(candidates.map((email) => email.toLowerCase()))];
  return unique.length === 1 ? candidates[0]! : '';
}

const emptyDetails = (): V2RechargeDetails => ({
  number: '',
  expiry: '',
  cvc: '',
  name: '',
  email: '',
  country: '',
  line1: '',
  line2: '',
  city: '',
  state: '',
  postal_code: ''
});

export function useAutoRecharge() {
  const jsonInput = ref('');
  const sessionJson = ref('');
  const jsonError = ref('');
  const plan = ref<V2RechargePlan>('plus');
  const selectedAddressId = ref('');
  const currentId = ref('');
  const busy = ref(false);
  const error = ref('');
  const uncertain = ref(false);
  const importing = ref(false);
  const detailsSubmittedFor = ref('');
  const confirmationSentFor = ref('');
  const cardClearedFor = new Set<string>();
  const details = ref<V2RechargeDetails>(emptyDetails());
  let disposed = false;
  let importGeneration = 0;

  const query = useV2ModuleQuery<{ items: V2RechargeJob[]; configured: boolean }>({
    moduleKey: 'auto-recharge',
    scope: 'auto-recharge',
    key: () => 'auto-recharge-jobs',
    keepPreviousData: true,
    getRevalidateAt: (result) =>
      result.items.some(requiresStatusPolling) ||
      Boolean(currentId.value && !result.items.some((job) => job.id === currentId.value))
        ? Date.now() + 2000
        : null,
    query: ({ signal }) => rechargeApi.list({ signal })
  });
  const addressQuery = useV2ModuleQuery<V2RechargeAddressList>({
    moduleKey: 'auto-recharge-addresses',
    scope: 'auto-recharge',
    key: () => 'auto-recharge-unused-addresses',
    keepPreviousData: true,
    query: ({ signal }) =>
      rechargeApi.listAddresses({ page: 1, pageSize: 2000, status: 'unused' }, { signal })
  });
  const jobs = computed(() => query.data.value?.items ?? []);
  const availableAddresses = computed(() => addressQuery.data.value?.items ?? []);
  const selectedAddress = computed<V2RechargeAddress | undefined>(() =>
    availableAddresses.value.find((address) => address.id === selectedAddressId.value)
  );
  const selected = computed(() =>
    currentId.value
      ? jobs.value.find((job) => job.id === currentId.value)
      : jobs.value.find(isActive)
  );
  const active = computed(() => jobs.value.some(isActive));
  const pendingReceipt = computed(() => Boolean(currentId.value && !selected.value));
  const accountLocked = computed(
    () => busy.value || active.value || uncertain.value || pendingReceipt.value
  );
  const awaitingDetails = computed(
    () => selected.value?.action === 'flow' && selected.value.state === 'awaiting_details'
  );
  const billingInputLocked = computed(
    () =>
      !sessionJson.value ||
      (awaitingDetails.value && detailsSubmittedFor.value === selected.value?.id) ||
      ['awaiting_confirmation', 'confirming'].includes(selected.value?.state ?? '')
  );
  const canStartFlow = computed(
    () =>
      Boolean(sessionJson.value && plan.value) &&
      !accountLocked.value &&
      query.phase.value === 'ready' &&
      query.data.value?.configured !== false
  );
  const canSubmitDetails = computed(
    () =>
      awaitingDetails.value &&
      !busy.value &&
      detailsSubmittedFor.value !== selected.value?.id &&
      Boolean(selectedAddress.value) &&
      rechargeDetailsReady(details.value)
  );

  watch(
    [selectedAddressId, availableAddresses, () => addressQuery.phase.value],
    () => {
      const address = selectedAddress.value;
      if (!address) {
        if (selectedAddressId.value && addressQuery.phase.value === 'ready') {
          selectedAddressId.value = '';
        }
        Object.assign(details.value, {
          country: '',
          line1: '',
          line2: '',
          city: '',
          state: '',
          postal_code: ''
        });
        return;
      }
      Object.assign(details.value, {
        country: address.country,
        line1: address.line1,
        line2: '',
        city: address.city,
        state: address.state,
        postal_code: address.postalCode
      });
    },
    { flush: 'sync' }
  );

  const confirmationBlockedReason = computed(() => {
    const job = selected.value;
    if (busy.value) return '正在提交，请等待状态回传。';
    if (uncertain.value || confirmationSentFor.value === job?.id)
      return '本次确认已发送，请等待或复查原任务，不要重复付款。';
    if (job?.state !== 'awaiting_confirmation') return '等待官网完成最终核价。';
    if (!job.result.nonce) return '确认凭据无效，请停止当前任务后重新核价。';
    const quote = job.result.quote;
    if (!quote?.today || quote.tax === null || !quote.renewal)
      return '官网尚未回传完整的应付、税费和续费金额。';
    if (job.result.quote_authority !== 'official_checkout_response')
      return '最终金额尚未与官网订单响应核对。';
    return '';
  });
  const canConfirm = computed(() => !confirmationBlockedReason.value);
  const canRetry = computed(
    () =>
      !accountLocked.value &&
      Boolean(sessionJson.value && plan.value) &&
      Boolean(error.value || selected.value?.result.reason) &&
      selected.value?.state !== 'unknown' &&
      !selected.value?.result.payment_attempted &&
      !selected.value?.result.payment_outcome &&
      !confirmationSentFor.value
  );
  const canRecheck = computed(() =>
    Boolean(
      selected.value &&
      ['finished', 'unknown'].includes(selected.value.state) &&
      (selected.value.state === 'unknown' ||
        selected.value.result.payment_attempted ||
        selected.value.result.payment_outcome) &&
      sessionJson.value &&
      plan.value === selected.value.plan &&
      !busy.value &&
      !active.value
    )
  );
  const workflowMessage = computed(() => {
    const job = selected.value;
    if (query.data.value?.configured === false) return '服务器执行器尚未配置。';
    if (uncertain.value) return '请求结果尚未确认，请刷新原任务状态；系统不会自动重发。';
    if (busy.value || pendingReceipt.value) return '正在提交当前步骤，等待服务器回传状态。';
    if (job?.state === 'awaiting_details')
      return job.result.initial_quote?.today
        ? '已取得初始报价。请填写付款资料并点击“填写官网并计算最终金额”。'
        : '官网需要账单地址才能确定税费和总额，请填写资料后继续。';
    if (job?.state === 'awaiting_confirmation')
      return '资料已填入官网，请核对最终金额、税费、套餐和续费后确认充值。';
    if (job?.state === 'confirming') return '已确认本次付款，正在等待官网回传开通结果。';
    if (job?.state === 'running')
      return job.action === 'recheck'
        ? '正在只读复查原订单，不会再次付款。'
        : '正在核对账户、套餐和官网初始报价。';
    if (error.value || job?.result.reason || job?.state === 'unknown')
      return '本次流程已停止，请查看执行结果与处理说明。';
    if (!sessionJson.value) return '载入授权 JSON 后，再选择需要开通的套餐。';
    if (!plan.value) return '请选择需要开通的套餐。';
    return '点击“获取初始报价”后，系统才会访问官网。';
  });

  const clearCard = () => {
    details.value.number = '';
    details.value.cvc = '';
    details.value.expiry = '';
  };
  async function refresh() {
    if (disposed) return;
    try {
      await query.refresh();
    } catch {
      /* 读取失败由查询区域展示，不能重放写请求。 */
    }
  }
  async function execute(action: V2RechargeAction) {
    if (
      disposed ||
      busy.value ||
      active.value ||
      (uncertain.value && action !== 'recheck') ||
      !sessionJson.value ||
      !plan.value
    )
      return;
    busy.value = true;
    error.value = '';
    const id = crypto.randomUUID();
    currentId.value = id;
    try {
      await rechargeApi.start({ id, plan: plan.value, action, sessionJson: sessionJson.value });
      if (!disposed && action === 'recheck') uncertain.value = false;
    } catch (cause) {
      if (!disposed) error.value = getApiErrorMessage(cause);
    } finally {
      if (!disposed) {
        await refresh();
        busy.value = false;
      }
    }
  }
  async function startFlow() {
    if (!sessionJson.value) {
      jsonError.value = '请先载入有效的单账户授权 JSON';
      return;
    }
    if (!plan.value) {
      error.value = '请选择需要开通的套餐。';
      return;
    }
    if (!canStartFlow.value) return;
    await execute('flow');
  }

  async function submitPaymentDetails() {
    const job = selected.value;
    if (!canSubmitDetails.value || !job || !selectedAddress.value) {
      error.value = '请补齐有效付款资料并选择一条未使用地址。';
      return;
    }
    detailsSubmittedFor.value = job.id;
    busy.value = true;
    error.value = '';
    try {
      await rechargeApi.submitDetails(job.id, {
        addressId: selectedAddress.value.id,
        details: { ...details.value }
      });
    } catch (cause) {
      if (!disposed) {
        detailsSubmittedFor.value = '';
        error.value = getApiErrorMessage(cause);
      }
    } finally {
      if (!disposed) {
        await refresh();
        busy.value = false;
      }
    }
  }

  function acceptSession(reportInvalid = true) {
    importGeneration++;
    if (accountLocked.value) return;
    if (!jsonInput.value.trim()) {
      if (sessionJson.value) jsonError.value = '';
      else if (reportInvalid) jsonError.value = '请粘贴完整的单账户授权 JSON';
      return;
    }
    try {
      if (new TextEncoder().encode(jsonInput.value).length > 65000)
        throw new Error('JSON 不能超过 65 KB');
      const value = JSON.parse(jsonInput.value);
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('请输入完整的单账户 JSON');
      const email = registrationEmail(value);
      if (!email) {
        jsonError.value = '授权 JSON 中未找到唯一有效的 ChatGPT 注册邮箱';
        return;
      }
      sessionJson.value = jsonInput.value;
      details.value.email = email;
      jsonInput.value = '';
      jsonError.value = '';
    } catch {
      if (reportInvalid) jsonError.value = '请提供有效的单账户 JSON（不超过 65 KB）';
    }
  }
  function updateJsonInput(value: string) {
    if (accountLocked.value) return;
    jsonInput.value = value;
    if (sessionJson.value) {
      sessionJson.value = '';
      details.value.email = '';
    }
    if (!value.trim()) {
      jsonError.value = '';
      return;
    }
    acceptSession(false);
  }
  watch(
    [sessionJson, plan],
    () => {
      if (active.value) return;
      currentId.value = '';
      error.value = '';
      uncertain.value = false;
      detailsSubmittedFor.value = '';
      confirmationSentFor.value = '';
    },
    { flush: 'sync' }
  );
  watch(
    () => [selected.value?.id, selected.value?.state],
    () => {
      const job = selected.value;
      if (job?.state === 'awaiting_confirmation' && !cardClearedFor.has(job.id)) {
        cardClearedFor.add(job.id);
        clearCard();
      }
    },
    { flush: 'post' }
  );
  const refreshedConsumedJobs = new Set<string>();
  watch(
    () => [selected.value?.id, selected.value?.result.payment_attempted],
    async () => {
      const job = selected.value;
      if (!job?.result.payment_attempted || refreshedConsumedJobs.has(job.id)) return;
      refreshedConsumedJobs.add(job.id);
      await addressQuery.refresh();
    },
    { flush: 'post' }
  );

  async function confirmPayment() {
    const job = selected.value;
    if (!canConfirm.value || !job?.result.nonce) {
      error.value = confirmationBlockedReason.value || '当前官方报价尚不能确认。';
      return;
    }
    confirmationSentFor.value = job.id;
    busy.value = true;
    error.value = '';
    try {
      await rechargeApi.confirm(job.id, job.result.nonce);
      clearCard();
    } catch (cause) {
      if (!disposed) {
        error.value = getApiErrorMessage(cause);
        uncertain.value = true;
      }
    } finally {
      if (!disposed) {
        await refresh();
        busy.value = false;
      }
    }
  }
  async function cancel() {
    const job = selected.value;
    if (
      busy.value ||
      !job ||
      !['running', 'awaiting_details', 'awaiting_confirmation'].includes(job.state)
    )
      return;
    busy.value = true;
    try {
      await rechargeApi.cancel(job.id);
      clearCard();
    } catch (cause) {
      if (!disposed) error.value = getApiErrorMessage(cause);
    } finally {
      if (!disposed) {
        await refresh();
        busy.value = false;
      }
    }
  }
  async function retryPreparation() {
    if (!canRetry.value) return;
    error.value = '';
    await startFlow();
  }
  async function recheckPayment() {
    if (!canRecheck.value) return;
    await execute('recheck');
  }
  async function importJson(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    const generation = ++importGeneration;
    if (!file || accountLocked.value) return;
    importing.value = true;
    try {
      if (file.size > 65000) throw new Error('JSON 文件不能超过 65 KB');
      const value = await file.text();
      if (!disposed && generation === importGeneration && !accountLocked.value) {
        jsonInput.value = value;
        acceptSession();
      }
    } catch {
      if (!disposed) jsonError.value = '文件读取失败，请选择不超过 65 KB 的 JSON 或文本文件';
    } finally {
      if (!disposed) importing.value = false;
      input.value = '';
    }
  }
  onScopeDispose(() => {
    disposed = true;
    importGeneration++;
    sessionJson.value = '';
    jsonInput.value = '';
    selectedAddressId.value = '';
    Object.assign(details.value, emptyDetails());
  });
  return {
    query,
    addressQuery,
    jobs,
    availableAddresses,
    selectedAddressId,
    selectedAddress,
    selected,
    active,
    jsonInput,
    sessionJson,
    jsonError,
    plan,
    busy,
    error,
    details,
    accountLocked,
    billingInputLocked,
    canStartFlow,
    canSubmitDetails,
    canConfirm,
    confirmationBlockedReason,
    canRetry,
    canRecheck,
    recheckPayment,
    workflowMessage,
    acceptSession,
    updateJsonInput,
    startFlow,
    submitPaymentDetails,
    confirmPayment,
    cancel,
    importJson,
    refresh,
    retryPreparation
  };
}
