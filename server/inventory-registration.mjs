const platforms = new Map([
  ['gpt', 'ChatGPT'], ['claude', 'Claude'], ['grok', 'Grok'], ['gemini', 'Gemini']
]);
const list = value => Array.isArray(value) ? value : [];
export const registrationEmail = value => typeof value === 'string' ? value.trim().toLowerCase() : '';

export function aiRegistrationProduct(value) {
  const key = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return ['chatgpt', 'codex'].includes(key) ? 'gpt' : platforms.has(key) ? key : '';
}

export function registrationPurposeProduct(value) {
  return aiRegistrationProduct(typeof value === 'string' ? /^注册\s*(.+)$/.exec(value.trim())?.[1] : '');
}

export function isStockRegistration(account) {
  return Boolean(account?.id && platforms.has(account.type) && registrationEmail(account.email) &&
    account.source !== '客户提供' && !['客户自有', 'customer'].includes(account.accountSource));
}

export function registrationOccupancy(inventory) {
  const accounts = new Map(list(inventory?.accounts).filter(isStockRegistration).map(row => [row.id, row]));
  const mailboxes = new Map(list(inventory?.mailboxes).map(row => [row?.id, row]));
  const records = list(inventory?.registrationRecords);
  const recordsById = new Map(records.filter(row => row?.id).map(row => [row.id, row]));
  const byEmail = new Map();
  function add(address, fact) {
    const email = registrationEmail(address);
    if (!email || !fact.product) return;
    if (!byEmail.has(email)) byEmail.set(email, []);
    byEmail.get(email).push(fact);
  }
  for (const account of accounts.values()) {
    add(account.email, { product: account.type, accountId: account.id, key: `account:${account.id}` });
  }
  for (const record of records) {
    if (!['成功', '待核对'].includes(record?.state)) continue;
    add(mailboxes.get(record.assetId)?.email || record.email, {
      product: aiRegistrationProduct(record.product) || accounts.get(record.accountId)?.type,
      accountId: record.accountId, assetId: record.assetId, pending: record.state === '待核对',
      key: `record:${record.id || `${record.assetId}:${record.product}:${record.time}`}`
    });
  }
  for (const asset of mailboxes.values()) {
    for (const [index, link] of list(asset?.usageLinks).entries()) {
      if (!['registration', 'manual-use'].includes(link?.kind)) continue;
      add(asset.email, {
        product: aiRegistrationProduct(link.product) || accounts.get(link.accountId)?.type ||
          aiRegistrationProduct(recordsById.get(link.registrationId)?.product),
        accountId: link.accountId, assetId: asset.id, key: `link:${asset.id}:${index}`
      });
    }
  }
  return byEmail;
}

export function conflictingRegistration(facts = []) {
  return ['product', 'accountId', 'assetId'].some(field =>
    new Set(facts.map(fact => fact[field]).filter(Boolean)).size > 1
  );
}

export function registrationOccupancyMessage(facts = []) {
  const registered = facts.find(fact => fact.accountId && !fact.pending) || facts.find(fact => !fact.pending);
  if (!registered) return '该邮箱的注册结果待核对';
  return `该邮箱已用于注册 ${platforms.get(registered.product)}${registered.accountId ? `，关联账号 ${registered.accountId}` : '，账号待关联'}`;
}

export function registrationProductConflict(facts = [], product, accountId) {
  if (conflictingRegistration(facts) || facts.some(fact =>
    fact.product !== product || (fact.accountId && fact.accountId !== accountId))) {
    return registrationOccupancyMessage(facts);
  }
}

export function checkRegistrationChanges(previous, next, action, actor) {
  const before = registrationOccupancy(previous);
  const after = registrationOccupancy(next);
  const oldAccounts = list(previous?.accounts).filter(isStockRegistration);
  const accounts = new Map(list(next.accounts).map(row => [row?.id, row]));
  for (const account of oldAccounts) {
    const saved = accounts.get(account.id);
    if (!isStockRegistration(saved) || saved.type !== account.type ||
        registrationEmail(saved.email) !== registrationEmail(account.email))
      return '已登记的注册邮箱和原账号必须保留';
  }

  const mailboxes = new Map(list(next.mailboxes).map(row => [row?.id, row]));
  const oldMailboxes = new Map(list(previous?.mailboxes).map(row => [row?.id, row]));
  const nonGoogleEmails = new Set([...mailboxes.values()]
    .filter(row => ['relay', 'microsoft'].includes(row?.type)).map(row => registrationEmail(row.email)));
  const googleEmails = new Set([...mailboxes.values()]
    .filter(row => row?.type === 'google').map(row => registrationEmail(row.email)));
  const oldRecords = new Map(list(previous?.registrationRecords).map(row => [row?.id, row]));
  for (const record of list(next.registrationRecords)) {
    if (!['成功', '待核对'].includes(record?.state)) continue;
    const prior = oldRecords.get(record.id);
    if (prior && prior.state === record.state) continue;
    const mailbox = mailboxes.get(record.assetId);
    const product = aiRegistrationProduct(record.product);
    if (mailbox?.type === 'relay' && (!product || product === 'gemini'))
      return '隐藏邮箱仅可登记 ChatGPT、Claude 或 Grok';
    if (mailbox?.type === 'relay' && !record.accountId) {
      const asset = oldMailboxes.get(record.assetId);
      const batch = asset?.claimBatchId && list(previous?.batches).find(row => row?.id === asset.claimBatchId);
      const claim = asset?.claimId && list(batch?.items).find(row => row?.id === asset.claimId && row.assetId === asset.id);
      if (action !== 'inventory_registration_result' || batch?.kind !== 'mail' || claim?.status !== 'pending' ||
          claim.taskId || (claim.registrationId && claim.registrationId !== record.id) ||
          (batch.actorId !== actor?.id && !['admin', 'super'].includes(actor?.role)))
        return '请核对原隐藏邮箱领用后再登记注册结果';
    }
  }
  for (const mailbox of mailboxes.values()) {
    if (mailbox?.type !== 'relay') continue;
    const added = list(mailbox.usageLinks).slice(list(oldMailboxes.get(mailbox.id)?.usageLinks).length);
    if (added.some(link => ['registration', 'manual-use'].includes(link?.kind) && link.product &&
      !['gpt', 'claude', 'grok'].includes(aiRegistrationProduct(link.product))))
      return '隐藏邮箱仅可登记 ChatGPT、Claude 或 Grok';
  }

  for (const [email, facts] of after) {
    const existing = before.get(email) || [];
    const newFacts = facts.filter(fact => !existing.some(prior => prior.key === fact.key &&
      prior.product === fact.product && prior.accountId === fact.accountId && prior.pending === fact.pending));
    if (!newFacts.length) continue;
    for (const fact of newFacts) {
      const account = fact.accountId && accounts.get(fact.accountId);
      if (fact.assetId && fact.accountId && (!isStockRegistration(account) ||
          account.type !== fact.product || registrationEmail(account.email) !== email))
        return '关联账号与登记的邮箱或注册平台不一致';
      if (mailboxes.get(fact.assetId)?.type === 'relay' && fact.product === 'gemini')
        return 'Gemini 请使用谷歌邮箱';
      if (account?.type === 'gemini' && (['relay', '苹果隐藏邮箱'].includes(account.emailType) ||
          (nonGoogleEmails.has(email) && !googleEmails.has(email)))) return 'Gemini 请使用谷歌邮箱';
      if (!fact.assetId && account?.sourceMailboxId &&
          registrationEmail(mailboxes.get(account.sourceMailboxId)?.email) !== email)
        return '来源邮箱编号与注册邮箱不一致';
    }
    if (conflictingRegistration(facts)) return registrationOccupancyMessage(existing.length ? existing : facts);
  }

  if (action !== 'inventory_extract') return;
  const usedClaimIds = new Set();
  const heldEmails = new Set();
  for (const batch of list(previous?.batches)) {
    if (batch?.kind !== 'mail') continue;
    for (const item of list(batch.items)) {
      usedClaimIds.add(item?.id);
      if (item?.status === 'pending') heldEmails.add(registrationEmail(oldMailboxes.get(item.assetId)?.email || item.email));
    }
  }
  for (const batch of list(next.batches)) {
    if (batch?.kind !== 'mail') continue;
    for (const item of list(batch.items)) {
      if (item?.status !== 'pending' || usedClaimIds.has(item.id)) continue;
      const mailbox = mailboxes.get(item.assetId);
      if (mailbox?.type === 'relay' && registrationPurposeProduct(batch.purpose) === 'gemini')
        return 'Gemini 请使用谷歌邮箱';
      const email = registrationEmail(mailbox?.email || item.email);
      if (!email) continue;
      if (after.has(email)) return registrationOccupancyMessage(after.get(email));
      if (heldEmails.has(email)) return '该邮箱已有待处理的领用记录';
      heldEmails.add(email);
    }
  }
}
