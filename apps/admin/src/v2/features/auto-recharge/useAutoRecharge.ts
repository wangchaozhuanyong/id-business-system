import { computed, onBeforeUnmount, ref } from 'vue';
import { getApiErrorMessage } from '@/api/client';
import { useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { rechargeApi } from './api';
import type { V2RechargeAction, V2RechargeDetails, V2RechargePlan } from './contracts';

export function useAutoRecharge() {
  const jsonInput = ref('');
  const sessionJson = ref('');
  const plan = ref<V2RechargePlan>('plus');
  const selectedId = ref('');
  const busy = ref(false);
  const error = ref('');
  const confirmed = ref(false);
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
  const query = useV2ModuleQuery<{
    items: import('./contracts').V2RechargeJob[];
    configured: boolean;
  }>({
    moduleKey: 'auto-recharge',
    scope: 'auto-recharge',
    key: () => 'auto-recharge-jobs',
    keepPreviousData: true,
    getRevalidateAt: () => Date.now() + 2000,
    query: ({ signal }) => rechargeApi.list({ signal })
  });
  const jobs = computed(() => query.data.value?.items ?? []);
  const selected = computed(
    () => jobs.value.find((job) => job.id === selectedId.value) ?? jobs.value[0]
  );
  const active = computed(() =>
    jobs.value.some((job) => ['running', 'confirming', 'awaiting_confirmation'].includes(job.state))
  );
  const clearCard = () => {
    details.value.number = '';
    details.value.cvc = '';
    details.value.expiry = '';
  };
  async function execute(action: V2RechargeAction) {
    if (busy.value) return;
    error.value = '';
    confirmed.value = false;
    try {
      if (jsonInput.value.trim()) {
        const value = JSON.parse(jsonInput.value);
        if (!value || typeof value !== 'object' || Array.isArray(value))
          throw new Error('请输入完整的单账户 JSON');
        sessionJson.value = jsonInput.value;
        jsonInput.value = '';
      }
      if (!sessionJson.value) throw new Error('请先输入授权 JSON');
      if (
        action === 'prepare' &&
        [
          'number',
          'expiry',
          'cvc',
          'name',
          'email',
          'country',
          'line1',
          'city',
          'postal_code'
        ].some((key) => !details.value[key as keyof V2RechargeDetails].trim())
      ) {
        throw new Error('请补齐银行卡及真实账单资料');
      }
      busy.value = true;
      const id = crypto.randomUUID();
      selectedId.value = id;
      await rechargeApi.start({
        id,
        plan: plan.value,
        action,
        sessionJson: sessionJson.value,
        ...(action === 'prepare' ? { details: { ...details.value } } : {})
      });
    } catch (cause) {
      error.value = getApiErrorMessage(cause);
    } finally {
      busy.value = false;
      if (action === 'prepare') clearCard();
      await query.refresh();
    }
  }
  async function confirmPayment() {
    if (busy.value || !selected.value || !confirmed.value) return;
    const job = selected.value;
    if (!job.result.nonce || job.state !== 'awaiting_confirmation') return;
    busy.value = true;
    error.value = '';
    confirmed.value = false;
    try {
      await rechargeApi.confirm(job.id, job.result.nonce);
    } catch (cause) {
      error.value = getApiErrorMessage(cause);
    } finally {
      busy.value = false;
      await query.refresh();
    }
  }
  async function cancel() {
    if (busy.value || !selected.value) return;
    busy.value = true;
    try {
      await rechargeApi.cancel(selected.value.id);
    } catch (cause) {
      error.value = getApiErrorMessage(cause);
    } finally {
      busy.value = false;
      await query.refresh();
    }
  }
  async function importJson(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) {
      if (file.size > 65000) error.value = 'JSON 文件不能超过 65 KB';
      else jsonInput.value = await file.text();
    }
    input.value = '';
  }
  onBeforeUnmount(() => {
    sessionJson.value = '';
    jsonInput.value = '';
    clearCard();
  });
  return {
    query,
    jobs,
    selected,
    active,
    jsonInput,
    sessionJson,
    plan,
    selectedId,
    busy,
    error,
    confirmed,
    details,
    execute,
    confirmPayment,
    cancel,
    importJson,
    clearSession: () => {
      sessionJson.value = '';
      jsonInput.value = '';
      clearCard();
    }
  };
}
