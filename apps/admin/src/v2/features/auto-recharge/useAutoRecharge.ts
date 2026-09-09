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
  ['running', 'confirming', 'awaiting_confirmation'].includes(job.state);

export function useAutoRecharge() {
  const jsonInput = ref('');
  const sessionJson = ref('');
  const jsonError = ref('');
  const plan = ref<V2RechargePlan>();
  const selectedAddressId = ref('');
  const currentId = ref('');
  const quoteId = ref('');
  const busy = ref(false);
  const error = ref('');
  const uncertain = ref(false);
  const editingDetails = ref(false);
  const importing = ref(false);
  const prepareAttempted = ref(false);
  const quoteAttempted = ref(false);
  const confirmationSentFor = ref('');
  const details = ref<V2RechargeDetails>({
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
  let disposed = false;
  let importGeneration = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const query = useV2ModuleQuery<{ items: V2RechargeJob[]; configured: boolean }>({
    moduleKey: 'auto-recharge',
    scope: 'auto-recharge',
    key: () => 'auto-recharge-jobs',
    keepPreviousData: true,
    getRevalidateAt: () => Date.now() + 2000,
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
  // 历史浏览不改变当前任务；刷新页面只恢复仍在执行的任务。
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
  const billingLocked = computed(
    () =>
      busy.value ||
      uncertain.value ||
      pendingReceipt.value ||
      (active.value &&
        !(selected.value?.id === quoteId.value && selected.value?.action === 'quote'))
  );
  const quoteReady = computed(() => {
    const job = jobs.value.find((item) => item.id === quoteId.value);
    return Boolean(
      job &&
      job.state === 'finished' &&
      job.plan === plan.value &&
      job.result.account_matched === true &&
      job.result.quote?.today &&
      job.result.quote.plan === plan.value &&
      !job.result.reason &&
      !job.result.payment_attempted
    );
  });
  watch(
    [selectedAddressId, availableAddresses, () => addressQuery.phase.value],
    () => {
      const address = selectedAddress.value;
      if (!address) {
        if (selectedAddressId.value && addressQuery.phase.value === 'ready') {
          selectedAddressId.value = '';
        }
        details.value.country = '';
        details.value.line1 = '';
        details.value.line2 = '';
        details.value.city = '';
        details.value.state = '';
        details.value.postal_code = '';
        return;
      }
      details.value.country = address.country;
      details.value.line1 = address.line1;
      details.value.line2 = '';
      details.value.city = address.city;
      details.value.state = address.state;
      details.value.postal_code = address.postalCode;
    },
    { flush: 'sync' }
  );
  const confirmationBlockedReason = computed(() => {
    if (busy.value) return '正在提交，请等待状态回传。';
    if (uncertain.value || confirmationSentFor.value === selected.value?.id)
      return '本次确认已发送，请等待或复查原任务，不要重复付款。';
    if (selected.value?.state !== 'awaiting_confirmation') return '等待官网完成核价。';
    if (!selected.value.result.nonce) return '确认已过期，请停止当前任务后重新核价。';
    if (!selected.value.result.quote?.today) return '官网尚未回传完整金额。';
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
    if (query.data.value?.configured === false) return '服务器执行器尚未配置。';
    if (uncertain.value) return '请求结果尚未确认，请刷新原任务状态；系统不会自动重发。';
    if (busy.value || pendingReceipt.value) return '正在提交任务，等待服务器回传状态。';
    if (selected.value?.state === 'awaiting_confirmation')
      return '资料已填入官网，请核对金额、套餐和续费信息后确认充值。';
    if (selected.value?.state === 'confirming') return '已确认本次付款，正在等待官网回传开通结果。';
    if (active.value)
      return selected.value?.action === 'quote'
        ? '正在核对账户并获取官方报价，你可以继续填写付款资料。'
        : '正在处理本次任务，请等待状态回传。';
    if (error.value || selected.value?.result.reason || selected.value?.state === 'unknown')
      return '本次流程已停止，请查看执行结果与处理说明。';
    if (!sessionJson.value) return '输入授权 JSON，然后选择需要开通的套餐。';
    if (!plan.value) return '请选择需要开通的套餐，系统将自动核对账户并获取报价。';
    if (!quoteReady.value) return '等待自动核对账户与套餐报价。';
    if (prepareAttempted.value) return '本次执行已结束，开通结果以官网回传为准。';
    if (!availableAddresses.value.length)
      return '没有可用的未使用地址，请先到地址管理导入或启用地址。';
    if (!selectedAddress.value) return '请从地址库选择一条未使用地址。';
    return '补齐付款资料并离开输入框后，系统会自动填入官网、重新核价。';
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
    if (action === 'prepare' && (!selectedAddress.value || !rechargeDetailsReady(details.value)))
      return;
    busy.value = true;
    error.value = '';
    const id = crypto.randomUUID();
    currentId.value = id;
    if (action === 'quote') {
      quoteId.value = id;
      quoteAttempted.value = true;
    }
    if (action === 'prepare') prepareAttempted.value = true;
    try {
      await rechargeApi.start({
        id,
        plan: plan.value,
        action,
        sessionJson: sessionJson.value,
        ...(action === 'prepare'
          ? { addressId: selectedAddress.value!.id, details: { ...details.value } }
          : {})
      });
      if (!disposed && action === 'recheck') uncertain.value = false;
    } catch (cause) {
      if (!disposed) {
        error.value = getApiErrorMessage(cause);
        uncertain.value = true;
      }
    } finally {
      if (!disposed) {
        if (action === 'prepare') clearCard();
        await refresh();
        busy.value = false;
      }
    }
  }
  function acceptSession() {
    importGeneration++;
    if (accountLocked.value || !jsonInput.value.trim()) return;
    jsonError.value = '';
    try {
      if (new TextEncoder().encode(jsonInput.value).length > 65000)
        throw new Error('JSON 不能超过 65 KB');
      const value = JSON.parse(jsonInput.value);
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('请输入完整的单账户 JSON');
      sessionJson.value = jsonInput.value;
      jsonInput.value = '';
    } catch {
      jsonError.value = '请提供有效的单账户 JSON（不超过 65 KB）';
    }
  }
  watch(
    [sessionJson, plan],
    () => {
      currentId.value = '';
      quoteId.value = '';
      quoteAttempted.value = false;
      prepareAttempted.value = false;
      error.value = '';
      confirmationSentFor.value = '';
    },
    { flush: 'sync' }
  );
  // 只串联本页创建的报价；每个草稿自动执行一次，失败、未知结果和付款绝不自动重试。
  watch(
    [
      sessionJson,
      plan,
      jsonInput,
      editingDetails,
      importing,
      accountLocked,
      quoteReady,
      () => query.phase.value,
      () => query.data.value?.configured,
      () => rechargeDetailsReady(details.value)
    ],
    () => {
      clearTimeout(timer);
      if (
        disposed ||
        importing.value ||
        accountLocked.value ||
        jsonInput.value.trim() ||
        !sessionJson.value ||
        !plan.value ||
        query.phase.value !== 'ready' ||
        !query.data.value?.configured
      )
        return;
      if (!quoteAttempted.value) timer = setTimeout(() => void execute('quote'), 500);
      else if (
        quoteReady.value &&
        !prepareAttempted.value &&
        !editingDetails.value &&
        Boolean(selectedAddress.value) &&
        rechargeDetailsReady(details.value)
      )
        timer = setTimeout(() => void execute('prepare'), 500);
    },
    { flush: 'post' }
  );
  const refreshedConsumedJobs = new Set<string>();
  watch(
    () => [selected.value?.id, selected.value?.result.status],
    async () => {
      const job = selected.value;
      if (
        !job ||
        job.result.status !== 'subscription_activated' ||
        refreshedConsumedJobs.has(job.id)
      )
        return;
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
    if (busy.value || !job || !['running', 'awaiting_confirmation'].includes(job.state)) return;
    busy.value = true;
    // 停止后不得因下一次读取而自动重新开始。
    quoteAttempted.value = true;
    prepareAttempted.value = true;
    try {
      await rechargeApi.cancel(job.id);
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
    if (quoteReady.value) {
      if (!rechargeDetailsReady(details.value)) {
        error.value = '请重新填写银行卡资料并选择未使用地址，再重试核价。';
        return;
      }
      await execute('prepare');
    } else await execute('quote');
  }
  async function recheckPayment() {
    if (!canRecheck.value) return;
    quoteAttempted.value = true;
    prepareAttempted.value = true;
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
    clearTimeout(timer);
    sessionJson.value = '';
    jsonInput.value = '';
    selectedAddressId.value = '';
    Object.keys(details.value).forEach((key) => {
      details.value[key as keyof V2RechargeDetails] = '';
    });
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
    editingDetails,
    accountLocked,
    billingLocked,
    canConfirm,
    confirmationBlockedReason,
    canRetry,
    canRecheck,
    recheckPayment,
    workflowMessage,
    acceptSession,
    confirmPayment,
    cancel,
    importJson,
    refresh,
    retryPreparation
  };
}
