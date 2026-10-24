'use strict';

async function acquire(persistence, create) {
  const previous = persistence.previous;
  if (previous?.state === 'created') return { ...previous, creationState: 'accepted' };
  if (previous)
    throw Object.assign(new Error('原建单响应未确认，禁止再次建单'), {
      code: 'CHECKOUT_CREATION_UNKNOWN',
      checkoutCreationState: 'unknown'
    });
  // A committed intent fences a second POST even if the worker dies before its response.
  const intent = await persistence.save({ state: 'creating' });
  if (intent?.checkoutPreparationState !== 'creating')
    throw Object.assign(new Error('原单准备记录保存未确认，未发起建单'), {
      code: 'CHECKOUT_CREATION_UNKNOWN',
      checkoutCreationState: 'unknown'
    });
  const checkout = await create();
  if (checkout.checkoutUrl) {
    try {
      const receipt = await persistence.save({
        state: 'created',
        checkoutUrl: checkout.checkoutUrl,
        checkoutSource: checkout.checkoutSource
      });
      if (receipt?.checkoutPreparationState !== 'created')
        throw new Error('Unconfirmed checkpoint');
    } catch {
      throw Object.assign(new Error('原单已创建，但准备记录保存未确认，禁止再次建单'), {
        code: 'CHECKOUT_CREATION_UNKNOWN',
        checkoutCreationState: 'accepted'
      });
    }
  }
  return checkout;
}

module.exports = { acquire };
