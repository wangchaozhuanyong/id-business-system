import { defineAsyncComponent } from 'vue';
export * from './api';
export * from './options';
export const V2RechargeProxyDetailDrawer = defineAsyncComponent(
  () => import('./V2RechargeProxyDetailDrawer.vue')
);
export const V2ProxyPoolView = defineAsyncComponent(() => import('./V2ProxyPoolView.vue'));
export { rechargeProxiesFeature } from './manifest';
