import { computed, reactive, watch } from 'vue';
import { createV2QueryKey, useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { useV2SessionDraft } from '@/v2/composables/useV2SessionDraft';
import { registrationApi, type RegistrationOptions } from './api';

export function useRegistrationOptions(enabled: () => boolean) {
  const optionFilters = useV2SessionDraft('auto-registration:option-filters', () =>
    reactive({ proxySearch: '', proxyPage: 1, nameSearch: '', namePage: 1 })
  );
  const savedLabels = useV2SessionDraft('auto-registration:option-labels', () => ({
    proxies: new Map<string, RegistrationOptions['proxies'][number]>(),
    names: new Map<string, RegistrationOptions['names'][number]>()
  }));
  const options = useV2ModuleQuery({
    moduleKey: 'auto-registration',
    scope: 'auto-recharge',
    enabled,
    key: () => createV2QueryKey({ options: true, ...optionFilters }),
    keepPreviousData: true,
    query: ({ signal }) => registrationApi.options({ ...optionFilters }, { signal })
  });
  watch(
    () => [
      optionFilters.proxySearch,
      optionFilters.proxyPage,
      optionFilters.nameSearch,
      optionFilters.namePage
    ],
    () => {
      if (enabled()) void options.ensureFresh();
    }
  );
  watch(
    () => options.data.value,
    (value) => {
      for (const row of value?.proxies ?? []) savedLabels.proxies.set(row.id, row);
      for (const row of value?.names ?? []) savedLabels.names.set(row.id, row);
    },
    { immediate: true }
  );
  function searchProxyOptions(keyword: string) {
    optionFilters.proxySearch = keyword.trim();
    optionFilters.proxyPage = 1;
  }
  function searchNameOptions(keyword: string) {
    optionFilters.nameSearch = keyword.trim();
    optionFilters.namePage = 1;
  }
  function changeProxyPage(value: number) {
    optionFilters.proxyPage = value;
  }
  function changeNamePage(value: number) {
    optionFilters.namePage = value;
  }
  function proxyChoices(selectedId: string) {
    const rows = [...(options.data.value?.proxies ?? [])];
    if (selectedId && !rows.some((row) => row.id === selectedId)) {
      const saved = savedLabels.proxies.get(selectedId);
      if (saved) rows.unshift(saved);
      else rows.unshift({ id: selectedId, label: '已保存的代理，请核对目录状态', countryCode: '' });
    }
    return rows;
  }
  function nameChoices(selectedId: string) {
    const rows = [...(options.data.value?.names ?? [])];
    const saved = savedLabels.names.get(selectedId);
    if (selectedId && !rows.some((row) => row.id === selectedId)) {
      rows.unshift(saved ?? { id: selectedId, displayName: '已保存的名字，请核对名字数据表' });
    }
    return rows;
  }
  return {
    options,
    optionFilters,
    searchProxyOptions,
    searchNameOptions,
    changeProxyPage,
    changeNamePage,
    proxyChoices,
    nameChoices,
    proxyPageCount: computed(() =>
      Math.max(1, Math.ceil((options.data.value?.proxyTotal ?? 0) / 100))
    ),
    namePageCount: computed(() =>
      Math.max(1, Math.ceil((options.data.value?.nameTotal ?? 0) / 100))
    )
  };
}
