import * as rules from '../modules/orders/order-opening.mjs';
export * from '../modules/orders/order-opening.mjs';

if (typeof window !== 'undefined') window.IDOrderOpening = Object.freeze({ ...rules });
