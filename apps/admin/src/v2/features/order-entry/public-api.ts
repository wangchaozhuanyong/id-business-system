import { defineAsyncComponent } from 'vue';

export { default as V2CustomerRemoteSelect } from './components/V2CustomerRemoteSelect.vue';
export const V2QuickCustomerDrawer = defineAsyncComponent(
  () => import('./components/V2QuickCustomerDrawer.vue')
);
export { default as V2OrderProfitRateField } from './components/V2OrderProfitRateField.vue';
export * from './order-pricing';
export {
  getVisibleOrderEntryCustomers,
  preserveSelectedOrderEntryCustomer,
  useOrderEntryOptionsQuery
} from './useOrderEntryOptionsQuery';
export { useOrderPricingInputMode, type OrderPricingInputMode } from './useOrderPricingInputMode';
