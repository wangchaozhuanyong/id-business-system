import { createHash } from 'node:crypto';
import { rechargeDocumentDigest } from './recharge-callback-receipts';
import { resolvedDeclinedCheckout, resolvedDeclinedPayment } from './recharge-noncharge-proof';

/** 仅允许在原窗口发现未识别结算，不授予新建单或付款能力。 */
export function isUnidentifiedUnpaidCheckout(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  const zero = (n: unknown) => n === undefined || n === null || n === 0;
  return (
    r.status === 'blocked' &&
    (r.reason === 'checkout_unknown_write' ||
      (r.transport === 'web_direct' &&
        ['official_checkout_http_failed', 'official_payment_form_load_failed'].includes(
          String(r.reason)
        ) &&
        r.http_status === 400 &&
        r.payment_attempted === false &&
        r.payment_requests_sent === 0 &&
        r.confirmation_requests_sent === 0)) &&
    r.stage === 'checkout_create' &&
    r.account_matched === true &&
    r.payment_status === 'not_attempted' &&
    r.checkout_requests_sent === 1 &&
    (r.payment_attempted === undefined || r.payment_attempted === false) &&
    [
      'payment_requests_sent',
      'confirmation_requests_sent',
      'card_tokenization_requests_sent'
    ].every((k) => zero(r[k])) &&
    [
      'checkout_identifier',
      'payment_evidence',
      'manual_confirmation_accepted',
      'upgrade_identifier',
      'operation'
    ].every((k) => r[k] === undefined || r[k] === null || r[k] === false)
  );
}

type RecoverySource = {
  id: string;
  ownerId: string;
  accountKey: string | null;
  action: string;
  state: string;
  plan: string;
  result: unknown;
  createdAt?: Date;
  updatedAt?: Date;
};

type RecoveryRecord = {
  ownerId: string;
  accountKey?: string;
  fileKey: string;
  revision: number;
  document: unknown;
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const checkoutPattern = /^(?:cs|oaics)_[A-Za-z0-9_]{1,200}$/;
const officialPlans: Record<string, string> = {
  go: 'chatgptgoplan',
  plus: 'chatgptplusplan',
  'pro-5x': 'chatgptprolite',
  'pro-20x': 'chatgptpro',
  'pro-500': 'chatgptpromax'
};
// 兼容原执行器保存的显示名；精确沿用现有套餐标签，不从金额或部分名称推断。
const archivedPlanLabels: Record<string, string> = {
  go: 'ChatGPT Go',
  plus: 'ChatGPT Plus',
  'pro-5x': 'ChatGPT Pro（标准）',
  'pro-20x': 'ChatGPT Pro（更多使用额度）',
  'pro-500': 'ChatGPT Pro（最高使用额度）'
};
const rootKey = (accountKey: string, plan: string) =>
  `${accountKey}${plan === 'plus' ? '' : `-${plan}`}.json`;
const zeroPayment = (r: Record<string, unknown>) =>
  r.payment_status === 'not_attempted' &&
  r.payment_attempted !== true &&
  ['payment_requests_sent', 'confirmation_requests_sent', 'card_tokenization_requests_sent'].every(
    (key) => r[key] === undefined || r[key] === 0
  ) &&
  !r.manual_confirmation_accepted &&
  !r.payment_evidence &&
  !r.payment_record_write_failed &&
  !r.operation &&
  !r.upgrade_identifier;

/** 只派生旧版本回执的资格；完整同源归档证明已退役的编号不再作为当前绑定。 */
export function unidentifiedCheckoutSourceResult(
  source: RecoverySource,
  markerRecord: RecoveryRecord,
  records: RecoveryRecord[],
  profileId: string
): Record<string, unknown> | undefined {
  const raw = object(source.result),
    marker = object(markerRecord.document);
  // 当前网页标记必须先绑定本次来源，旧无编号任务不能绕过归属、窗口和时间核验。
  if (
    marker.status === 'checkout_attempted' &&
    (!isUnidentifiedCheckoutMarker(marker) ||
      source.action !== 'bitbrowser' ||
      source.state !== 'finished' ||
      raw.mode === 'open_browser' ||
      raw.recheck_only === true ||
      raw.resolution_only === true ||
      !uuid.test(source.id) ||
      !source.accountKey ||
      !/^[a-f0-9]{64}$/.test(source.accountKey) ||
      markerRecord.ownerId !== source.ownerId ||
      markerRecord.accountKey !== source.accountKey ||
      markerRecord.fileKey !== rootKey(source.accountKey, source.plan) ||
      !Number.isSafeInteger(markerRecord.revision) ||
      markerRecord.revision < 0 ||
      (Object.hasOwn(marker, 'account_key') && marker.account_key !== source.accountKey) ||
      marker.target_plan !== source.plan ||
      marker.plan !== officialPlans[source.plan] ||
      (raw.target_plan ?? 'plus') !== source.plan ||
      raw.transport !== 'web_direct' ||
      raw.http_status !== 400 ||
      raw.browser_profile_id !== profileId ||
      !/^[a-f0-9]{32}$/.test(profileId) ||
      !(source.createdAt instanceof Date) ||
      !(source.updatedAt instanceof Date) ||
      !Number.isFinite(source.createdAt.getTime()) ||
      !Number.isFinite(source.updatedAt.getTime()) ||
      Number(marker.created_at) < Math.floor(source.createdAt.getTime() / 1000) ||
      Number(marker.created_at) > Math.floor(source.updatedAt.getTime() / 1000) ||
      source.createdAt.getTime() > source.updatedAt.getTime())
  )
    return undefined;
  if (isUnidentifiedUnpaidCheckout(raw)) return raw;
  const proof = object(marker.expired_checkout_replacement),
    identifier = raw.checkout_identifier;
  const candidate = { ...raw };
  delete candidate.checkout_identifier;
  if (
    !isUnidentifiedUnpaidCheckout(candidate) ||
    !isUnidentifiedCheckoutMarker(marker) ||
    source.action !== 'bitbrowser' ||
    source.state !== 'finished' ||
    raw.mode === 'open_browser' ||
    raw.recheck_only === true ||
    raw.resolution_only === true ||
    !uuid.test(source.id) ||
    !source.accountKey ||
    !/^[a-f0-9]{64}$/.test(source.accountKey) ||
    markerRecord.ownerId !== source.ownerId ||
    markerRecord.accountKey !== source.accountKey ||
    markerRecord.fileKey !== rootKey(source.accountKey, source.plan) ||
    !Number.isSafeInteger(markerRecord.revision) ||
    markerRecord.revision < 2 ||
    // 旧网页标记未发送该冗余字段；显式值仍须精确一致，归属和完整归档证明不可省略。
    (Object.hasOwn(marker, 'account_key') && marker.account_key !== source.accountKey) ||
    marker.target_plan !== source.plan ||
    marker.plan !== officialPlans[source.plan] ||
    raw.target_plan !== source.plan ||
    raw.transport !== 'web_direct' ||
    raw.http_status !== 400 ||
    raw.browser_profile_id !== profileId ||
    !/^[a-f0-9]{32}$/.test(profileId) ||
    typeof identifier !== 'string' ||
    !checkoutPattern.test(identifier) ||
    !(source.createdAt instanceof Date) ||
    !(source.updatedAt instanceof Date) ||
    !Number.isFinite(source.createdAt.getTime()) ||
    !Number.isFinite(source.updatedAt.getTime()) ||
    Number(marker.created_at) < Math.floor(source.createdAt.getTime() / 1000) ||
    Number(marker.created_at) > Math.floor(source.updatedAt.getTime() / 1000) ||
    source.createdAt.getTime() > source.updatedAt.getTime() ||
    Object.keys(proof).length !== 6 ||
    ![
      'checkout_identifier',
      'processor_entity',
      'target_plan',
      'account_key',
      'status',
      'payment_status'
    ].every((key) => Object.hasOwn(proof, key)) ||
    proof.checkout_identifier !== identifier ||
    proof.processor_entity !== raw.processor_entity ||
    typeof proof.processor_entity !== 'string' ||
    !/^[a-z][a-z0-9_]{0,40}$/.test(proof.processor_entity) ||
    proof.account_key !== source.accountKey ||
    proof.target_plan !== source.plan ||
    proof.status !== 'expired' ||
    proof.payment_status !== 'unpaid' ||
    typeof marker.retry_of !== 'string' ||
    !/^[a-f0-9]{64}$/.test(marker.retry_of)
  )
    return undefined;
  const archives = records.filter((record) => {
    const archive = object(record.document);
    return (
      record.fileKey.startsWith('history/') &&
      archive.kind === 'expired_checkout' &&
      archive.source_job_id === source.id
    );
  });
  if (archives.length !== 1) return undefined;
  const record = archives[0]!,
    archive = object(record.document),
    archived = object(archive.document);
  if (
    record.ownerId !== source.ownerId ||
    record.accountKey !== source.accountKey ||
    record.revision !== 1 ||
    archive.source_file_key !== markerRecord.fileKey ||
    archive.source_revision !== markerRecord.revision - 1 ||
    rechargeDocumentDigest(archive.proof) !== rechargeDocumentDigest(proof) ||
    archived.checkout_identifier !== identifier ||
    archived.processor_entity !== proof.processor_entity ||
    (archived.target_plan ?? 'plus') !== source.plan ||
    (archived.plan !== undefined &&
      archived.plan !== officialPlans[source.plan] &&
      archived.plan !== archivedPlanLabels[source.plan]) ||
    (archived.account_key !== undefined && archived.account_key !== source.accountKey) ||
    !zeroPayment(archived) ||
    marker.retry_of !== rechargeDocumentDigest(archive.document) ||
    record.fileKey !==
      `history/${rechargeDocumentDigest({
        accountKey: source.accountKey,
        fileKey: markerRecord.fileKey,
        revision: archive.source_revision,
        document: archive.document,
        proof: archive.proof
      })}.json`
  )
    return undefined;
  return candidate;
}

/** 已处理付款只复用完整服务端凭据和精确原单绑定，其他付款仍阻止未知原单发现。 */
export function hasUnresolvedUnidentifiedCheckoutPayment(
  records: RecoveryRecord[],
  ownerId: string,
  accountKey: string
): boolean {
  return records.some((record) => {
    if (!record.fileKey.startsWith('payments/')) return false;
    const payment = object(record.document),
      identifier = payment.checkout_identifier,
      plan = String(payment.target_plan ?? 'plus');
    const roots = records.filter((item) => item.fileKey === rootKey(accountKey, plan));
    const root = roots[0],
      checkout = object(root?.document);
    const metadata = [
      'operator_resolution',
      'resolution_basis',
      'resolved_at',
      'resolution_job_id',
      'source_job_id',
      'verification_job_id'
    ];
    return !(
      record.ownerId === ownerId &&
      record.accountKey === accountKey &&
      Number.isSafeInteger(record.revision) &&
      record.revision > 0 &&
      resolvedDeclinedPayment(payment) &&
      payment.operator_resolution === 'confirmed_verification_failed_no_charge' &&
      payment.account_key === accountKey &&
      typeof identifier === 'string' &&
      checkoutPattern.test(identifier) &&
      record.fileKey === `payments/${createHash('sha256').update(identifier).digest('hex')}.json` &&
      Object.hasOwn(officialPlans, plan) &&
      !payment.operation &&
      !payment.upgrade_identifier &&
      payment.status !== 'subscription_activated' &&
      ![
        'subscription_activated',
        'paid_pending_activation',
        'paid_tier_pending_verification'
      ].includes(String(payment.payment_outcome)) &&
      metadata
        .filter((key) => key.endsWith('_job_id'))
        .every((key) => uuid.test(String(payment[key]))) &&
      new Set([payment.resolution_job_id, payment.source_job_id, payment.verification_job_id])
        .size === 3 &&
      Number.isFinite(Date.parse(String(payment.resolved_at))) &&
      roots.length === 1 &&
      root?.ownerId === ownerId &&
      root.accountKey === accountKey &&
      Number.isSafeInteger(root.revision) &&
      root.revision > 0 &&
      resolvedDeclinedCheckout(checkout) &&
      metadata.every((key) => checkout[key] === payment[key]) &&
      checkout.checkout_identifier === identifier &&
      String(checkout.target_plan ?? 'plus') === plan &&
      (checkout.plan === undefined || checkout.plan === officialPlans[plan]) &&
      (checkout.account_key === undefined || checkout.account_key === accountKey) &&
      checkout.payment_attempted === false &&
      checkout.payment_requests_sent === 0 &&
      checkout.confirmation_requests_sent === 0 &&
      !checkout.operation &&
      !checkout.upgrade_identifier &&
      checkout.status !== 'subscription_activated' &&
      checkout.payment_outcome !== 'subscription_activated'
    );
  });
}

/** 登录记录不是建单来源；替换窗口须有完整的归属链和独立的官网身份核实。 */
export function findUnidentifiedCheckoutSource<T extends RecoverySource>(
  jobs: T[],
  ownerId: string,
  accountKey: string,
  plan: string,
  profileId: string,
  markerRecord?: RecoveryRecord,
  records: RecoveryRecord[] = []
): T | undefined {
  const object = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const profile = (value: unknown): value is string =>
    typeof value === 'string' && /^[a-f0-9]{32}$/i.test(value);
  const owned = jobs.filter(
    (job) =>
      job.ownerId === ownerId &&
      job.accountKey === accountKey &&
      job.action === 'bitbrowser' &&
      job.state === 'finished'
  );
  const sources = owned.filter(
    (job) =>
      job.plan === plan &&
      (markerRecord
        ? Boolean(unidentifiedCheckoutSourceResult(job, markerRecord, records, profileId))
        : isUnidentifiedUnpaidCheckout(job.result))
  );
  if (sources.length !== 1 || !profile(profileId)) return undefined;
  const source = sources[0]!;
  const originalProfile = object(source.result).browser_profile_id;
  if (!profile(originalProfile)) return undefined;
  const logins = owned.filter((job) => {
    const r = object(job.result);
    return (
      r.mode === 'open_browser' &&
      r.payment_attempted === false &&
      r.payment_requests_sent === 0 &&
      (r.payment_status === undefined || r.payment_status === 'not_attempted') &&
      [
        'checkout_requests_sent',
        'confirmation_requests_sent',
        'card_tokenization_requests_sent'
      ].every((key) => r[key] === undefined || r[key] === 0) &&
      !r.manual_confirmation_accepted &&
      !r.payment_evidence
    );
  });
  const seen = new Set<string>();
  let current = profileId;
  while (current !== originalProfile) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    if (
      !logins.some((job) => {
        const r = object(job.result);
        return (
          r.browser_profile_id === current &&
          r.status === 'session_ready' &&
          r.account_matched === true
        );
      })
    )
      return undefined;
    const parents = new Set(
      logins
        .map((job) => object(job.result))
        .filter(
          (r) =>
            r.browser_profile_id === current &&
            r.browser_profile_missing_confirmed === true &&
            profile(r.replaced_browser_profile_id)
        )
        .map((r) => r.replaced_browser_profile_id as string)
    );
    if (parents.size !== 1) return undefined;
    current = [...parents][0]!;
  }
  return source;
}

/** 完整退役归档后的原窗口发现，可识别唯一、已通过零付款窗口链的更早来源。 */
export function unidentifiedCheckoutPredecessorJobIds(
  jobs: RecoverySource[],
  source: RecoverySource,
  markerRecord: RecoveryRecord,
  records: RecoveryRecord[],
  profileId: string
): string[] {
  if (
    !source.accountKey ||
    !checkoutPattern.test(String(object(source.result).checkout_identifier ?? '')) ||
    !unidentifiedCheckoutSourceResult(source, markerRecord, records, profileId) ||
    hasUnresolvedUnidentifiedCheckoutPayment(records, source.ownerId, source.accountKey) ||
    !(source.createdAt instanceof Date) ||
    !Number.isFinite(source.createdAt.getTime())
  )
    return [];
  // 不剪裁历史或自行拼接登录链；存在第二个未知来源或冲突窗口链时仍不给豁免。
  const previous = findUnidentifiedCheckoutSource(
    jobs,
    source.ownerId,
    source.accountKey,
    source.plan,
    profileId
  );
  const result = object(previous?.result);
  if (
    !previous ||
    previous.id === source.id ||
    !uuid.test(previous.id) ||
    !isUnidentifiedUnpaidCheckout(result) ||
    result.mode === 'open_browser' ||
    result.recheck_only === true ||
    result.resolution_only === true ||
    !(previous.createdAt instanceof Date) ||
    !(previous.updatedAt instanceof Date) ||
    !Number.isFinite(previous.createdAt.getTime()) ||
    !Number.isFinite(previous.updatedAt.getTime()) ||
    previous.createdAt.getTime() > previous.updatedAt.getTime() ||
    previous.updatedAt.getTime() >= source.createdAt.getTime()
  )
    return [];
  return [previous.id];
}

/** 网页在请求前保存的标记本身不是零付款证明，必须另有严格核实的来源任务。 */
export function isUnidentifiedCheckoutMarker(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return (
    r.status === 'checkout_attempted' &&
    r.stage === 'checkout_create' &&
    r.checkout_outcome === 'unknown' &&
    r.transport === 'official_browser' &&
    r.account_matched === true &&
    r.current_plan_before === 'free' &&
    r.payment_status === 'not_attempted' &&
    typeof r.run_id === 'string' &&
    /^[a-f0-9]{32}$/.test(r.run_id) &&
    Number.isSafeInteger(r.created_at) &&
    Number(r.created_at) > 0 &&
    [
      'checkout_identifier',
      'payment_evidence',
      'manual_confirmation_accepted',
      'upgrade_identifier',
      'operation',
      'payment_attempted',
      'payment_requests_sent',
      'confirmation_requests_sent',
      'card_tokenization_requests_sent'
    ].every((k) => r[k] === undefined || r[k] === null || r[k] === false || r[k] === 0)
  );
}
