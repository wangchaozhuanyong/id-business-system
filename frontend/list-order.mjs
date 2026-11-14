import * as rules from '../modules/orders/list-order.mjs';
import * as orders from '../modules/orders/order-list.mjs';
import * as inventory from '../modules/inventory/list.mjs';
export * from '../modules/orders/list-order.mjs';
export * from '../modules/orders/order-list.mjs';

if (typeof window !== 'undefined') {
  window.IDListOrder = Object.freeze({ ...rules, ...orders });
  window.IDInventoryList = Object.freeze({ ...inventory });
}
