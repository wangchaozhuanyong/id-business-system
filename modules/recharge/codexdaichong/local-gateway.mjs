import { createCodexdaichongGateway } from './gateway.mjs';

/**
 * Mount on the same origin as the local staff session. The host supplies its
 * live actor resolver so every request rechecks the current account.
 */
export function createLocalCodexdaichongGateway({ upstreamUrl, publicOrigin, secret, getActor, assets,
  legacyNotificationLocked, onRechargeOutcome, beforeCardDelete }) {
  if (typeof getActor !== 'function') {
    throw new TypeError('本机线上代充需要统一员工会话');
  }
  return createCodexdaichongGateway({
    upstreamUrl,
    publicOrigin,
    secret,
    assets,
    legacyNotificationLocked,
    onRechargeOutcome,
    beforeCardDelete,
    async getUnifiedPrincipal(request) {
      const actor = await getActor(request);
      if (!actor || actor.active !== true || !['admin', 'super'].includes(actor.role)) {
        return null;
      }
      return {
        id: actor.id,
        email: actor.email,
        admin: true,
        sensitive: actor.role === 'super'
      };
    }
  });
}
