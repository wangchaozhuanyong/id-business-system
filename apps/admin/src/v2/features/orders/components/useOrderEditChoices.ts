import { computed, type Ref } from 'vue';
import type {
  V2Order,
  V2OrderCandidate,
  V2OrderEntryCustomer,
  V2OrderEntryOptions
} from '../contracts';
import { formatDecimal } from './order-edit-form';

export function useOrderEditChoices(
  options: Ref<V2OrderEntryOptions>,
  candidates: Ref<V2OrderCandidate[]>,
  getOrder: () => V2Order | null
) {
  const customerChoices = computed<V2OrderEntryCustomer[]>(() => {
    const order = getOrder();
    const current = order
      ? {
          id: order.customer.id,
          name: order.customer.name,
          wechat: null,
          maskedPhone: null
        }
      : null;
    return current && !options.value.customers.some((item) => item.id === current.id)
      ? [current, ...options.value.customers]
      : options.value.customers;
  });

  const serviceChoices = computed(() => {
    const items = options.value.countries.flatMap((country) =>
      country.children.flatMap((category) =>
        category.children.map((service) => ({
          id: service.id,
          label: `${country.name} / ${category.name} / ${service.name}`
        }))
      )
    );
    const order = getOrder();
    if (order && !items.some((item) => item.id === order.service.id)) {
      items.unshift({
        id: order.service.id,
        label: `${order.service.parent?.name || '原分类'} / ${order.service.name}`
      });
    }
    return items;
  });

  const settlementChoices = computed(() => {
    const items = [...options.value.settlementPlatforms];
    const order = getOrder();
    const current = order?.settlementPlatform;
    if (current && !items.some((item) => item.id === current.id)) {
      items.unshift({
        ...current,
        fixedFee: order?.platformFeeAmount ?? '0',
        percentageFee: '0'
      });
    }
    return items;
  });

  const accountChoices = computed(() => {
    const items = candidates.value.map((candidate) => ({
      id: candidate.id,
      label: `${candidate.appleIdMasked} / 余额 ${formatDecimal(candidate.currentBalance)}`
    }));
    const current = getOrder()?.account;
    if (current && !items.some((item) => item.id === current.id)) {
      items.unshift({
        id: current.id,
        label: `${current.appleIdMasked} / 当前使用`
      });
    }
    return items;
  });

  return {
    customerChoices,
    serviceChoices,
    settlementChoices,
    accountChoices
  };
}
