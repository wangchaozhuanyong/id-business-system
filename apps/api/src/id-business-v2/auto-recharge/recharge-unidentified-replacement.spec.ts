import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { restoreRechargeAccount } from './recharge-account-restore';
import { RechargeRepository } from './persistence/recharge.repository';
import { rechargeDocumentDigest } from './recharge-callback-receipts';
import {
  findUnidentifiedCheckoutSource,
  hasUnresolvedUnidentifiedCheckoutPayment,
  unidentifiedCheckoutPredecessorJobIds,
  unidentifiedCheckoutSourceResult
} from './recharge-unidentified-checkout';

const key = 'a'.repeat(64),
  profileId = 'b'.repeat(32);
const sourceId = '11111111-1111-4111-8111-111111111111';
const retiredId = 'oaics_expired_retired',
  goId = 'oaics_go_previous';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const record = (fileKey: string, document: Record<string, unknown>, revision = 1) => ({
  ownerId: 'owner',
  accountKey: key,
  fileKey,
  revision,
  document
});

function fixture() {
  const source = {
    id: sourceId,
    ownerId: 'owner',
    accountKey: key,
    plan: 'plus',
    action: 'bitbrowser',
    state: 'finished',
    createdAt: new Date(999000),
    updatedAt: new Date(1001000),
    result: {
      status: 'blocked',
      reason: 'official_payment_form_load_failed',
      stage: 'checkout_create',
      transport: 'web_direct',
      http_status: 400,
      account_matched: true,
      payment_status: 'not_attempted',
      payment_attempted: false,
      checkout_requests_sent: 1,
      payment_requests_sent: 0,
      confirmation_requests_sent: 0,
      target_plan: 'plus',
      browser_profile_id: profileId,
      checkout_identifier: retiredId,
      processor_entity: 'openai_llc'
    } as Record<string, unknown>
  };
  const archived = {
    status: 'checkout_created',
    stage: 'checkout_create',
    transport: 'official_browser',
    account_matched: true,
    current_plan_before: 'free',
    checkout_identifier: retiredId,
    processor_entity: 'openai_llc',
    target_plan: 'plus',
    payment_status: 'not_attempted',
    payment_attempted: false,
    payment_requests_sent: 0,
    confirmation_requests_sent: 0
  };
  const proof = {
    checkout_identifier: retiredId,
    processor_entity: 'openai_llc',
    account_key: key,
    target_plan: 'plus',
    status: 'expired',
    payment_status: 'unpaid'
  };
  const marker = record(
    `${key}.json`,
    {
      schema_version: 2,
      status: 'checkout_attempted',
      stage: 'checkout_create',
      checkout_outcome: 'unknown',
      transport: 'official_browser',
      account_matched: true,
      current_plan_before: 'free',
      payment_status: 'not_attempted',
      run_id: 'd'.repeat(32),
      created_at: 1000,
      account_key: key,
      target_plan: 'plus',
      plan: 'chatgptplusplan',
      retry_of: rechargeDocumentDigest(archived),
      expired_checkout_replacement: proof
    },
    2
  );
  const archive = record('', {
    kind: 'expired_checkout',
    source_job_id: sourceId,
    source_file_key: marker.fileKey,
    source_revision: 1,
    document: archived,
    proof
  });
  const archiveKey = () =>
    `history/${rechargeDocumentDigest({
      accountKey: key,
      fileKey: marker.fileKey,
      revision: archive.document.source_revision,
      document: archive.document.document,
      proof: archive.document.proof
    })}.json`;
  archive.fileKey = archiveKey();
  const resolution = {
    operator_resolution: 'confirmed_verification_failed_no_charge',
    resolution_basis: 'operator_observed_official_failure',
    resolved_at: '2026-10-18T14:12:00.000Z',
    source_job_id: '33333333-3333-4333-8333-333333333333',
    verification_job_id: '44444444-4444-4444-8444-444444444444',
    resolution_job_id: '55555555-5555-4555-8555-555555555555'
  };
  const go = record(
    `${key}-go.json`,
    {
      ...resolution,
      target_plan: 'go',
      plan: 'chatgptgoplan',
      checkout_identifier: goId,
      processor_entity: 'openai_llc',
      status: 'checkout_created',
      payment_status: 'not_attempted',
      payment_attempted: false,
      payment_requests_sent: 0,
      confirmation_requests_sent: 0
    },
    3
  );
  const payment = record(
    `payments/${hash(goId)}.json`,
    {
      ...resolution,
      account_key: key,
      target_plan: 'go',
      checkout_identifier: goId,
      processor_entity: 'openai_llc',
      status: 'payment_result_unknown',
      reason: 'unexpected_payment_observed',
      payment_status: 'unknown',
      payment_attempted: true,
      payment_requests_sent: 1,
      confirmation_requests_sent: 1
    },
    4
  );
  const records = [marker, archive, go, payment];
  const actual = new RechargeRepository({} as never);
  const tx = { idBusinessV2RechargeJob: { findMany: vi.fn().mockResolvedValue([source]) } };
  const repository = {
    records: vi.fn().mockResolvedValue(records),
    retainedProfileForAccount: vi
      .fn()
      .mockResolvedValue({ sourceJobId: sourceId, profileId, accountKey: key }),
    findJob: vi.fn().mockResolvedValue(source),
    finishedJobsForUnidentifiedCheckout: vi.fn().mockResolvedValue([source]),
    updateJob: vi.fn(),
    restoreCheckoutIdentifier: actual.restoreCheckoutIdentifier,
    originalCheckoutForAccount: actual.originalCheckoutForAccount
  };
  const job = {
    id: '22222222-2222-4222-8222-222222222222',
    ownerId: 'owner',
    accountKey: key,
    plan: 'plus',
    action: 'bitbrowser',
    state: 'running',
    result: {
      transport: 'web_direct',
      mode: 'payment',
      payment_requests_sent: 0,
      checkout_requests_sent: 0
    }
  };
  return {
    source,
    marker,
    archive,
    archived,
    proof,
    records,
    go,
    payment,
    archiveKey,
    repository,
    tx,
    input: { tx, repository, job, callback: { accountKey: key } }
  };
}

function legacyPredecessorFixture() {
  const f = fixture();
  delete f.marker.document.account_key;
  f.marker.revision = 6;
  f.archive.document.source_revision = 5;
  Object.assign(f.archived, { plan: 'ChatGPT Plus' });
  f.marker.document.retry_of = rechargeDocumentDigest(f.archived);
  f.archive.fileKey = f.archiveKey();
  const old = structuredClone(f.source);
  old.id = '66666666-6666-4666-8666-666666666666';
  old.createdAt = new Date(1000);
  old.updatedAt = new Date(2000);
  Object.assign(old.result, {
    reason: 'checkout_unknown_write',
    browser_profile_id: 'e'.repeat(32)
  });
  delete old.result.checkout_identifier;
  delete old.result.transport;
  delete old.result.http_status;
  const login = {
    ...f.source,
    id: '77777777-7777-4777-8777-777777777777',
    plan: 'go',
    createdAt: new Date(3000),
    updatedAt: new Date(4000),
    result: {
      mode: 'open_browser',
      status: 'session_ready',
      account_matched: true,
      browser_profile_id: profileId,
      browser_profile_missing_confirmed: true,
      replaced_browser_profile_id: old.result.browser_profile_id,
      payment_attempted: false,
      payment_status: 'not_attempted',
      payment_requests_sent: 0,
      confirmation_requests_sent: 0,
      checkout_requests_sent: 0
    } as Record<string, unknown>
  };
  const history = [f.source, login, old];
  f.repository.finishedJobsForUnidentifiedCheckout.mockResolvedValue(history);
  f.tx.idBusinessV2RechargeJob.findMany.mockResolvedValue(history);
  return { ...f, old, login, history };
}

function recoveredPredecessorFixture() {
  const f = legacyPredecessorFixture();
  const marker = structuredClone(f.marker);
  const markerDigest = rechargeDocumentDigest(marker.document);
  Object.assign(f.source.result, {
    _checkout_replacement_binding_v1: {
      retiredIdentifier: retiredId,
      markerRevision: marker.revision,
      markerDigest
    },
    _expired_checkout_replacement_v1: {
      checkoutIdentifier: retiredId,
      fileKey: marker.fileKey,
      revision: f.archive.document.source_revision,
      documentDigest: rechargeDocumentDigest(f.archived),
      proof: structuredClone(f.proof),
      archiveFileKey: f.archive.fileKey,
      consumed: true,
      markerDigest
    }
  });
  const recoveredId = 'oaics_recovered_unpaid';
  Object.assign(f.marker.document, {
    status: 'checkout_created',
    checkout_outcome: 'created',
    checkout_identifier: recoveredId,
    processor_entity: 'openai_llc',
    checkout_recovered_from_original: true,
    payment_attempted: false,
    payment_requests_sent: 0,
    confirmation_requests_sent: 0
  });
  f.marker.revision += 1;
  const discovery = {
    ...f.source,
    id: '88888888-8888-4888-8888-888888888888',
    createdAt: new Date(1002000),
    updatedAt: new Date(1003000),
    result: {
      status: 'blocked',
      reason: 'official_billing_line1_mismatch',
      stage: 'quote_validation',
      mode: 'payment',
      transport: 'web_direct',
      account_matched: true,
      current_plan: 'free',
      current_plan_before: 'free',
      target_plan: 'plus',
      browser_profile_id: profileId,
      checkout_identifier: recoveredId,
      processor_entity: 'openai_llc',
      checkout_recovered_from_original: true,
      payment_status: 'not_attempted',
      payment_attempted: false,
      checkout_requests_sent: 0,
      payment_requests_sent: 0,
      confirmation_requests_sent: 0
    } as Record<string, unknown>
  };
  f.history.unshift(discovery);
  Object.assign(f.input.job, {
    createdAt: new Date(1004000),
    updatedAt: new Date(1004000)
  });
  Object.assign(f.input.job.result, {
    payment_status: 'not_attempted',
    payment_attempted: false
  });
  f.repository.retainedProfileForAccount.mockResolvedValue({
    sourceJobId: discovery.id,
    profileId,
    accountKey: key
  });
  return { ...f, previousMarker: marker, discovery, recoveredId };
}

describe('unidentified checkout after an archived expired replacement', () => {
  it('derives only the retired binding without changing any original facts', () => {
    const f = fixture(),
      before = structuredClone({ source: f.source, records: f.records });
    const derived = unidentifiedCheckoutSourceResult(f.source, f.marker, f.records, profileId);
    expect(derived).toMatchObject({
      checkout_requests_sent: 1,
      payment_requests_sent: 0,
      http_status: 400
    });
    expect(derived).not.toHaveProperty('checkout_identifier');
    expect(f.source.result.checkout_identifier).toBe(retiredId);
    expect({ source: f.source, records: f.records }).toEqual(before);
  });

  it('restores the exact owned window with no checkout ID and no new requests', async () => {
    const f = fixture(),
      before = structuredClone({ source: f.source, records: f.records });
    const result = await restoreRechargeAccount(f.input as never);
    expect(result).toMatchObject({
      unidentifiedCheckoutRecovery: true,
      ownedProfile: { profileId, sourceJobId: sourceId }
    });
    expect(result).not.toHaveProperty('originalCheckoutIdentifier');
    expect(f.repository.updateJob).toHaveBeenCalledExactlyOnceWith(f.tx, f.input.job.id, {
      accountKey: key,
      result: { ...f.input.job.result, browser_profile_id: profileId }
    });
    expect({ source: f.source, records: f.records }).toEqual(before);
  });

  it('restores a real legacy Plus display label only with unchanged complete archive proof', async () => {
    const f = fixture();
    Object.assign(f.archived, { plan: 'ChatGPT Plus' });
    f.marker.document.retry_of = rechargeDocumentDigest(f.archived);
    f.archive.fileKey = f.archiveKey();
    const before = structuredClone({ source: f.source, records: f.records });
    const result = await restoreRechargeAccount(f.input as never);
    expect(result).toMatchObject({
      unidentifiedCheckoutRecovery: true,
      ownedProfile: { profileId }
    });
    expect(result).not.toHaveProperty('originalCheckoutIdentifier');
    expect(f.marker.document.plan).toBe('chatgptplusplan');
    expect({ source: f.source, records: f.records }).toEqual(before);
  });

  it('accepts the unchanged old wire marker without its redundant account key only with complete server proof', async () => {
    const f = fixture();
    delete f.marker.document.account_key;
    f.marker.revision = 6;
    f.archive.document.source_revision = 5;
    Object.assign(f.archived, { plan: 'ChatGPT Plus' });
    f.marker.document.retry_of = rechargeDocumentDigest(f.archived);
    f.archive.fileKey = f.archiveKey();
    const before = structuredClone({ source: f.source, records: f.records });
    expect((await restoreRechargeAccount(f.input as never)).unidentifiedCheckoutRecovery).toBe(
      true
    );
    expect(f.marker.document).not.toHaveProperty('account_key');
    expect({ source: f.source, records: f.records }).toEqual(before);
  });

  it('selects the source bound to the current wire marker instead of an unrelated legacy unidentified task', () => {
    const f = fixture();
    delete f.marker.document.account_key;
    f.marker.revision = 6;
    f.archive.document.source_revision = 5;
    f.archive.fileKey = f.archiveKey();
    const old = structuredClone(f.source);
    old.id = '66666666-6666-4666-8666-666666666666';
    old.createdAt = new Date(1000);
    old.updatedAt = new Date(2000);
    Object.assign(old.result, {
      reason: 'checkout_unknown_write',
      browser_profile_id: 'e'.repeat(32)
    });
    delete old.result.checkout_identifier;
    delete old.result.transport;
    delete old.result.http_status;
    const before = structuredClone({ source: f.source, old, records: f.records });
    expect(
      findUnidentifiedCheckoutSource(
        [f.source, old],
        'owner',
        key,
        'plus',
        profileId,
        f.marker,
        f.records
      )
    ).toBe(f.source);
    expect({ source: f.source, old, records: f.records }).toEqual(before);
  });

  it.each([
    'null-key',
    'undefined-key',
    'wrong-key',
    'missing-record-account',
    'wrong-record-account',
    'wrong-record-owner',
    'missing-archive',
    'duplicate-archive',
    'archive-proof-account',
    'archive-source-revision',
    'marker-proof-account',
    'retry-digest',
    'old-time',
    'future-time',
    'wrong-profile',
    'payment'
  ])('rejects missing-key wire compatibility with %s and keeps original facts', async (kind) => {
    const f = fixture();
    delete f.marker.document.account_key;
    if (kind === 'null-key') f.marker.document.account_key = null;
    if (kind === 'undefined-key') f.marker.document.account_key = undefined;
    if (kind === 'wrong-key') f.marker.document.account_key = 'c'.repeat(64);
    if (kind === 'missing-record-account') Reflect.deleteProperty(f.marker, 'accountKey');
    if (kind === 'wrong-record-account') f.marker.accountKey = 'c'.repeat(64);
    if (kind === 'wrong-record-owner') f.marker.ownerId = 'other';
    if (kind === 'missing-archive') f.records.splice(1, 1);
    if (kind === 'duplicate-archive') f.records.push(structuredClone(f.archive));
    if (kind === 'archive-proof-account')
      f.archive.document.proof = { ...f.proof, account_key: 'c'.repeat(64) };
    if (kind === 'archive-source-revision') f.archive.document.source_revision = 0;
    if (kind === 'marker-proof-account')
      f.marker.document.expired_checkout_replacement = { ...f.proof, account_key: 'c'.repeat(64) };
    if (kind === 'retry-digest') f.marker.document.retry_of = 'e'.repeat(64);
    if (kind === 'old-time') f.marker.document.created_at = 998;
    if (kind === 'future-time') f.marker.document.created_at = 1002;
    if (kind === 'wrong-profile') f.source.result.browser_profile_id = 'e'.repeat(32);
    if (kind === 'payment') f.source.result.payment_requests_sent = 1;
    const before = structuredClone({ source: f.source, records: f.records });
    await expect(restoreRechargeAccount(f.input as never)).rejects.toThrow();
    expect(f.repository.updateJob).not.toHaveBeenCalled();
    expect({ source: f.source, records: f.records }).toEqual(before);
  });

  it('does not derive a retired identifier from a marker stored under another plan file', () => {
    const f = fixture();
    delete f.marker.document.account_key;
    f.marker.fileKey = `${key}-go.json`;
    expect(
      unidentifiedCheckoutSourceResult(f.source, f.marker, f.records, profileId)
    ).toBeUndefined();
  });

  it.each([
    'ChatGPT Go',
    'ChatGPT Pro（标准）',
    'ChatGPT Pro（更多使用额度）',
    'ChatGPT Pro（最高使用额度）',
    'ChatGPT Pro',
    'Plus',
    'chatgpt plus',
    ' ChatGPT Plus',
    'ChatGPT Plus ',
    'ChatGPT Plus Unlimited',
    ''
  ])(
    'rejects wrong-tier or unrecognized archived label %j even with recomputed hashes',
    async (plan) => {
      const f = fixture();
      Object.assign(f.archived, { plan });
      f.marker.document.retry_of = rechargeDocumentDigest(f.archived);
      f.archive.fileKey = f.archiveKey();
      await expect(restoreRechargeAccount(f.input as never)).rejects.toThrow();
      expect(f.repository.updateJob).not.toHaveBeenCalled();
    }
  );

  it('does not accept a display label in the current checkout marker', async () => {
    const f = fixture();
    Object.assign(f.archived, { plan: 'ChatGPT Plus' });
    f.marker.document.retry_of = rechargeDocumentDigest(f.archived);
    f.archive.fileKey = f.archiveKey();
    f.marker.document.plan = 'ChatGPT Plus';
    await expect(restoreRechargeAccount(f.input as never)).rejects.toThrow();
    expect(f.repository.updateJob).not.toHaveBeenCalled();
  });

  it.each([
    'missing',
    'duplicate',
    'wrong-key',
    'wrong-owner',
    'wrong-account',
    'wrong-source',
    'wrong-source-file',
    'wrong-revision',
    'wrong-marker-revision',
    'wrong-digest',
    'changed-document',
    'changed-proof',
    'marker-account',
    'marker-plan',
    'profile',
    'source-owner',
    'source-account',
    'source-plan',
    'source-payment',
    'source-confirmation',
    'source-count',
    'source-time-before',
    'source-time-after',
    'invalid-date',
    'retired-id'
  ])('blocks %s evidence and never updates a job', async (kind) => {
    const f = fixture();
    if (kind === 'missing') f.records.splice(1, 1);
    if (kind === 'duplicate') f.records.push(structuredClone(f.archive));
    if (kind === 'wrong-key') f.archive.fileKey = `history/${'e'.repeat(64)}.json`;
    if (kind === 'wrong-owner') f.archive.ownerId = 'other';
    if (kind === 'wrong-account') f.archive.accountKey = 'c'.repeat(64);
    if (kind === 'wrong-source')
      f.archive.document.source_job_id = '66666666-6666-4666-8666-666666666666';
    if (kind === 'wrong-source-file') f.archive.document.source_file_key = `${key}-go.json`;
    if (kind === 'wrong-revision') f.archive.document.source_revision = 0;
    if (kind === 'wrong-marker-revision') f.marker.revision = 3;
    if (kind === 'wrong-digest') f.marker.document.retry_of = 'e'.repeat(64);
    if (kind === 'changed-document') f.archived.payment_requests_sent = 1;
    if (kind === 'changed-proof') f.archive.document.proof = { ...f.proof, payment_status: 'paid' };
    if (kind === 'marker-account') f.marker.document.account_key = 'c'.repeat(64);
    if (kind === 'marker-plan') f.marker.document.target_plan = 'go';
    if (kind === 'profile') f.source.result.browser_profile_id = 'c'.repeat(32);
    if (kind === 'source-owner') f.source.ownerId = 'other';
    if (kind === 'source-account') f.source.accountKey = 'c'.repeat(64);
    if (kind === 'source-plan') f.source.plan = 'go';
    if (kind === 'source-payment') f.source.result.payment_requests_sent = 1;
    if (kind === 'source-confirmation') f.source.result.confirmation_requests_sent = 1;
    if (kind === 'source-count') f.source.result.checkout_requests_sent = 2;
    if (kind === 'source-time-before') f.marker.document.created_at = 998;
    if (kind === 'source-time-after') f.marker.document.created_at = 1002;
    if (kind === 'invalid-date') f.source.updatedAt = new Date(NaN);
    if (kind === 'retired-id') f.source.result.checkout_identifier = 'oaics_other';
    await expect(restoreRechargeAccount(f.input as never)).rejects.toThrow();
    expect(f.repository.updateJob).not.toHaveBeenCalled();
  });

  it('rejects payment evidence even if its archive hash and retry digest are recomputed', async () => {
    const f = fixture();
    Object.assign(f.archived, {
      payment_status: 'paid',
      payment_attempted: true,
      payment_requests_sent: 1
    });
    f.archive.fileKey = f.archiveKey();
    f.marker.document.retry_of = rechargeDocumentDigest(f.archived);
    await expect(restoreRechargeAccount(f.input as never)).rejects.toThrow();
    expect(f.repository.updateJob).not.toHaveBeenCalled();
  });

  it('does not select between a derived retired source and another unidentified attempt', async () => {
    const f = fixture();
    const other = structuredClone(f.source);
    other.id = '66666666-6666-4666-8666-666666666666';
    delete other.result.checkout_identifier;
    f.repository.finishedJobsForUnidentifiedCheckout.mockResolvedValue([f.source, other]);
    f.tx.idBusinessV2RechargeJob.findMany.mockResolvedValue([f.source, other]);
    await expect(restoreRechargeAccount(f.input as never)).rejects.toThrow();
    expect(f.repository.updateJob).not.toHaveBeenCalled();
  });

  it('does not infer unique source when the complete history query fails', async () => {
    const f = fixture();
    f.repository.finishedJobsForUnidentifiedCheckout.mockRejectedValue(
      new Error('原结算历史尚未完整核验，禁止恢复原窗口')
    );
    await expect(restoreRechargeAccount(f.input as never)).rejects.toThrow();
    expect(f.repository.updateJob).not.toHaveBeenCalled();
  });
});

describe('strict archived source with a proven earlier zero-payment predecessor', () => {
  it('restores the complete mixed history without changing either source or any ledger document', async () => {
    const f = legacyPredecessorFixture();
    const before = structuredClone({ history: f.history, records: f.records });
    expect(
      unidentifiedCheckoutPredecessorJobIds(f.history, f.source, f.marker, f.records, profileId)
    ).toEqual([f.old.id]);
    const restored = await restoreRechargeAccount(f.input as never);
    expect(restored).toMatchObject({
      unidentifiedCheckoutRecovery: true,
      ownedProfile: { sourceJobId: f.source.id, profileId }
    });
    expect(restored).not.toHaveProperty('originalCheckoutIdentifier');
    expect(f.repository.updateJob).toHaveBeenCalledExactlyOnceWith(f.tx, f.input.job.id, {
      accountKey: key,
      result: { ...f.input.job.result, browser_profile_id: profileId }
    });
    expect({ history: f.history, records: f.records }).toEqual(before);
    expect(f.old.result).toMatchObject({
      checkout_requests_sent: 1,
      payment_requests_sent: 0,
      confirmation_requests_sent: 0,
      payment_status: 'not_attempted'
    });
    expect(restored).not.toHaveProperty('predecessorJobIds');
  });

  it.each([
    'later-source',
    'overlapping-source',
    'same-boundary-source',
    'invalid-time',
    'payment',
    'confirmation',
    'manual-confirmation',
    'missing-login-chain',
    'unverified-login',
    'conflicting-login-parent',
    'another-unknown-source',
    'current-simultaneous-source',
    'tampered-archive',
    'missing-archive',
    'unresolved-payment',
    'current-without-retired-id'
  ])('keeps mixed-history restore blocked for %s', async (kind) => {
    const f = legacyPredecessorFixture();
    if (kind === 'later-source') {
      f.old.createdAt = new Date(1002000);
      f.old.updatedAt = new Date(1003000);
    }
    if (kind === 'overlapping-source') f.old.updatedAt = new Date(1000000);
    if (kind === 'same-boundary-source') f.old.updatedAt = f.source.createdAt;
    if (kind === 'invalid-time') f.old.updatedAt = new Date(NaN);
    if (kind === 'payment') f.old.result.payment_requests_sent = 1;
    if (kind === 'confirmation') f.old.result.confirmation_requests_sent = 1;
    if (kind === 'manual-confirmation') f.old.result.manual_confirmation_accepted = true;
    if (kind === 'missing-login-chain') delete f.login.result.replaced_browser_profile_id;
    if (kind === 'unverified-login') f.login.result.account_matched = false;
    if (kind === 'conflicting-login-parent') {
      const other = structuredClone(f.login);
      other.id = '88888888-8888-4888-8888-888888888888';
      other.result.replaced_browser_profile_id = 'f'.repeat(32);
      f.history.push(other as never);
    }
    if (kind === 'another-unknown-source' || kind === 'current-simultaneous-source') {
      const other = structuredClone(kind === 'another-unknown-source' ? f.old : f.source);
      other.id = '88888888-8888-4888-8888-888888888888';
      delete other.result.checkout_identifier;
      f.history.push(other);
    }
    if (kind === 'tampered-archive') f.archive.document.source_revision = 4;
    if (kind === 'missing-archive') f.records.splice(1, 1);
    if (kind === 'unresolved-payment') delete f.payment.document.operator_resolution;
    if (kind === 'current-without-retired-id') delete f.source.result.checkout_identifier;
    const before = structuredClone({ history: f.history, records: f.records });
    // Even when a candidate is excluded for payment facts, the unchanged historical guard rejects it.
    await expect(restoreRechargeAccount(f.input as never)).rejects.toThrow();
    expect(f.repository.updateJob).not.toHaveBeenCalled();
    expect({ history: f.history, records: f.records }).toEqual(before);
  });
});

describe('identified original checkout after a zero-payment quote failure', () => {
  it('continues the same identified checkout after attempted -> created -> quote failure without a discovery grant', async () => {
    const f = recoveredPredecessorFixture();
    const createdRecord = structuredClone(f.marker);
    Object.assign(f.marker, structuredClone(f.previousMarker));
    f.history.shift();
    f.repository.retainedProfileForAccount.mockResolvedValue({
      sourceJobId: f.source.id,
      profileId,
      accountKey: key
    });
    const discoveryInput = {
      ...f.input,
      job: { ...f.input.job, id: f.discovery.id, createdAt: f.discovery.createdAt }
    };
    const first = await restoreRechargeAccount(discoveryInput as never);
    expect(first.unidentifiedCheckoutRecovery).toBe(true);
    expect(first).not.toHaveProperty('originalCheckoutIdentifier');
    // 模拟官网只读发现后原有 ledger callback 的单次版本晋级，以及核价失败回执。
    Object.assign(f.marker, createdRecord);
    f.history.unshift(f.discovery);
    f.repository.retainedProfileForAccount.mockResolvedValue({
      sourceJobId: f.discovery.id,
      profileId,
      accountKey: key
    });
    f.repository.updateJob.mockClear();
    const before = structuredClone({ history: f.history, records: f.records });
    const restored = await restoreRechargeAccount(f.input as never);
    expect(restored).toMatchObject({
      originalCheckoutIdentifier: f.recoveredId,
      ownedProfile: { sourceJobId: f.discovery.id, profileId }
    });
    expect(restored).not.toHaveProperty('unidentifiedCheckoutRecovery');
    expect(restored).not.toHaveProperty('predecessorJobIds');
    expect(f.repository.updateJob).toHaveBeenCalledExactlyOnceWith(f.tx, f.input.job.id, {
      accountKey: key,
      result: {
        ...f.input.job.result,
        browser_profile_id: profileId,
        checkout_identifier: f.recoveredId
      }
    });
    expect({ history: f.history, records: f.records }).toEqual(before);
  });

  it('accepts the legacy missing second binding only with the unchanged consumed server authorization and exact marker digest', async () => {
    const f = recoveredPredecessorFixture();
    delete f.source.result._checkout_replacement_binding_v1;
    const before = structuredClone({ history: f.history, records: f.records });
    const restored = await restoreRechargeAccount(f.input as never);
    expect(restored.originalCheckoutIdentifier).toBe(f.recoveredId);
    expect(restored).not.toHaveProperty('unidentifiedCheckoutRecovery');
    expect({ history: f.history, records: f.records }).toEqual(before);
  });

  it.each([
    { stage: 'payment_preparation', reason: 'official_payment_field_not_ready' },
    { stage: 'payment_preparation', reason: 'invalid_payment_field' },
    { stage: 'quote_read', reason: 'official_read_timeout' },
    ...['country', 'state', 'city', 'line1', 'line2', 'postal_code', 'name'].map((field) => ({
      stage: 'quote_validation',
      reason: `official_billing_${field}_mismatch`
    })),
    { stage: 'quote_validation', reason: 'direct_payment_quote_billing_mismatch' },
    { stage: 'quote_validation', reason: 'payment_quote_changed' },
    { stage: 'payment_confirmation', reason: 'payment_quote_changed' },
    { stage: 'payment_confirmation', reason: 'billing_fields_changed' },
    ...['payment_preparation', 'quote_read', 'quote_validation', 'payment_confirmation'].map(
      (stage) => ({
        stage,
        status: 'cancelled',
        reason: 'operation_cancelled',
        cancellation_confirmed: true
      })
    )
  ])('restores the same ID after controlled prepayment origin %j', async (terminal) => {
    const f = recoveredPredecessorFixture();
    delete f.source.result._checkout_replacement_binding_v1;
    Object.assign(f.discovery.result, terminal);
    const before = structuredClone({ history: f.history, records: f.records });
    const restored = await restoreRechargeAccount(f.input as never);
    expect(restored.originalCheckoutIdentifier).toBe(f.recoveredId);
    expect(restored).not.toHaveProperty('unidentifiedCheckoutRecovery');
    expect(
      f.history.filter((j) => j.result.checkout_recovered_from_original === true)
    ).toHaveLength(1);
    expect({ history: f.history, records: f.records }).toEqual(before);
  });

  it('keeps one origin and resumes again after two ordinary same-ID zero-payment failures', async () => {
    const f = recoveredPredecessorFixture();
    delete f.source.result._checkout_replacement_binding_v1;
    for (const [index, reason] of [
      'official_billing_postal_code_mismatch',
      'payment_quote_changed'
    ].entries()) {
      const restored = await restoreRechargeAccount(f.input as never);
      expect(restored.originalCheckoutIdentifier).toBe(f.recoveredId);
      expect(restored).not.toHaveProperty('unidentifiedCheckoutRecovery');
      const ordinary = structuredClone(f.discovery);
      ordinary.id =
        index === 0
          ? '99999999-9999-4999-8999-999999999999'
          : 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      ordinary.createdAt = new Date(1004000 + index * 2000);
      ordinary.updatedAt = new Date(1005000 + index * 2000);
      delete ordinary.result.checkout_recovered_from_original;
      Object.assign(ordinary.result, { reason, stage: 'quote_validation' });
      f.history.unshift(ordinary);
      f.repository.retainedProfileForAccount.mockResolvedValue({
        sourceJobId: ordinary.id,
        profileId,
        accountKey: key
      });
      Object.assign(f.input.job, { createdAt: new Date(1006000 + index * 2000) });
    }
    const before = structuredClone({ history: f.history, records: f.records });
    const restored = await restoreRechargeAccount(f.input as never);
    expect(restored.originalCheckoutIdentifier).toBe(f.recoveredId);
    expect(restored).not.toHaveProperty('unidentifiedCheckoutRecovery');
    expect(
      f.history.filter((j) => j.result.checkout_recovered_from_original === true)
    ).toHaveLength(1);
    expect({ history: f.history, records: f.records }).toEqual(before);
  });

  it.each([
    'unknown-reason',
    'unknown-stage',
    'reason-stage-mismatch',
    'payment-result-stage',
    'cancelled-unconfirmed',
    'cancelled-confirmation-false',
    'cancelled-wrong-reason',
    'cancelled-unknown-stage',
    'attempt-key',
    'null-attempt-key',
    'empty-attempt-key',
    'current-attempt-key',
    'later-attempt-key',
    'later-unknown-outcome',
    'later-other-id',
    'second-origin-other-id',
    'second-origin-invalid-time',
    'second-origin-overlapping-time',
    'generic-payment-operation-failed'
  ])('rejects uncontrolled prepayment proof %s', async (kind) => {
    const f = recoveredPredecessorFixture();
    delete f.source.result._checkout_replacement_binding_v1;
    if (kind === 'unknown-reason') f.discovery.result.reason = 'unrecognized_failure';
    if (kind === 'unknown-stage') f.discovery.result.stage = 'unrecognized_stage';
    if (kind === 'reason-stage-mismatch') f.discovery.result.stage = 'payment_preparation';
    if (kind === 'payment-result-stage') f.discovery.result.stage = 'payment_result';
    if (kind === 'generic-payment-operation-failed')
      Object.assign(f.discovery.result, {
        stage: 'payment_confirmation',
        reason: 'payment_operation_failed'
      });
    if (kind.startsWith('cancelled-')) {
      Object.assign(f.discovery.result, { status: 'cancelled', reason: 'operation_cancelled' });
      if (kind === 'cancelled-confirmation-false')
        f.discovery.result.cancellation_confirmed = false;
      if (kind === 'cancelled-wrong-reason')
        Object.assign(f.discovery.result, {
          reason: 'payment_quote_changed',
          cancellation_confirmed: true
        });
      if (kind === 'cancelled-unknown-stage')
        Object.assign(f.discovery.result, { stage: 'unknown', cancellation_confirmed: true });
    }
    if (kind === 'attempt-key')
      f.discovery.result.request_attempt_key = 'synthetic-request-attempt';
    if (kind === 'null-attempt-key') f.discovery.result.request_attempt_key = null;
    if (kind === 'empty-attempt-key') f.discovery.result.request_attempt_key = '';
    if (kind === 'current-attempt-key')
      Object.assign(f.input.job.result, { request_attempt_key: 'synthetic-current-attempt' });
    if (kind.startsWith('later-') || kind.startsWith('second-origin-')) {
      const other = structuredClone(f.discovery);
      other.id = '99999999-9999-4999-8999-999999999999';
      delete other.result.checkout_recovered_from_original;
      if (kind === 'later-attempt-key')
        other.result.request_attempt_key = 'synthetic-later-attempt';
      if (kind === 'later-unknown-outcome') other.result.status = 'payment_result_unknown';
      if (kind === 'later-other-id' || kind === 'second-origin-other-id')
        other.result.checkout_identifier = 'oaics_other_new_checkout';
      if (kind === 'second-origin-other-id') other.result.checkout_recovered_from_original = true;
      if (kind === 'second-origin-invalid-time') {
        other.result.checkout_recovered_from_original = true;
        other.createdAt = new Date(NaN);
      }
      if (kind === 'second-origin-overlapping-time') {
        other.result.checkout_recovered_from_original = true;
        other.createdAt = new Date(998000);
        other.updatedAt = new Date(1000000);
      }
      f.history.push(other);
    }
    const before = structuredClone({ history: f.history, records: f.records });
    await expect(restoreRechargeAccount(f.input as never)).rejects.toThrow();
    expect(f.repository.updateJob).not.toHaveBeenCalled();
    expect({ history: f.history, records: f.records }).toEqual(before);
  });

  it.each(['missing', 'null', 'not-consumed', 'marker-digest', 'document-digest', 'proof', 'file'])(
    'rejects legacy missing-binding compatibility with %s authorization',
    async (kind) => {
      const f = recoveredPredecessorFixture();
      delete f.source.result._checkout_replacement_binding_v1;
      const authorization = f.source.result._expired_checkout_replacement_v1 as Record<
        string,
        unknown
      >;
      if (kind === 'missing') delete f.source.result._expired_checkout_replacement_v1;
      if (kind === 'null') f.source.result._expired_checkout_replacement_v1 = null;
      if (kind === 'not-consumed') authorization.consumed = false;
      if (kind === 'marker-digest') authorization.markerDigest = 'c'.repeat(64);
      if (kind === 'document-digest') authorization.documentDigest = 'c'.repeat(64);
      if (kind === 'proof') authorization.proof = { ...f.proof, account_key: 'c'.repeat(64) };
      if (kind === 'file') authorization.fileKey = `${key}-go.json`;
      const before = structuredClone({ history: f.history, records: f.records });
      await expect(restoreRechargeAccount(f.input as never)).rejects.toThrow();
      expect(f.repository.updateJob).not.toHaveBeenCalled();
      expect({ history: f.history, records: f.records }).toEqual(before);
    }
  );

  it.each([
    'empty-private-binding',
    'null-private-binding',
    'undefined-private-binding',
    'binding-digest',
    'binding-revision',
    'binding-retired-id',
    'missing-authorization',
    'authorization-not-consumed',
    'authorization-digest',
    'authorization-archive',
    'authorization-source-revision',
    'authorization-proof',
    'changed-root-run',
    'extra-root-field',
    'root-revision-gap',
    'root-account',
    'root-payment',
    'root-confirmation',
    'root-evidence',
    'root-paid-outcome',
    'root-retired-id',
    'missing-discovery',
    'second-discovery',
    'discovery-other-id',
    'discovery-other-profile',
    'discovery-other-account',
    'discovery-other-owner',
    'discovery-checkout',
    'discovery-payment',
    'discovery-confirmation',
    'discovery-tokenization',
    'discovery-manual-confirmation',
    'discovery-evidence',
    'discovery-paid',
    'discovery-before-source',
    'discovery-overlaps-current',
    'later-payment-without-ledger',
    'later-confirmation-without-ledger',
    'later-unknown-payment-without-ledger',
    'missing-login-chain',
    'conflicting-login-parent',
    'another-unknown-source',
    'later-unknown-source',
    'tampered-archive',
    'missing-archive',
    'unresolved-payment',
    'current-payment',
    'current-confirmation',
    'current-checkout',
    'current-recheck'
  ])('keeps identified resume blocked for %s without changing history', async (kind) => {
    const f = recoveredPredecessorFixture();
    const binding = f.source.result._checkout_replacement_binding_v1 as Record<string, unknown>;
    const authorization = f.source.result._expired_checkout_replacement_v1 as Record<
      string,
      unknown
    >;
    if (kind === 'empty-private-binding') f.source.result._checkout_replacement_binding_v1 = {};
    if (kind === 'null-private-binding') f.source.result._checkout_replacement_binding_v1 = null;
    if (kind === 'undefined-private-binding')
      f.source.result._checkout_replacement_binding_v1 = undefined;
    if (kind === 'binding-digest') binding.markerDigest = 'c'.repeat(64);
    if (kind === 'binding-revision') binding.markerRevision = 5;
    if (kind === 'binding-retired-id') binding.retiredIdentifier = 'oaics_other';
    if (kind === 'missing-authorization') delete f.source.result._expired_checkout_replacement_v1;
    if (kind === 'authorization-not-consumed') authorization.consumed = false;
    if (kind === 'authorization-digest') authorization.markerDigest = 'c'.repeat(64);
    if (kind === 'authorization-archive')
      authorization.archiveFileKey = `history/${'c'.repeat(64)}.json`;
    if (kind === 'authorization-source-revision') authorization.revision = 4;
    if (kind === 'authorization-proof')
      authorization.proof = { ...f.proof, payment_status: 'paid' };
    if (kind === 'changed-root-run') f.marker.document.run_id = 'c'.repeat(32);
    if (kind === 'extra-root-field') f.marker.document.new_field = true;
    if (kind === 'root-revision-gap') f.marker.revision += 1;
    if (kind === 'root-account') f.marker.document.account_key = 'c'.repeat(64);
    if (kind === 'root-payment') f.marker.document.payment_requests_sent = 1;
    if (kind === 'root-confirmation') f.marker.document.confirmation_requests_sent = 1;
    if (kind === 'root-evidence') f.marker.document.payment_evidence = { identifier: 'paid' };
    if (kind === 'root-paid-outcome') f.marker.document.payment_outcome = 'subscription_activated';
    if (kind === 'root-retired-id') f.marker.document.checkout_identifier = retiredId;
    if (kind === 'missing-discovery') f.history.shift();
    if (kind === 'second-discovery') {
      const other = structuredClone(f.discovery);
      other.id = '99999999-9999-4999-8999-999999999999';
      f.history.push(other);
    }
    if (kind === 'discovery-other-id') f.discovery.result.checkout_identifier = 'oaics_other';
    if (kind === 'discovery-other-profile') f.discovery.result.browser_profile_id = 'f'.repeat(32);
    if (kind === 'discovery-other-account') f.discovery.accountKey = 'c'.repeat(64);
    if (kind === 'discovery-other-owner') f.discovery.ownerId = 'other';
    if (kind === 'discovery-checkout') f.discovery.result.checkout_requests_sent = 1;
    if (kind === 'discovery-payment') f.discovery.result.payment_requests_sent = 1;
    if (kind === 'discovery-confirmation') f.discovery.result.confirmation_requests_sent = 1;
    if (kind === 'discovery-tokenization') f.discovery.result.card_tokenization_requests_sent = 1;
    if (kind === 'discovery-manual-confirmation')
      f.discovery.result.manual_confirmation_accepted = true;
    if (kind === 'discovery-evidence') f.discovery.result.payment_evidence = { identifier: 'paid' };
    if (kind === 'discovery-paid') f.discovery.result.payment_status = 'paid';
    if (kind === 'discovery-before-source') f.discovery.createdAt = new Date(1000000);
    if (kind === 'discovery-overlaps-current') f.discovery.updatedAt = new Date(1004000);
    if (kind.startsWith('later-') && kind.endsWith('without-ledger')) {
      const other = structuredClone(f.discovery);
      other.id = '99999999-9999-4999-8999-999999999999';
      delete other.result.checkout_recovered_from_original;
      if (kind === 'later-payment-without-ledger') other.result.payment_requests_sent = 1;
      if (kind === 'later-confirmation-without-ledger') other.result.confirmation_requests_sent = 1;
      if (kind === 'later-unknown-payment-without-ledger') other.result.payment_status = 'unknown';
      f.history.push(other);
    }
    if (kind === 'missing-login-chain') delete f.login.result.replaced_browser_profile_id;
    if (kind === 'conflicting-login-parent') {
      const other = structuredClone(f.login);
      other.id = '99999999-9999-4999-8999-999999999999';
      other.result.replaced_browser_profile_id = 'f'.repeat(32);
      f.history.push(other as never);
    }
    if (kind === 'another-unknown-source' || kind === 'later-unknown-source') {
      const other = structuredClone(f.old);
      other.id = '99999999-9999-4999-8999-999999999999';
      if (kind === 'later-unknown-source') {
        other.createdAt = new Date(1002000);
        other.updatedAt = new Date(1003000);
      }
      f.history.push(other);
    }
    if (kind === 'tampered-archive') f.archive.document.source_revision = 4;
    if (kind === 'missing-archive') f.records.splice(1, 1);
    if (kind === 'unresolved-payment') delete f.payment.document.operator_resolution;
    if (kind === 'current-payment') f.input.job.result.payment_requests_sent = 1;
    if (kind === 'current-confirmation')
      Object.assign(f.input.job.result, { confirmation_requests_sent: 1 });
    if (kind === 'current-checkout') f.input.job.result.checkout_requests_sent = 1;
    if (kind === 'current-recheck') Object.assign(f.input.job.result, { recheck_only: true });
    const before = structuredClone({ history: f.history, records: f.records });
    await expect(restoreRechargeAccount(f.input as never)).rejects.toThrow();
    expect(f.repository.updateJob).not.toHaveBeenCalled();
    expect({ history: f.history, records: f.records }).toEqual(before);
  });
});

describe('resolved payment evidence before unidentified checkout discovery', () => {
  it('accepts the complete matching server resolution while preserving unknown 1+1 facts', () => {
    const f = fixture(),
      before = structuredClone(f.records);
    expect(hasUnresolvedUnidentifiedCheckoutPayment(f.records, 'owner', key)).toBe(false);
    expect(f.payment.document).toMatchObject({
      payment_status: 'unknown',
      payment_requests_sent: 1,
      confirmation_requests_sent: 1
    });
    expect(f.records).toEqual(before);
  });
  it.each([
    'bare-marker',
    'missing-basis',
    'invalid-source',
    'same-jobs',
    'invalid-date',
    'payment-counter',
    'confirmation-counter',
    'payment-status',
    'evidence',
    'activation',
    'upgrade',
    'wrong-hash',
    'wrong-owner',
    'wrong-account',
    'wrong-payment-account',
    'missing-checkout',
    'duplicate-checkout',
    'wrong-root-owner',
    'wrong-root-account',
    'root-resolution-mismatch',
    'root-checkout-mismatch',
    'root-count',
    'root-paid'
  ])('retains the block for %s', async (kind) => {
    const f = fixture();
    if (kind === 'bare-marker')
      f.payment.document = { operator_resolution: 'confirmed_verification_failed_no_charge' };
    if (kind === 'missing-basis') delete f.payment.document.resolution_basis;
    if (kind === 'invalid-source') f.payment.document.source_job_id = 'invalid';
    if (kind === 'same-jobs')
      f.payment.document.verification_job_id = f.payment.document.source_job_id;
    if (kind === 'invalid-date') f.payment.document.resolved_at = '2026-99-99T14:12:00Z';
    if (kind === 'payment-counter') f.payment.document.payment_requests_sent = 0;
    if (kind === 'confirmation-counter') f.payment.document.confirmation_requests_sent = 2;
    if (kind === 'payment-status') f.payment.document.payment_status = 'paid';
    if (kind === 'evidence') f.payment.document.payment_evidence = { identifier: 'paid' };
    if (kind === 'activation') f.payment.document.payment_outcome = 'subscription_activated';
    if (kind === 'upgrade') f.payment.document.operation = 'subscription_upgrade';
    if (kind === 'wrong-hash') f.payment.fileKey = `payments/${'c'.repeat(64)}.json`;
    if (kind === 'wrong-owner') f.payment.ownerId = 'other';
    if (kind === 'wrong-account') f.payment.accountKey = 'c'.repeat(64);
    if (kind === 'wrong-payment-account') f.payment.document.account_key = 'c'.repeat(64);
    if (kind === 'missing-checkout') f.records.splice(2, 1);
    if (kind === 'duplicate-checkout') f.records.push(structuredClone(f.go));
    if (kind === 'wrong-root-owner') f.go.ownerId = 'other';
    if (kind === 'wrong-root-account') f.go.accountKey = 'c'.repeat(64);
    if (kind === 'root-resolution-mismatch')
      f.go.document.resolution_job_id = '66666666-6666-4666-8666-666666666666';
    if (kind === 'root-checkout-mismatch') f.go.document.checkout_identifier = 'oaics_other';
    if (kind === 'root-count') f.go.document.payment_requests_sent = 1;
    if (kind === 'root-paid') f.go.document.payment_status = 'paid';
    expect(hasUnresolvedUnidentifiedCheckoutPayment(f.records, 'owner', key)).toBe(true);
    await expect(restoreRechargeAccount(f.input as never)).rejects.toThrow();
    expect(f.repository.updateJob).not.toHaveBeenCalled();
  });
  it('keeps another unresolved payment blocked even if the old Go is fully resolved', async () => {
    const f = fixture();
    const next = record(`payments/${hash('oaics_other')}.json`, {
      account_key: key,
      target_plan: 'pro-20x',
      checkout_identifier: 'oaics_other',
      payment_status: 'unknown',
      payment_attempted: true,
      payment_requests_sent: 1,
      confirmation_requests_sent: 1
    });
    f.records.push(next);
    expect(hasUnresolvedUnidentifiedCheckoutPayment(f.records, 'owner', key)).toBe(true);
    await expect(restoreRechargeAccount(f.input as never)).rejects.toThrow();
    expect(f.repository.updateJob).not.toHaveBeenCalled();
  });
});
