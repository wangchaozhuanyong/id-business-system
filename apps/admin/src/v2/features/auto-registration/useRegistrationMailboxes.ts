import { reactive, ref, watch, onScopeDispose } from 'vue';
import { getApiErrorMessage } from '@/api/client';
import { createV2QueryKey, useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { useV2FormDraft, useV2SessionDraft } from '@/v2/composables/useV2SessionDraft';
import { registrationApi } from './api';
import { chatgptCountries } from '@/v2/features/auto-recharge/public-api';
import type { V2RegistrationMailbox, V2RegistrationMailboxStatusFilter } from './contracts';

export function useRegistrationMailboxes(
  enabled: () => boolean,
  status: () => V2RegistrationMailboxStatusFilter = () => 'all'
) {
  const initialFilters = () => ({ page: 1, pageSize: 20, keyword: '', appliedKeyword: '' });
  const views = useV2SessionDraft('auto-registration:mailbox-views', () =>
    reactive({
      all: initialFilters(),
      unregistered: initialFilters(),
      registered: initialFilters()
    })
  );
  const currentFilters = () => views[status()];
  const selected = useV2SessionDraft('auto-registration:mailbox-selection', () =>
    ref<V2RegistrationMailbox | null>(null)
  );
  const query = useV2ModuleQuery({
    moduleKey: 'auto-registration',
    scope: 'auto-recharge',
    enabled,
    key: () =>
      createV2QueryKey({
        mailboxes: true,
        registrationStatus: status(),
        page: currentFilters().page,
        pageSize: currentFilters().pageSize,
        keyword: currentFilters().appliedKeyword
      }),
    keepPreviousData: true,
    query: ({ signal }) =>
      registrationApi.mailboxes(
        {
          page: currentFilters().page,
          pageSize: currentFilters().pageSize,
          keyword: currentFilters().appliedKeyword,
          registrationStatus: status()
        },
        { signal }
      )
  });
  watch(
    () => [
      status(),
      currentFilters().page,
      currentFilters().pageSize,
      currentFilters().appliedKeyword
    ],
    () => {
      if (enabled()) void query.ensureFresh();
    }
  );
  const target = useV2SessionDraft('auto-registration:registered-target', () =>
    ref<V2RegistrationMailbox | null>(null)
  );
  const desiredRegistered = useV2SessionDraft('auto-registration:registered-value', () =>
    ref(false)
  );
  watch(
    () => query.data.value,
    (data) => {
      const updated = data?.items.find((row) => row.id === selected.value?.id);
      if (updated) selected.value = { ...updated };
    }
  );
  const countryDraft = useV2FormDraft('auto-registration:mailbox-country', () => ({
    registrationCountryCode: ''
  }));
  const countryTarget = useV2SessionDraft('auto-registration:mailbox-country-target', () =>
    ref<V2RegistrationMailbox | null>(null)
  );
  const countryOpen = ref(false);
  const countryError = ref('');
  const confirmOpen = ref(false);
  const busy = ref(false);
  const error = ref('');
  const message = ref('');
  function setConfirmOpen(value: boolean) {
    if (!busy.value) confirmOpen.value = value;
  }
  let disposed = false;
  onScopeDispose(() => {
    disposed = true;
  });
  function search() {
    const changed =
      currentFilters().page !== 1 ||
      currentFilters().appliedKeyword !== currentFilters().keyword.trim();
    currentFilters().page = 1;
    currentFilters().appliedKeyword = currentFilters().keyword.trim();
    if (changed) void query.ensureFresh();
    else void query.refresh();
  }
  function changePage(value: number) {
    currentFilters().page = value;
  }
  function changePageSize(value: number) {
    currentFilters().pageSize = value;
    currentFilters().page = 1;
  }
  function select(row: V2RegistrationMailbox) {
    if (!busy.value && row.canStart) selected.value = { ...row };
  }
  function openMark(row: V2RegistrationMailbox, value: unknown = !row.registered) {
    if (busy.value || typeof value !== 'boolean' || value === row.registered) return;
    target.value = { ...row };
    desiredRegistered.value = value;
    error.value = '';
    confirmOpen.value = true;
  }
  function setCountryOpen(value: boolean) {
    if (!busy.value) countryOpen.value = value;
  }
  function setCountry(value: string) {
    if (!busy.value) countryDraft.form.registrationCountryCode = value;
  }
  function openCountry(row: V2RegistrationMailbox) {
    if (busy.value || !row.registered || !row.accountId || !row.accountUpdatedAt) return;
    countryTarget.value = { ...row };
    countryDraft.open(
      row.accountId,
      { registrationCountryCode: row.registrationCountryCode ?? '' },
      row.accountUpdatedAt
    );
    countryError.value = '';
    countryOpen.value = true;
  }
  async function saveCountry() {
    if (busy.value || !countryTarget.value?.accountId || !countryDraft.version.value) return;
    const country = countryDraft.form.registrationCountryCode;
    if (country && !chatgptCountries.some(([code]) => code === country)) {
      countryError.value = '请选择有效的国家';
      return;
    }
    const accountId = countryTarget.value.accountId;
    const completeSave = countryDraft.beginSave();
    busy.value = true;
    countryError.value = '';
    message.value = '';
    try {
      await registrationApi.updateCountry(accountId, country || null, countryDraft.version.value);
      completeSave();
      if (disposed) return;
      countryOpen.value = false;
      message.value = '国家已修改';
      try {
        await query.refresh();
      } catch {
        if (!disposed) message.value += '；列表刷新失败，请重试读取列表';
      }
    } catch (cause) {
      if (!disposed) countryError.value = getApiErrorMessage(cause);
    } finally {
      busy.value = false;
    }
  }
  async function confirm() {
    if (busy.value || !target.value) return;
    const aliasId = target.value.id;
    const expectedUpdatedAt = target.value.updatedAt;
    const registered = desiredRegistered.value;
    const expectedAccountUpdatedAt = target.value.accountUpdatedAt;
    busy.value = true;
    error.value = '';
    message.value = '';
    try {
      const result = await registrationApi.markRegistered(
        aliasId,
        expectedUpdatedAt,
        registered,
        expectedAccountUpdatedAt
      );
      if (disposed) return;
      confirmOpen.value = false;
      if (selected.value?.id === aliasId) selected.value = null;
      message.value = !registered
        ? '已标记未注册，已有账号资料保留'
        : result.created
          ? '已标记已注册，已加入 ChatGPT 账号'
          : '已标记已注册，已复用现有 ChatGPT 账号';
      try {
        await query.refresh();
        if (disposed) return;
        const lastPage = Math.max(
          1,
          Math.ceil((query.data.value?.total ?? 0) / currentFilters().pageSize)
        );
        if (currentFilters().page > lastPage) currentFilters().page = lastPage;
      } catch {
        if (!disposed) message.value += '；列表刷新失败，请重试读取列表';
      }
    } catch (cause) {
      if (!disposed) error.value = getApiErrorMessage(cause);
    } finally {
      busy.value = false;
    }
  }
  return {
    get filters() {
      return currentFilters();
    },
    selected,
    select,
    countryDraft,
    countryTarget,
    countryOpen,
    countryError,
    setCountryOpen,
    setCountry,
    openCountry,
    saveCountry,
    desiredRegistered,
    query,
    target,
    confirmOpen,
    setConfirmOpen,
    busy,
    error,
    message,
    search,
    changePage,
    changePageSize,
    openMark,
    confirm
  };
}
