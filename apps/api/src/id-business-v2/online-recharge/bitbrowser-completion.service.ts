import { Injectable } from '@nestjs/common';
import type { OnlineRechargeBitbrowserDevice } from '@prisma/client';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { OnlineRechargeRepository } from './persistence/online-recharge.repository';
import { OnlineRechargeWorkerRepository } from './persistence/worker.repository';
import { OnlineBitbrowserPaymentRepository } from './persistence/bitbrowser-payment.repository';
import { OnlineRechargeEphemeralCredentials } from './ephemeral-credentials.service';
import type { OnlineRechargeWorkerRpc } from './contracts';
import { object, sessionAccountId } from './validation';
import { BITBROWSER_PLAN } from './bitbrowser-policy';

@Injectable()
export class OnlineBitbrowserCompletionService {
  constructor(
    private readonly repository: OnlineRechargeRepository,
    private readonly workers: OnlineRechargeWorkerRepository,
    private readonly payments: OnlineBitbrowserPaymentRepository,
    private readonly encryption: FieldEncryptionService,
    private readonly credentials: OnlineRechargeEphemeralCredentials
  ) {}
  async finish(rpc: OnlineRechargeWorkerRpc, device: OnlineRechargeBitbrowserDevice) {
    const inspected = await this.workers.withLease(rpc, async (tx, row) => {
      const state = await this.payments.owned(tx, row, device);
      const records = state.ledgerEncrypted
        ? object(JSON.parse(this.encryption.decrypt(state.ledgerEncrypted)!))
        : {};
      const quote = object(state.quote ?? {}),
        today = object(quote.today ?? {});
      const paidRecord = Object.values(records)
        .map((value) => object(object(value).document))
        .find((record) => {
          const evidence = object(record.payment_evidence ?? {});
          const evidenceBound =
            record.operation === 'subscription_upgrade'
              ? (evidence.kind === 'invoice' &&
                  /^in_[A-Za-z0-9]+$/.test(String(evidence.identifier)) &&
                  evidence.identifier === record.upgrade_invoice_identifier) ||
                (evidence.kind === 'payment_intent' &&
                  /^pi_[A-Za-z0-9]+$/.test(String(evidence.identifier)) &&
                  evidence.identifier === record.upgrade_payment_intent_identifier)
              : (evidence.kind === 'checkout_session' &&
                  /^(?:cs|oaics)_[A-Za-z0-9_]{1,200}$/.test(String(evidence.identifier)) &&
                  evidence.identifier === record.checkout_identifier) ||
                (evidence.kind === 'payment_intent' &&
                  /^pi_[A-Za-z0-9]{1,180}$/.test(String(evidence.identifier)));
          return (
            state.paymentConsumed &&
            record.payment_status === 'paid' &&
            record.account_key === state.accountKey &&
            record.target_plan === BITBROWSER_PLAN[row.plan] &&
            record.quote_digest === state.quoteDigest &&
            evidence.currency === today.currency &&
            evidence.amount_minor === today.amount_minor &&
            evidenceBound
          );
        });
      return { row, state, today, paidRecord };
    });
    const { row, state, today, paidRecord } = inspected;
    const observed = object(rpc.args?.result ?? {});
    const tier = row.plan === 'pro_5x' ? 5 : row.plan === 'pro_20x' ? 20 : null;
    const matched =
      observed.account_matched === true &&
      (row.plan === 'plus'
        ? observed.current_plan === 'plus'
        : observed.current_plan === 'pro' && observed.current_tier === tier);
    const paid = Boolean(paidRecord);
    const verified = paid && matched && observed.status === 'subscription_activated';
    const accountId = sessionAccountId(this.encryption.decrypt(row.sessionEncrypted));
    const definitiveFailure =
      !row.paymentStarted || (!paid && observed.payment_status === 'declined');
    const status = verified
      ? 'succeeded'
      : row.paymentStarted || paid
        ? definitiveFailure
          ? 'failed'
          : 'awaiting_review'
        : 'failed';
    const result = {
      confirmedPaid: paid,
      confirmation: {
        source: 'subscription',
        querySucceeded: matched,
        targetPlan: row.plan,
        accountId,
        expectedAccountId: accountId,
        verified,
        hasActiveSubscription: matched,
        observedPlan: row.plan
      },
      outcome:
        typeof observed.reason === 'string' && /^[a-z0-9_]{1,100}$/.test(observed.reason)
          ? observed.reason
          : null,
      paymentStatus: paid ? 'paid' : row.paymentStarted ? 'unknown' : 'not_attempted'
    };
    if (paid && row.cardId) {
      const addressId = object(row.payload).bitBrowserAddressId;
      if (typeof addressId === 'string')
        await this.workers.markAddress({ ...rpc, args: { cardId: row.cardId, addressId } });
      await this.workers.cardAction(
        { ...rpc, args: { cardId: row.cardId, confirmed: true } },
        'recordCardUsage'
      );
      await this.workers.billing({
        ...rpc,
        args: {
          status: verified ? 'success' : 'result_unknown',
          amount: today.amount,
          currency: today.currency,
          amountSource: 'checkout',
          checkoutId:
            paidRecord?.checkout_identifier ??
            paidRecord?.upgrade_invoice_identifier ??
            paidRecord?.upgrade_payment_intent_identifier
        }
      });
    } else if (row.paymentStarted && observed.payment_status === 'declined' && row.cardId) {
      await this.workers.cardAction({ ...rpc, args: { cardId: row.cardId } }, 'recordCardDecline');
    }
    const finished = await this.workers.finish(
      {
        ...rpc,
        args: {
          status,
          result,
          confirmedPaid: paid,
          definitiveFailure,
          message: verified
            ? '比特充值成功，账号和套餐已确认'
            : status === 'awaiting_review'
              ? '付款结果待核对，禁止自动再次付款'
              : '本次比特充值未完成，请核对任务详情'
        }
      },
      status !== 'succeeded'
    );
    if (row.cardId) await this.credentials.releaseCvc(row.cardId, row.id);
    return { ...finished, deviceId: state.deviceId };
  }
}
