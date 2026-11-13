import * as rules from '../modules/orders/list-order.mjs';
export * from '../modules/orders/list-order.mjs';

if (typeof window !== 'undefined') window.IDListOrder = Object.freeze({ ...rules });
