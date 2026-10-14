import { computed, watch, type Ref } from 'vue';
import type { UseV2QueryResult, V2QueryPhase } from '@/v2/composables/useV2Query';
import type { RechargeProxyItem } from './recharge-proxy-api';
import { proxyCountryCurrencies, proxyCountryLabel } from './recharge-proxy-options';

interface ProxyRegionContext {
  currency: Ref<string>;
  country: Ref<string>;
  proxyId: Ref<string>;
  defaultCountry: Ref<string>;
  manualSelection: Ref<boolean>;
  currencies: Ref<{ value: string; label: string }[]>;
  countries: Ref<string[]>;
  locked: Ref<boolean>;
  query: Pick<
    UseV2QueryResult<{ items: RechargeProxyItem[]; total: number }>,
    'data' | 'error' | 'ensureFresh'
  > & {
    phase: Readonly<Ref<V2QueryPhase>>;
    isParameterTransition: Readonly<Ref<boolean>>;
  };
}

export function useRechargeProxyRegion(context: ProxyRegionContext) {
  let synchronizing = false;
  const currencyEnabled = (code: string) =>
    context.currencies.value.some((item) => item.value === code);
  function fromCountry() {
    const currency = proxyCountryCurrencies[context.country.value];
    if (currency && currencyEnabled(currency)) context.currency.value = currency;
  }
  function fromCurrency() {
    const matches = (code: string) => proxyCountryCurrencies[code] === context.currency.value;
    if (context.country.value && matches(context.country.value)) return;
    context.country.value =
      [
        context.defaultCountry.value,
        ...context.countries.value,
        ...Object.keys(proxyCountryCurrencies)
      ].find(matches) ?? '';
  }
  if (!context.defaultCountry.value) context.defaultCountry.value = 'PH';
  if (context.country.value) fromCountry();
  else fromCurrency();

  watch(
    context.country,
    () => {
      context.proxyId.value = '';
      context.manualSelection.value = false;
      if (!synchronizing) {
        synchronizing = true;
        try {
          fromCountry();
        } finally {
          synchronizing = false;
        }
      }
      void context.query.ensureFresh().catch(() => {
        /* 错误由查询区域展示。 */
      });
    },
    { flush: 'sync' }
  );
  watch(
    context.currency,
    () => {
      if (synchronizing) return;
      synchronizing = true;
      try {
        fromCurrency();
      } finally {
        synchronizing = false;
      }
    },
    { flush: 'sync' }
  );
  watch(
    context.defaultCountry,
    (code) => {
      context.country.value = code;
    },
    { flush: 'sync' }
  );
  watch(
    context.currencies,
    () => {
      if (context.locked.value) return;
      synchronizing = true;
      try {
        fromCountry();
      } finally {
        synchronizing = false;
      }
    },
    { deep: true }
  );

  const countries = computed(() => {
    const items = new Set(
      [context.defaultCountry.value, context.country.value, ...context.countries.value].filter(
        Boolean
      )
    );
    return [...items].sort(
      (a, b) =>
        Number(b === context.defaultCountry.value) - Number(a === context.defaultCountry.value) ||
        proxyCountryLabel(a).localeCompare(proxyCountryLabel(b), 'zh-Hans')
    );
  });
  const defaultCountries = computed(() =>
    Object.keys(proxyCountryCurrencies)
      .filter(
        (code) =>
          code === context.defaultCountry.value || currencyEnabled(proxyCountryCurrencies[code])
      )
      .sort(
        (a, b) =>
          Number(b === 'PH') - Number(a === 'PH') ||
          proxyCountryLabel(a).localeCompare(proxyCountryLabel(b), 'zh-Hans')
      )
  );
  const proxies = computed(() =>
    (context.query.data.value?.items ?? []).filter(
      (item) => item.countryCode === context.country.value && item.status === 'active'
    )
  );
  const countryCurrencyError = computed(() => {
    const currency = proxyCountryCurrencies[context.country.value];
    if (!currency) return '所选币种或国家暂无对应关系，请选择支持的国家和币种。';
    if (!currencyEnabled(currency))
      return '所选国家对应的币种尚未启用，请先启用币种或选择其他国家。';
    return currency === context.currency.value ? '' : '代理国家与锁定币种不一致，请重新选择。';
  });
  const currentDataReady = computed(
    () =>
      context.query.phase.value === 'ready' &&
      !context.query.error.value &&
      !context.query.isParameterTransition.value
  );
  watch(
    [proxies, currentDataReady, context.locked, countryCurrencyError],
    () => {
      if (context.locked.value || !currentDataReady.value || countryCurrencyError.value) return;
      const current = proxies.value.find((item) => item.id === context.proxyId.value);
      if (current && context.manualSelection.value) return;
      const preferred =
        (current?.kind === 'mobile' ? current : undefined) ??
        proxies.value.find((item) => item.kind === 'mobile') ??
        current ??
        proxies.value[0];
      context.proxyId.value = preferred?.id ?? '';
    },
    { immediate: true, flush: 'sync' }
  );
  const note = computed(() => {
    if (!currentDataReady.value || countryCurrencyError.value) return '';
    if (!proxies.value.length) return '所选国家暂无启用代理，请在代理 IP 管理中添加或启用。';
    if (!proxies.value.some((item) => item.kind === 'mobile'))
      return '该国家暂无启用的移动代理，已选择其他启用代理。';
    return '';
  });
  return {
    countries,
    defaultCountries,
    proxies,
    countryCurrencyError,
    note,
    markManual: () => {
      context.manualSelection.value = true;
    }
  };
}
