'use strict';
function units(value) {
  if (typeof value !== 'string' || !/^\d{1,14}(?:\.\d{1,4})?$/.test(value))
    throw Object.assign(new Error('付款金额格式无效'), { code: 'PAYMENT_LIMIT' });
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 10000n + BigInt(fraction.padEnd(4, '0'));
}
function assertPaymentLimit(limit, due) {
  if (limit === undefined || limit === null) return;
  if (!limit || !/^[A-Z]{3}$/.test(limit.currency) || units(limit.maxAmount) <= 0n)
    throw Object.assign(new Error('付款上限格式无效，未提交付款'), { code: 'PAYMENT_LIMIT' });
  if (!due || due.currency !== limit.currency || units(due.amount) > units(limit.maxAmount))
    throw Object.assign(new Error('官网应付金额超过本次付款上限或币种不符，未提交付款'), {
      code: 'PAYMENT_LIMIT'
    });
}
module.exports = { assertPaymentLimit };
