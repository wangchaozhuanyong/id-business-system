import * as rules from '../modules/finance/apple-funding.mjs';
export * from '../modules/finance/apple-funding.mjs';

if (typeof window !== 'undefined') window.IDAppleFunding = Object.freeze({ ...rules });
