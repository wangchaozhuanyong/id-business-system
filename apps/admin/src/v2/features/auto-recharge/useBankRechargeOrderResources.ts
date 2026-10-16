import { computed, ref, watch } from 'vue';
import { useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { bankRechargeApi, type RechargeOrderChannel } from './bank-recharge-api';
import type { emptyForm } from './bank-recharge-order-form';
export function useBankRechargeOrderResources(
  channel: RechargeOrderChannel,
  form: ReturnType<typeof emptyForm>,
  selectedCardId: () => string | null | undefined = () => null
) {
  const optionsQuery = useV2ModuleQuery({
    moduleKey: 'bank-recharge-orders',
    scope: 'auto-recharge',
    key: `recharge-orders:${channel}:options`,
    query: ({ signal }) => bankRechargeApi.orderOptions({ signal }, channel)
  });
  const accountsQuery = useV2ModuleQuery({
    moduleKey: 'chatgpt-accounts',
    scope: 'auto-recharge',
    key: 'bank-recharge-account-options',
    query: ({ signal }) => bankRechargeApi.listAccounts({ signal })
  });
  const bitCardsQuery = useV2ModuleQuery({
    moduleKey: 'bank-recharge-orders',
    scope: 'auto-recharge',
    enabled: () => channel === 'bitbrowser',
    key: 'bank-recharge-card-options',
    query: ({ signal }) => bankRechargeApi.listCards({ signal })
  });
  const cardsQuery = channel === 'online' ? optionsQuery : bitCardsQuery;
  const currenciesQuery = useV2ModuleQuery({
    moduleKey: 'bank-recharge-orders',
    scope: 'auto-recharge',
    key: 'bank-recharge-currency-options',
    query: ({ signal }) => bankRechargeApi.listCurrencies({ signal })
  });
  const customers = ref<Array<{ id: string; name: string }>>([]);
  watch(
    () => optionsQuery.data.value?.customers,
    (items) => {
      if (!items) return;
      const selectedCustomer = customers.value.find((item) => item.id === form.customerId);
      customers.value = [...items];
      if (selectedCustomer && !items.some((item) => item.id === selectedCustomer.id)) {
        customers.value.unshift(selectedCustomer);
      }
    }
  );
  const accounts = computed(() =>
    (accountsQuery.data.value?.items ?? []).filter((item) => item.status === 'active')
  );
  const activeCurrencies = computed(() =>
    (currenciesQuery.data.value?.items ?? []).filter((item) => item.active)
  );
  const availableCards = computed(() =>
    (channel === 'online'
      ? (optionsQuery.data.value?.cards ?? [])
      : (bitCardsQuery.data.value?.items ?? [])
    ).filter((item) => item.active && (item.status !== 'exhausted' || item.id === selectedCardId()))
  );
  const fundingAccounts = computed(() =>
    (optionsQuery.data.value?.financeAccounts ?? []).filter((item) => item.currency === 'CNY')
  );
  const receivedAccounts = computed(() =>
    (optionsQuery.data.value?.financeAccounts ?? []).filter(
      (item) => item.currency === form.receivedCurrencyCode
    )
  );
  const feeAccounts = computed(() => optionsQuery.data.value?.financeAccounts ?? []);
  return {
    optionsQuery,
    accountsQuery,
    cardsQuery,
    currenciesQuery,
    customers,
    accounts,
    activeCurrencies,
    availableCards,
    fundingAccounts,
    receivedAccounts,
    feeAccounts
  };
}
