import { BadRequestException, ConflictException } from '@nestjs/common';
import type { IdBusinessV2RechargeJob } from '@prisma/client';
import {
  toV2JsonDocument,
  type V2CommandTransaction,
  type V2TransactionalAuditService
} from '../runtime/public-api';
import type { RechargeRepository } from './persistence/recharge.repository';
import type { RechargeAddressRepository } from './persistence/recharge-address.repository';
import { consumeRechargeAddress } from './recharge-address-consumption';
import { canReplaceCheckout } from './recharge-cancellation';
import { projectRechargePaymentRecord } from './recharge-payment-facts';
import { safeDocument, object } from './recharge-validation';
import { consumeNextCycleMarker } from './recharge-cycle-ledger';

export async function completeRechargeLedgerCallback(input: {
  tx: V2CommandTransaction;
  job: IdBusinessV2RechargeJob;
  callback: Record<string, unknown>;
  repository: RechargeRepository;
  addressRepository: RechargeAddressRepository;
  audit: V2TransactionalAuditService;
  factsOnly?: boolean;
}) {
  const { tx, job, callback, repository, addressRepository, audit } = input;
  if (
    !job.accountKey ||
    job.accountKey !== callback.accountKey ||
    typeof callback.fileKey !== 'string' ||
    !/^(?:payments\/)?[a-f0-9]{64}(?:-(?:go|pro-(?:5x|20x|500)))?\.json$/.test(callback.fileKey) ||
    !Number.isSafeInteger(callback.revision) ||
    Number(callback.revision) < 0
  )
    throw new BadRequestException('原订单记录无效');
  const document = safeDocument(callback.document);
  if (!input.factsOnly) {
    const consumed = await consumeNextCycleMarker({
      tx,
      job,
      callback,
      document,
      repository,
      audit
    });
    if (consumed) return consumed;
  }
  if (
    !input.factsOnly &&
    callback.fileKey.startsWith('payments/') &&
    !(
      (['prepare', 'flow', 'server'].includes(job.action) && job.state === 'confirming') ||
      (job.action === 'bitbrowser' &&
        ['running', 'awaiting_human_verification'].includes(job.state)) ||
      job.action === 'recheck'
    )
  )
    throw new ConflictException('尚未确认报价，不能记录或提交付款');
  const saved = await repository.saveRecord(tx, {
    accountKey: job.accountKey,
    ownerId: job.ownerId,
    fileKey: callback.fileKey,
    revision: Number(callback.revision),
    document,
    allowCheckoutReplacement: canReplaceCheckout(job),
    allowResolvedDeclineReplacement:
      !input.factsOnly &&
      job.action === 'bitbrowser' &&
      job.state === 'running' &&
      callback.fileKey === `${job.accountKey}${job.plan === 'plus' ? '' : `-${job.plan}`}.json` &&
      object(job.result).mode !== 'open_browser' &&
      object(job.result).recheck_only !== true &&
      object(job.result).resolution_only !== true &&
      object(job.result).payment_attempted !== true &&
      Number(object(job.result).payment_requests_sent ?? 0) === 0 &&
      Number(object(job.result).confirmation_requests_sent ?? 0) === 0
  });
  if (saved.replayed) return saved;
  const paymentResult = callback.fileKey.startsWith('payments/')
    ? projectRechargePaymentRecord(job, callback.fileKey, document)
    : null;
  if (paymentResult && !input.factsOnly) {
    await repository.updateJob(
      tx,
      job.id,
      { result: toV2JsonDocument(paymentResult) },
      input.factsOnly ? { factsOnly: true } : undefined
    );
  }
  await consumeRechargeAddress({
    tx,
    rechargeJobId: job.id,
    job,
    report: document,
    addressRepository,
    audit
  });
  await audit.append(tx, {
    userId: job.ownerId,
    module: 'id_business_v2',
    action: 'id_business_v2.auto_recharge.ledger',
    objectType: 'recharge_job',
    objectId: job.id,
    afterData: {
      fileKey: callback.fileKey,
      revision: saved.revision,
      stage: String(document.stage ?? 'unknown')
    },
    remark: '官网请求标记或原单核验结果已持久化'
  });
  return saved;
}
