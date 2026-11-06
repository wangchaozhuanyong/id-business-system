import { BadRequestException, ConflictException } from '@nestjs/common';
import type { IdBusinessV2RechargeJob } from '@prisma/client';
import {
  toV2JsonDocument,
  type V2CommandTransaction,
  type V2TransactionalAuditService
} from '../runtime/public-api';
import type { RechargeRepository } from './persistence/recharge.repository';
import { rechargeDocumentDigest } from './recharge-callback-receipts';
import { isClosedCycleDocument } from './recharge-cycle-state';
import { rechargeCheckoutIdentifier } from './recharge-job-helpers';
import { resolvedDeclinedPayment } from './recharge-noncharge-proof';
import { object } from './recharge-validation';

const privateKey = '_expired_checkout_replacement_v1';
const bindingKey = '_checkout_replacement_binding_v1';
const currentCheckoutKeys = [
  'checkout_identifier',
  'processor_entity',
  'checkout_status',
  'checkout_recovered_from_original',
  'checkout_link_available',
  'quote',
  'quote_digest',
  'quote_authority',
  'initial_quote',
  'billing_fingerprint',
  'final_quote_verified',
  'quote_stage',
  'confirmation_expires_at',
  'nonce',
  'payment_intent_identifier',
  '_direct_confirmation_v1'
];
const proofKeys = [
  'checkout_identifier',
  'processor_entity',
  'target_plan',
  'account_key',
  'status',
  'payment_status'
];

export function expiredCheckoutProof(value: unknown) {
  const proof = object(value);
  if (
    Object.keys(proof).some((key) => !proofKeys.includes(key)) ||
    typeof proof.checkout_identifier !== 'string' ||
    !/^(?:oaics_[A-Za-z0-9_]{1,200}|cs_[A-Za-z0-9_]{1,180})$/.test(proof.checkout_identifier) ||
    typeof proof.processor_entity !== 'string' ||
    !/^[a-z][a-z0-9_]{0,40}$/.test(proof.processor_entity) ||
    typeof proof.target_plan !== 'string' ||
    typeof proof.account_key !== 'string' ||
    !/^[a-f0-9]{64}$/.test(proof.account_key) ||
    proof.status !== 'expired' ||
    proof.payment_status !== 'unpaid'
  )
    throw new BadRequestException('官网过期未付款结算证明无效');
  return Object.fromEntries(proofKeys.map((key) => [key, proof[key]]));
}

function noPayment(value: unknown) {
  const result = object(value);
  return (
    (result.payment_attempted === undefined || result.payment_attempted === false) &&
    [
      'payment_requests_sent',
      'confirmation_requests_sent',
      'card_tokenization_requests_sent'
    ].every((key) => result[key] === undefined || result[key] === 0) &&
    !result.manual_confirmation_accepted &&
    !result.payment_evidence &&
    !result.payment_record_write_failed &&
    result.status !== 'payment_result_unknown' &&
    [undefined, 'not_attempted', 'unpaid'].includes(result.payment_status as never)
  );
}

function replacementBindingResult(
  previous: Record<string, unknown>,
  document: Record<string, unknown>,
  retiredIdentifier: string,
  revision: number,
  markerDigest: string
): Record<string, unknown> {
  if (
    !noPayment(previous) ||
    !noPayment(document) ||
    document.status !== 'checkout_attempted' ||
    document.stage !== 'checkout_create' ||
    document.checkout_identifier !== undefined ||
    !/^(?:cs|oaics)_[A-Za-z0-9_]{1,200}$/.test(retiredIdentifier) ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    !/^[a-f0-9]{64}$/.test(markerDigest)
  )
    throw new ConflictException('仅允许在零付款替换账本落盘后重置当前结算绑定');
  const result = { ...previous };
  for (const key of currentCheckoutKeys) delete result[key];
  return {
    ...result,
    [bindingKey]: {
      retiredIdentifier,
      markerRevision: revision,
      markerDigest
    }
  };
}

/** 私有指针只由账本事务写入；未接受新建账本前不允许恢复旧单或旧报价。 */
export function assertReplacementCheckoutReport(
  job: IdBusinessV2RechargeJob,
  report: Record<string, unknown>,
  createdLedger = false,
  paymentControlled = false,
  ledgerReport = false
) {
  const previous = object(job.result);
  if (!previous[bindingKey]) return;
  if (
    report.recheck_only === true ||
    report.resolution_only === true ||
    (report.transport !== undefined &&
      report.transport !== 'web_direct' &&
      !(ledgerReport && report.transport === 'official_browser'))
  )
    throw new ConflictException('替换结算任务的执行用途和传输方式不可由回执变更');
  if (paymentControlled) return;
  const binding = object(previous[bindingKey]);
  const identifier = previous.checkout_identifier;
  if (identifier === undefined) {
    if (!createdLedger && currentCheckoutKeys.some((key) => report[key] !== undefined))
      throw new ConflictException('新结算尚未落盘，旧订单或报价不能重新成为当前绑定');
    if (createdLedger && report.checkout_identifier === binding.retiredIdentifier)
      throw new ConflictException('已替换的旧订单不能作为新结算写回');
  } else if (
    identifier === binding.retiredIdentifier ||
    (report.checkout_identifier !== undefined && report.checkout_identifier !== identifier) ||
    (report.processor_entity !== undefined &&
      report.processor_entity !== previous.processor_entity) ||
    (currentCheckoutKeys
      .filter((key) => !['checkout_identifier', 'processor_entity'].includes(key))
      .some((key) => report[key] !== undefined) &&
      report.checkout_identifier !== identifier)
  )
    throw new ConflictException('回执未绑定已经落盘的新结算，不能恢复旧订单或报价');
}

export async function resetResolvedCheckoutBinding(input: {
  tx: V2CommandTransaction;
  job: IdBusinessV2RechargeJob;
  document: Record<string, unknown>;
  repository: RechargeRepository;
  retiredIdentifier: string;
  revision: number;
  markerDigest: string;
}) {
  await input.repository.updateJob(input.tx, input.job.id, {
    result: toV2JsonDocument(
      replacementBindingResult(
        object(input.job.result),
        input.document,
        input.retiredIdentifier,
        input.revision,
        input.markerDigest
      )
    )
  });
}

export async function validateReplacementCheckoutCreated(input: {
  tx: V2CommandTransaction;
  job: IdBusinessV2RechargeJob;
  callback: Record<string, unknown>;
  document: Record<string, unknown>;
  repository: RechargeRepository;
}) {
  const { tx, job, callback, document, repository } = input;
  const previous = object(job.result);
  if (previous[bindingKey] && document.status === 'checkout_attempted') {
    const binding = object(previous[bindingKey]);
    const records = job.accountKey ? await repository.records(tx, job.accountKey) : [];
    const current = records.find((record) => record.fileKey === callback.fileKey);
    const clientMarker = (value: unknown) =>
      Object.fromEntries(
        Object.entries(object(value)).filter(
          ([key]) => !['cycle_origin', 'cycle_resolution'].includes(key)
        )
      );
    if (
      callback.revision !== Number(binding.markerRevision) - 1 ||
      !current ||
      current.ownerId !== job.ownerId ||
      current.accountKey !== job.accountKey ||
      current.revision !== binding.markerRevision ||
      rechargeDocumentDigest(current.document) !== binding.markerDigest ||
      rechargeDocumentDigest(clientMarker(document)) !==
        rechargeDocumentDigest(clientMarker(current.document))
    )
      throw new ConflictException('本次替换建单标记已经落盘，不能再次授予创建资格');
  }
  if (
    !previous[bindingKey] ||
    previous.checkout_identifier !== undefined ||
    document.status !== 'checkout_created'
  )
    return false;
  const binding = object(previous[bindingKey]);
  if (
    job.action !== 'bitbrowser' ||
    previous.transport !== 'web_direct' ||
    !job.accountKey ||
    callback.fileKey !== `${job.accountKey}${job.plan === 'plus' ? '' : `-${job.plan}`}.json` ||
    callback.revision !== binding.markerRevision ||
    !noPayment(previous) ||
    !noPayment(document) ||
    document.stage !== 'checkout_create' ||
    document.checkout_outcome !== 'created' ||
    document.target_plan !== job.plan ||
    document.account_key !== job.accountKey ||
    typeof document.checkout_identifier !== 'string' ||
    !/^(?:cs|oaics)_[A-Za-z0-9_]{1,200}$/.test(document.checkout_identifier) ||
    document.checkout_identifier === binding.retiredIdentifier ||
    typeof document.processor_entity !== 'string' ||
    !/^[a-z][a-z0-9_]{0,40}$/.test(document.processor_entity)
  )
    throw new ConflictException('新结算账本未绑定本次替换标记或零付款状态');
  const records = await repository.records(tx, job.accountKey);
  const current = records.find((record) => record.fileKey === callback.fileKey);
  if (
    !current ||
    current.ownerId !== job.ownerId ||
    current.accountKey !== job.accountKey ||
    current.revision !== binding.markerRevision ||
    rechargeDocumentDigest(current.document) !== binding.markerDigest
  )
    throw new ConflictException('新结算标记版本已变化，不能绑定新订单');
  const marker = object(current.document);
  const material = (value: Record<string, unknown>) =>
    Object.fromEntries(
      Object.keys(marker)
        .filter(
          (key) => !['status', 'checkout_outcome', 'cycle_origin', 'cycle_resolution'].includes(key)
        )
        .map((key) => [key, value[key]])
    );
  if (
    rechargeDocumentDigest(material(marker)) !== rechargeDocumentDigest(material(document)) ||
    currentCheckoutKeys
      .filter((key) => !['checkout_identifier', 'processor_entity'].includes(key))
      .some((key) => document[key] !== undefined)
  )
    throw new ConflictException('新结算账本改动了本次替换标记或夹带旧报价');
  return true;
}

export async function bindReplacementCheckoutCreated(input: {
  tx: V2CommandTransaction;
  job: IdBusinessV2RechargeJob;
  document: Record<string, unknown>;
  repository: RechargeRepository;
}) {
  await input.repository.updateJob(input.tx, input.job.id, {
    result: toV2JsonDocument({
      ...object(input.job.result),
      checkout_identifier: input.document.checkout_identifier,
      processor_entity: input.document.processor_entity,
      checkout_status: 'created'
    })
  });
}

export async function authorizeExpiredCheckoutReplacement(input: {
  tx: V2CommandTransaction;
  job: IdBusinessV2RechargeJob;
  callback: Record<string, unknown>;
  repository: RechargeRepository;
  audit: V2TransactionalAuditService;
}) {
  const { tx, job, callback, repository, audit } = input;
  const current = object(job.result);
  const proof = expiredCheckoutProof(callback.proof);
  const identifier = proof.checkout_identifier as string;
  if (
    job.action !== 'bitbrowser' ||
    job.state !== 'running' ||
    !job.accountKey ||
    callback.accountKey !== job.accountKey ||
    proof.account_key !== job.accountKey ||
    proof.target_plan !== job.plan ||
    callback.checkoutIdentifier !== identifier ||
    rechargeCheckoutIdentifier(current) !== identifier ||
    current.account_matched !== true ||
    current.mode === 'open_browser' ||
    current.recheck_only === true ||
    current.resolution_only === true ||
    current.unidentified_checkout_recovery === true ||
    current.operation === 'subscription_upgrade' ||
    current.current_plan !== 'free' ||
    !noPayment(current)
  )
    throw new ConflictException('当前任务不能替换原结算，请保留原单核实付款事实');
  const accountKey = job.accountKey;
  const records = await repository.records(tx, accountKey);
  if (
    records.some(
      (record) =>
        record.ownerId !== job.ownerId ||
        (!record.fileKey.startsWith('history/') &&
          !isClosedCycleDocument(record.document, accountKey) &&
          record.fileKey.startsWith('payments/') &&
          !resolvedDeclinedPayment(record.document))
    )
  )
    throw new ConflictException('存在未安全结束的付款记录，不能创建新结算');
  const fileKey = `${job.accountKey}${job.plan === 'plus' ? '' : `-${job.plan}`}.json`;
  const record = records.find((item) => item.fileKey === fileKey);
  if (
    !record ||
    rechargeCheckoutIdentifier(object(record.document)) !== identifier ||
    (object(record.document).target_plan ?? 'plus') !== job.plan ||
    object(record.document).processor_entity !== proof.processor_entity ||
    object(record.document).payment_status !== 'not_attempted' ||
    !noPayment(record.document)
  )
    throw new ConflictException('原结算持久记录或零付款事实未核实');
  const existing = object(current[privateKey] ?? {});
  const documentDigest = rechargeDocumentDigest(record.document);
  if (existing.checkoutIdentifier) {
    if (
      existing.consumed !== false ||
      existing.checkoutIdentifier !== identifier ||
      existing.revision !== record.revision ||
      existing.documentDigest !== documentDigest ||
      rechargeDocumentDigest(existing.proof) !== rechargeDocumentDigest(proof)
    )
      throw new ConflictException('原结算替换授权已使用或记录已变化');
    return {
      ok: true as const,
      replacementAuthorized: true as const,
      checkoutIdentifier: identifier,
      checkoutRecordRevision: record.revision,
      retryOf: documentDigest
    };
  }
  const archiveFileKey = `history/${rechargeDocumentDigest({
    accountKey: job.accountKey,
    fileKey,
    revision: record.revision,
    document: record.document,
    proof
  })}.json`;
  await repository.createCycleArchive(tx, job, archiveFileKey, {
    kind: 'expired_checkout',
    source_job_id: job.id,
    source_file_key: fileKey,
    source_revision: record.revision,
    document: record.document,
    proof
  });
  await repository.updateJob(tx, job.id, {
    result: toV2JsonDocument({
      ...current,
      [privateKey]: {
        checkoutIdentifier: identifier,
        fileKey,
        revision: record.revision,
        documentDigest,
        proof,
        archiveFileKey,
        consumed: false
      }
    })
  });
  await audit.append(tx, {
    userId: job.ownerId,
    module: 'id_business_v2',
    action: 'id_business_v2.auto_recharge.expired_checkout.authorize',
    objectType: 'recharge_job',
    objectId: job.id,
    afterData: { checkoutIdentifier: identifier, archiveFileKey },
    remark: '官网原单已核实过期且未付款，零付款记录已归档，仅允许本任务创建一次新结算'
  });
  return {
    ok: true as const,
    replacementAuthorized: true as const,
    checkoutIdentifier: identifier,
    checkoutRecordRevision: record.revision,
    retryOf: documentDigest
  };
}

export async function validateExpiredCheckoutMarker(input: {
  tx: V2CommandTransaction;
  job: IdBusinessV2RechargeJob;
  callback: Record<string, unknown>;
  document: Record<string, unknown>;
  repository: RechargeRepository;
}) {
  if (
    input.document.expired_checkout_replacement === undefined ||
    input.document.status !== 'checkout_attempted' ||
    input.document.stage !== 'checkout_create'
  )
    return false;
  const { tx, job, callback, document, repository } = input;
  const authorization = object(object(job.result)[privateKey] ?? {});
  const proof = expiredCheckoutProof(document.expired_checkout_replacement);
  if (
    job.action !== 'bitbrowser' ||
    job.state !== 'running' ||
    !job.accountKey ||
    !noPayment(job.result) ||
    object(job.result).current_plan !== 'free' ||
    authorization.fileKey !== callback.fileKey ||
    authorization.revision !== callback.revision ||
    authorization.checkoutIdentifier !== proof.checkout_identifier ||
    proof.account_key !== job.accountKey ||
    proof.target_plan !== job.plan ||
    rechargeDocumentDigest(authorization.proof) !== rechargeDocumentDigest(proof) ||
    document.status !== 'checkout_attempted' ||
    document.stage !== 'checkout_create' ||
    document.checkout_outcome !== 'unknown' ||
    document.payment_status !== 'not_attempted' ||
    !noPayment(document) ||
    typeof document.retry_of !== 'string' ||
    !/^[a-f0-9]{64}$/.test(document.retry_of)
  )
    throw new ConflictException('新结算创建标记未绑定本任务的原单替换授权');
  if (authorization.consumed === true) {
    if (authorization.markerDigest !== rechargeDocumentDigest(document))
      throw new ConflictException('本任务新结算创建资格已经使用');
    return true;
  }
  const records = await repository.records(tx, job.accountKey);
  if (
    records.some(
      (record) =>
        record.ownerId !== job.ownerId ||
        (record.fileKey.startsWith('payments/') &&
          !isClosedCycleDocument(record.document, String(job.accountKey)) &&
          !resolvedDeclinedPayment(record.document))
    )
  )
    throw new ConflictException('授权后出现新的付款记录，不能替换原结算');
  const current = records.find((item) => item.fileKey === callback.fileKey);
  if (
    !current ||
    current.revision !== callback.revision ||
    rechargeDocumentDigest(current.document) !== authorization.documentDigest
  )
    throw new ConflictException('原结算记录已变化，不能使用旧替换授权');
  return true;
}

export async function consumeExpiredCheckoutMarker(input: {
  tx: V2CommandTransaction;
  job: IdBusinessV2RechargeJob;
  document: Record<string, unknown>;
  repository: RechargeRepository;
  markerDigest?: string;
}) {
  const previous = object(input.job.result);
  const authorization = object(previous[privateKey] ?? {});
  const result =
    previous.transport === 'web_direct'
      ? replacementBindingResult(
          previous,
          input.document,
          String(authorization.checkoutIdentifier),
          Number(authorization.revision) + 1,
          input.markerDigest ?? ''
        )
      : { ...previous };
  for (const key of currentCheckoutKeys) delete result[key];
  await input.repository.updateJob(input.tx, input.job.id, {
    result: toV2JsonDocument({
      ...result,
      checkout_replacement_performed: true,
      [privateKey]: {
        ...authorization,
        consumed: true,
        markerDigest: rechargeDocumentDigest(input.document)
      }
    })
  });
}
