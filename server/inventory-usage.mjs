import { randomUUID } from 'node:crypto';
import { parseV2DateTimeInput, toV2DateTimeInput } from '../modules/time/dateTime.ts';

const mailboxTypes = new Map([
  ['google', 'google'], ['谷歌邮箱', 'google'],
  ['relay', 'relay'], ['苹果隐藏邮箱', 'relay']
]);
const accountTypes = new Set(['gpt', 'claude']);
const emailKey = (email) => String(email || '').trim().toLowerCase();
const state = (row) => row.inventoryState || (row.used ? 'used' : 'available');
const list = (value) => Array.isArray(value) ? value : [];

export function isCorrectableUsage(link) {
  return Boolean(link?.occurredAt && (
    (link.kind === 'registration' && link.accountId && !link.registrationId) ||
    (link.kind === 'order-use' && link.orderId)
  ));
}

function instant(value) {
  let text = String(value || '').trim().replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) text += 'T00:00';
  return /(?:Z|[+-]\d{2}:\d{2})$/i.test(text)
    ? Date.parse(text)
    : parseV2DateTimeInput(text)?.getTime() ?? NaN;
}

export function pendingInventoryClaim(inventory, asset) {
  if (!asset?.claimId || !asset.claimBatchId) return null;
  const batch = list(inventory?.batches).find((row) => row?.id === asset.claimBatchId);
  const item = list(batch?.items).find((row) =>
    row?.id === asset.claimId && row.assetId === asset.id &&
    (!row.type || row.type === asset.type) &&
    (!row.email || emailKey(row.email) === emailKey(asset.email)) && row.status === 'pending'
  );
  return item ? { batch, item } : null;
}

export function claimAllowsDelivery(claim, actor) {
  return Boolean(
    claim && claim.batch.kind === 'account' && actor?.id === claim.batch.actorId &&
    !claim.item.taskId && !claim.item.registrationId && !claim.item.orderId &&
    (!claim.batch.purpose || ['客户交付', '业务备用'].includes(claim.batch.purpose))
  );
}

function indexByEmail(rows) {
  const result = new Map();
  for (const row of rows) {
    const email = emailKey(row?.email);
    if (!row?.id || !email) continue;
    if (!result.has(email)) result.set(email, []);
    result.get(email).push(row);
  }
  return result;
}

function orderProduct(order) {
  if (order.product === 'GPT') return 'gpt';
  if (/^Claude (?:Pro|Max)$/.test(order.product || '')) return 'claude';
  return '';
}

function orderEvidence(order, now) {
  if (order.draft || ['draft', 'failed', 'cancelled', '草稿', '失败'].includes(order.status))
    return null;
  const start = instant(order.businessType === '成品交付' ? order.createdAt || order.start : order.start);
  if (!Number.isFinite(start)) return null;
  const confirmed = order.businessType === '成品交付' ||
    order.paidConfirmed === true ||
    list(order.financialEvidence).some((entry) => entry?.kind === 'payment');
  if (order.cancelled && !confirmed) return null;
  return {
    kind: 'order-use', orderId: order.id, product: orderProduct(order),
    actorId: order.createdById, occurred: start,
    pending: !confirmed || start > now || list(order.corrections).some((entry) => {
      const previous = entry?.previous;
      return previous?.email && emailKey(previous.email) !== emailKey(order.email) &&
        (previous.paidConfirmed || previous.receiptConfirmed);
    }),
    label: `订单使用 · ${order.orderNo || order.id}`
  };
}

export function inspectInventoryUsage(inventory, commerce, now = Date.now()) {
  const mail = indexByEmail(list(inventory?.mailboxes).filter((row) =>
    row && ['google', 'relay'].includes(row.type) && !row.relayDeleted
  ));
  const accounts = indexByEmail(list(inventory?.accounts).filter((row) => accountTypes.has(row?.type)));
  const orders = indexByEmail(list(commerce?.orders).filter((row) =>
    row && orderProduct(row) && ['成品交付', '续费'].includes(row.businessType)
  ));
  const lastReturn = new Map();
  for (const batch of list(inventory?.batches)) {
    for (const item of list(batch?.items)) {
      if (!['returned', 'abnormal'].includes(item?.status)) continue;
      const returnedAt = instant(item.returnedAt);
      if (Number.isFinite(returnedAt))
        lastReturn.set(item.assetId, Math.max(lastReturn.get(item.assetId) ?? -Infinity, returnedAt));
    }
  }
  const registrations = list(inventory?.registrationRecords);
  const unresolved = new Set(registrations.filter((row) => row?.state === '待核对').map((row) => row.assetId));
  const matches = new Map();

  function consider(asset, evidence, ambiguous = false) {
    if (list(asset.usageCorrections).some(({ originalLink }) =>
      originalLink?.kind === evidence.kind &&
      originalLink.accountId === evidence.accountId &&
      originalLink.orderId === evidence.orderId &&
      originalLink.registrationId === evidence.registrationId
    )) return;
    const usage = list(asset.usageLinks);
    const supplement = state(asset) === 'used' && evidence.kind === 'registration' &&
      usage.some((link) => link.kind === 'order-use') &&
      !usage.some((link) => link.kind === 'registration');
    if ((state(asset) === 'used' || usage.length) && !supplement) return;
    const existing = matches.get(asset.id);
    const claim = pendingInventoryClaim(inventory, asset);
    const claimedAt = instant(claim?.item.claimedAt || claim?.batch.time);
    const purpose = /^(?:注册\s*)(GPT|Claude|Gemini|Grok)$/i.exec(claim?.batch.purpose || '')?.[1]?.toLowerCase();
    const explicit = evidence.registrationId && ['gemini', 'grok'].includes(evidence.product);
    let reason = '';
    if (ambiguous) reason = '有多条同地址资料，需核对来源';
    else if (evidence.pending || unresolved.has(asset.id) || claim?.item.taskId ||
      (claim?.item.registrationId && claim.item.registrationId !== evidence.registrationId) ||
      (claim?.item.orderId && claim.item.orderId !== evidence.orderId))
      reason = '订单、任务或注册结果待确认';
    else if (state(asset) === 'claimed' && !claim) reason = '提取批次关联待核对';
    else if (claim && (!evidence.actorId || claim.batch.actorId !== evidence.actorId))
      reason = '业务来源与领取人需核对';
    else if (purpose && purpose !== evidence.product) reason = '业务产品与提取用途不一致';
    else if (!Number.isFinite(evidence.occurred) || evidence.occurred > now ||
      (claim && (!Number.isFinite(claimedAt) || evidence.occurred < claimedAt)) ||
      (explicit ? evidence.occurred < (lastReturn.get(asset.id) ?? -Infinity)
        : evidence.occurred <= (lastReturn.get(asset.id) ?? -Infinity)))
      reason = '业务时间与本次提取或历史归还需核对';
    if (existing?.status === 'used') return;
    matches.set(asset.id, {
      asset, claim, evidence, supplement,
      status: reason ? 'review' : 'used',
      message: reason || evidence.label
    });
  }

  const mailById = new Map([...mail.values()].flat().map((row) => [row.id, row]));
  for (const record of registrations) {
    const asset = mailById.get(record?.assetId);
    if (!asset || !record.id || !['待核对', '成功'].includes(record.state)) continue;
    consider(asset, {
      kind: 'registration', registrationId: record.id, product: String(record.product || '').toLowerCase(),
      ...(['gemini', 'grok'].includes(String(record.product || '').toLowerCase()) && { accountId: record.accountId }),
      actorId: record.createdById || record.actorId, occurred: instant(record.time),
      pending: record.state === '待核对', label: `注册登记 · ${record.id}`
    });
  }

  for (const [email, rows] of accounts) {
    for (const account of rows) {
      if (account.claudeHistory || account.source === '客户提供' || account.accountSource === '客户自有') continue;
      const type = mailboxTypes.get(account.emailType);
      if (account.emailType && !type) continue;
      const sources = (mail.get(email) || []).filter((row) => !type || row.type === type);
      const ambiguous = sources.length > 1 || rows.filter((row) => row.type === account.type).length > 1;
      for (const source of sources) {
        consider(source, {
          kind: 'registration', accountId: account.id, product: account.type,
          actorId: account.createdById, occurred: instant(account.registered || account.createdAt),
          label: `账号登记 · ${account.id}`
        }, ambiguous);
      }
    }
  }

  for (const [email, rows] of orders) {
    const mailboxes = mail.get(email) || [];
    const matchingAccounts = accounts.get(email) || [];
    for (const order of rows) {
      const evidence = orderEvidence(order, now);
      if (!evidence) continue;
      const productAccounts = matchingAccounts.filter((row) =>
        row.type === evidence.product && (!order.accountId || row.id === order.accountId)
      );
      const sourceType = productAccounts.length === 1 && mailboxTypes.get(productAccounts[0].emailType);
      const sources = sourceType ? mailboxes.filter((row) => row.type === sourceType) : mailboxes;
      for (const mailbox of sources) {
        if (state(mailbox) === 'claimed' || (sourceType && order.accountId))
          consider(mailbox, evidence, sources.length > 1);
      }
      if (order.accountSource === '客户自有' || order.accountSource === 'customer') continue;
      for (const account of productAccounts) {
        if (account.source === '客户提供') continue;
        if (order.accountId || state(account) === 'claimed')
          consider(account, evidence, productAccounts.length > 1);
      }
    }
  }
  return matches;
}

export function usageReviewRows(matches) {
  return [...matches.values()].map(({ asset, status, message }) => ({ assetId: asset.id, status, message }));
}

export function applyInventoryUsage(matches, actor, now = new Date()) {
  const time = toV2DateTimeInput(now).replace('T', ' ');
  let changed = false;
  for (const { asset, claim, evidence, supplement, status } of matches.values()) {
    if (status !== 'used') continue;
    const { actorId, occurred, pending, ...link } = evidence;
    const occurredAt = toV2DateTimeInput(occurred).replace('T', ' ');
    if (claim) {
      claim.item.status = 'used';
      claim.item.usedAt = occurredAt;
      claim.item.orderId = link.orderId || '';
      if (link.registrationId) claim.item.registrationId = link.registrationId;
    }
    if (!supplement) asset.actualUsedAt = occurredAt;
    asset.inventoryState = 'used';
    asset.used = true;
    (asset.usageLinks ||= []).push({
      ...link, time, occurredAt, ...(claim && { batchId: claim.batch.id, claimId: claim.item.id })
    });
    asset.version = (Number(asset.version) || 0) + 1;
    (asset.inventoryHistory ||= []).push({
      id: randomUUID(), action: '核对使用关联', detail: link.label,
      ...(actor?.id && { actorId: actor.id, actor: actor.name }), time
    });
    if (actor?.id) Object.assign(asset, {
      lastOperatedById: actor.id, lastOperatedBy: actor.name, lastOperatedAt: time
    });
    changed = true;
  }
  return changed;
}

export function correctInventoryUsage(inventory, commerce, assetId, linkIndex, reason, actor, now) {
  const accounts = list(inventory.accounts);
  const rows = [...list(inventory.mailboxes), ...accounts].filter((row) => row?.id === assetId);
  const asset = rows.length === 1 ? rows[0] : null;
  const link = list(asset?.usageLinks)[linkIndex];
  if (!asset || state(asset) !== 'used' || !isCorrectableUsage(link)) return null;

  const time = toV2DateTimeInput(now).replace('T', ' ');
  const originalBatch = list(inventory.batches).find((batch) => batch?.id === asset.claimBatchId);
  const item = list(originalBatch?.items).find((row) =>
    row?.id === asset.claimId && row.assetId === asset.id && row.status === 'used'
  );
  const corrections = (asset.usageCorrections ||= []);
  const recordedClaim = item && (
    (link.claimId === item.id && link.batchId === originalBatch.id) ||
    (item.usedAt === link.occurredAt && corrections.some(({ originalClaim }) =>
      originalClaim?.id === item.id && originalClaim.batchId === originalBatch.id
    ))
  );
  const canUpdateClaim = recordedClaim && !item.taskId && !item.registrationId &&
    (item.orderId || '') === (link.orderId || '');
  const independentUse = list(inventory.registrationRecords).some((row) =>
    row?.assetId === asset.id && ['成功', '待核对'].includes(row.state)
  ) || list(inventory.batches).some((batch) => list(batch?.items).some((row) =>
    row && row !== item && row.assetId === asset.id && ['used', 'pending'].includes(row.status)
  )) || (accounts.includes(asset) && list(commerce?.orders).some((order) =>
    order?.accountId === asset.id && (order.businessType === '成品交付' || !order.cancelled)
  ));

  const correction = {
    id: randomUUID(), reason, actorId: actor.id, actor: actor.name, time, originalLink: link
  };
  asset.usageLinks.splice(linkIndex, 1);
  corrections.push(correction);
  const remaining = asset.usageLinks[0];
  if (canUpdateClaim && (remaining || !independentUse)) {
    correction.originalClaim = {
      batchId: originalBatch.id, id: item.id, status: item.status,
      usedAt: item.usedAt, orderId: item.orderId
    };
    Object.assign(item, {
      status: remaining ? 'used' : 'pending',
      usedAt: remaining?.occurredAt || remaining?.time || '',
      orderId: remaining?.orderId || ''
    });
  }
  if (remaining && asset.actualUsedAt === link.occurredAt) {
    asset.actualUsedAt = remaining.occurredAt || remaining.time;
  }
  if (!asset.usageLinks.length && !independentUse) {
    if (canUpdateClaim) {
      asset.inventoryState = 'claimed';
      delete asset.actualUsedAt;
    } else if (!asset.claimId && !asset.claimBatchId) {
      asset.inventoryState = 'available';
      asset.used = false;
      delete asset.actualUsedAt;
    }
  }
  asset.version = (Number(asset.version) || 0) + 1;
  Object.assign(asset, { lastOperatedById: actor.id, lastOperatedBy: actor.name, lastOperatedAt: time });
  (asset.inventoryHistory ||= []).push({
    id: randomUUID(), action: '更正使用关联', detail: link.label || '更正自动匹配结果',
    actorId: actor.id, actor: actor.name, time
  });
  const match = inspectInventoryUsage(inventory, commerce, now.getTime()).get(assetId);
  if (match) applyInventoryUsage(new Map([[assetId, match]]), actor, now);
  return asset;
}
