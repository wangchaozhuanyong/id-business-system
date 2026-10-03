import { reactive, ref, watch, onScopeDispose } from 'vue';
import { getApiErrorMessage } from '@/api/client';
import { createV2QueryKey, useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { useV2SessionDraft } from '@/v2/composables/useV2SessionDraft';
import { registrationApi } from './api';
import type { V2RegistrationMailbox } from './contracts';

export function useRegistrationMailboxes(enabled: () => boolean) {
  const filters = useV2SessionDraft('auto-registration:mailboxes', () =>
    reactive({ page: 1, pageSize: 20, keyword: '', appliedKeyword: '' })
  );
  const query = useV2ModuleQuery({
    moduleKey: 'auto-registration',
    scope: 'auto-recharge',
    enabled,
    key: () =>
      createV2QueryKey({
        mailboxes: true,
        page: filters.page,
        pageSize: filters.pageSize,
        keyword: filters.appliedKeyword
      }),
    keepPreviousData: true,
    query: ({ signal }) =>
      registrationApi.mailboxes(
        { page: filters.page, pageSize: filters.pageSize, keyword: filters.appliedKeyword },
        { signal }
      )
  });
  watch(
    () => [filters.page, filters.pageSize, filters.appliedKeyword],
    () => {
      if (enabled()) void query.ensureFresh();
    }
  );
  watch(
    () => filters.pageSize,
    () => {
      filters.page = 1;
    }
  );
  const target = useV2SessionDraft('auto-registration:registered-target', () =>
    ref<V2RegistrationMailbox | null>(null)
  );
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
    filters.page = 1;
    filters.appliedKeyword = filters.keyword.trim();
    void query.ensureFresh();
  }
  function changePage(value: number) {
    filters.page = value;
  }
  function changePageSize(value: number) {
    filters.pageSize = value;
    filters.page = 1;
  }
  function openMark(row: V2RegistrationMailbox) {
    if (busy.value) return;
    target.value = { ...row };
    error.value = '';
    confirmOpen.value = true;
  }
  async function confirm() {
    if (busy.value || !target.value) return;
    const aliasId = target.value.id;
    const expectedUpdatedAt = target.value.updatedAt;
    const registered = !target.value.registered;
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
      message.value = !registered
        ? '已标记未注册，已有账号资料保留'
        : result.created
          ? '已标记已注册，已加入 ChatGPT 账号'
          : '已标记已注册，已复用现有 ChatGPT 账号';
      try {
        await query.refresh();
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
    filters,
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
