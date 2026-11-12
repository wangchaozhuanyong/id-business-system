/* Inventory views share the local inventory document when the business API is enabled. */
(function registerInventoryModule() {
  'use strict';

  const api = window.IDDesignAPI;
  const {
    esc,
    icon,
    button,
    tag,
    textAction,
    options,
    field,
    input,
    select,
    header,
    summary,
    empty,
    table,
    pagination,
    pageRows
  } = api;
  const { mailboxes, accounts } = api.collections;
  const accountSummaries = new Map();
  let inventoryReadIndex;
  let lifecycleCommerceVersion = 0;
  let accountLifecycleLoaded = false;
  const batches = [];
  const returnRecords = [];
  const importRecords = [];
  const registrationRecords = [];
  const registrationPlatforms = [
    ['gpt', 'ChatGPT'], ['claude', 'Claude'], ['gemini', 'Gemini'], ['grok', 'Grok'], ['apple', 'Apple ID']
  ];
  const relayRegistrationPlatforms = registrationPlatforms.filter(([key]) => ['gpt', 'claude', 'grok'].includes(key));
  const actualUsePurposes = ['注册 GPT', ...registrationPlatforms.slice(1).map(([, label]) => `注册 ${label}`), '客户交付', '其他'];
  const mailboxType = type => ['google', 'relay', 'microsoft'].includes(type);
  function registrationProduct(value) {
    const key = String(value || '').trim().toLowerCase();
    return ({ chatgpt: 'gpt', codex: 'gpt', 'apple id': 'apple' })[key] || key;
  }
  function mailboxPlatforms(asset) {
    const found = new Set();
    const add = value => {
      const key = registrationProduct(value);
      if (registrationPlatforms.some(([id]) => id === key)) found.add(key);
    };
    for (const record of readInventoryIndex().registrations.get(asset.id) || []) add(record.product);
    for (const link of asset.usageLinks || []) {
      if (!['registration', 'manual-use'].includes(link.kind)) continue;
      add(link.product);
      if (link.kind === 'registration' && link.accountId)
        add(readInventoryIndex().accountsById.get(link.accountId)?.type);
    }
    return registrationPlatforms.filter(([id]) => found.has(id));
  }
  function mailboxPlatformLabel(asset) {
    const platforms = mailboxPlatforms(asset);
    if (mailboxRegistrationConflict(asset, platforms)) return '待核对';
    return platforms.map(([, label]) => label).join('、') ||
      (asset.inventoryState === 'used' ? '平台未登记' : '未登记');
  }
  const registrationAddress = value => String(value || '').trim().toLowerCase();
  const stockRegistration = row => stockType(row?.type) && row.source !== '客户提供' &&
    !['客户自有', 'customer'].includes(row.accountSource);
  function registeredAccounts(asset) {
    const ids = new Set((asset.usageLinks || []).filter(link => link.kind === 'registration').map(link => link.accountId));
    const index = readInventoryIndex();
    for (const record of index.registrations.get(asset.id) || []) ids.add(record.accountId);
    return (index.stockByEmail.get(registrationAddress(asset.email)) || []).filter(account => ids.has(account.id));
  }
  function mailboxRegistrationConflict(asset, platforms = mailboxPlatforms(asset)) {
    if (usageReview.get(asset.id)?.registrationConflict) return true;
    const known = new Set(platforms.map(([key]) => key).filter(key => key !== 'apple'));
    if (known.size > 1 || (asset.type === 'relay' && known.has('gemini'))) return true;
    const address = registrationAddress(asset.email);
    const related = address ? readInventoryIndex().stockByEmail.get(address) || [] : [];
    return related.length > 1 || related.some(account => known.size && !known.has(account.type));
  }
  function mailboxRegistrationAccount(asset) {
    return mailboxRegistrationConflict(asset) ? null : registeredAccounts(asset)[0] || null;
  }
  function mailboxRegistrationAccountCell(asset) {
    if (mailboxRegistrationConflict(asset)) return '待核对';
    const account = registeredAccounts(asset)[0];
    if (!account) return asset.inventoryState === 'used' ? '账号待关联' : '—';
    return api.canVisit('accounts/' + account.type)
      ? textAction(account.id, 'inventory-detail', `data-id="${esc(account.id)}" data-table-value-preview`, 'table-value-ellipsis')
      : esc(account.id);
  }
  function registrationInputProblem(type, email, source) {
    const address = registrationAddress(email);
    if (!address || !stockRegistration({ type, source })) return '';
    const existing = accounts.find(account => stockRegistration(account) && registrationAddress(account.email) === address);
    if (existing) {
      const label = registrationPlatforms.find(([key]) => key === existing.type)?.[1];
      return `该邮箱已用于注册 ${label}，关联账号 ${existing.id}`;
    }
    const sources = mailboxes.filter(asset => registrationAddress(asset.email) === address);
    if (type === 'gemini' && sources.length && sources.every(asset => asset.type !== 'google'))
      return 'Gemini 请使用谷歌邮箱';
    const other = sources.flatMap(mailboxPlatforms).find(([key]) => key !== 'apple' && key !== type);
    if (other) return `该邮箱已用于注册 ${other[1]}，账号待关联`;
  }
  const views = new Map();
  const undo = new Map();
  const reservations = new Map();
  const usageReview = new Map();
  let accountAssetContext = null;
  let accountImportContext = null;
  let locationSettingsReturn = null;
  let importFileReadVersion = 0;
  const claudeHistoryStates = { opened: '已开通', aging: '养号中', dead: '死号' };
  const claudeHistoryKey = 'inventory-claude-history';
  const claudeHistoryContentId = 'inventory-claude-history-content';
  const claudeHistoryFields = [
    ['邮箱', 'email'], ['登记状态', 'state'], ['注册时间', 'registered'], ['套餐', 'plan'],
    ['开通时间', 'start'], ['到期时间', 'expiry'], ['国家地区', 'country'], ['登录设备', 'device'], ['来源备注', 'note']
  ];
  let preparedClaudeHistory;
  const accountSubmissionTypes = [
    ['gpt', 'GPT 账号'],
    ['claude', 'Claude 账号'],
    ['apple', '苹果 ID 资料'],
    ['gemini', 'Gemini 账号'],
    ['grok', 'Grok 账号']
  ];
  const stockTypes = accountSubmissionTypes.filter(([id]) => id !== 'apple');
  const stockType = type => stockTypes.some(([id]) => id === type);
  const personalAccount = type => type === 'gemini' || type === 'grok';
  const accountTypeForProduct = product => ({
    GPT: 'gpt', 'Claude Pro': 'claude', 'Claude Max': 'claude', Gemini: 'gemini', Grok: 'grok'
  })[product] || '';
  const grokLoginOptions = [['email', '邮箱登录'], ['google', 'Google 登录'], ['apple', 'Apple 登录'], ['x', 'X 登录']];
  const xLinkOptions = [['unknown', '未核验'], ['linked', '已绑定'], ['unlinked', '未绑定']];
  const displayIdentity = row => row?.loginMethod === 'x' && row.xHandle ? row.xHandle : row?.email || row?.xHandle || '';
  const identityKey = row => displayIdentity(row).trim().toLowerCase();
  function readInventoryIndex() {
    if (!inventoryReadIndex) {
      const byIdentity = new Map(), accountsById = new Map(), stockByEmail = new Map(), registrations = new Map();
      const append = (index, key, row) => {
        if (index.has(key)) index.get(key).push(row); else index.set(key, [row]);
      };
      for (const asset of accounts) {
        let identities = byIdentity.get(asset.type);
        if (!identities) byIdentity.set(asset.type, identities = new Map());
        const key = identityKey(asset);
        // Ambiguous identities must retain the existing "no unique account" result.
        identities.set(key, identities.has(key) ? null : asset);
        if (!accountsById.has(asset.id)) accountsById.set(asset.id, asset);
        if (stockRegistration(asset)) append(stockByEmail, registrationAddress(asset.email), asset);
      }
      for (const record of registrationRecords)
        if (record.state === '成功') append(registrations, record.assetId, record);
      inventoryReadIndex = { byIdentity, accountsById, stockByEmail, registrations };
    }
    return inventoryReadIndex;
  }
  const proxyProtocols = [['socks5', 'SOCKS5'], ['http', 'HTTP'], ['https', 'HTTPS']];
  const proxyDefaults = { socks5: '1080', http: '80', https: '443' };
  const baseTypes = [
    { id: 'google', label: '谷歌邮箱', enabled: true },
    { id: 'apple', label: '苹果 ID', enabled: true },
    { id: 'relay', label: '苹果隐藏邮箱', enabled: true },
    { id: 'microsoft', label: '微软邮箱', enabled: false }
  ];
  const microsoftMailboxRoute = 'mailboxes/microsoft';
  const microsoftLoginModes = [['password', '密码登录'], ['passwordless', '无密码登录']];
  const microsoftRecoveryOptions = [
    ['unknown', '未核验'], ['inventory', '系统内邮箱'], ['manual', '人工取码'], ['unavailable', '无法取码']
  ];
  const microsoftTwoStepOptions = [['unknown', '未核验'], ['enabled', '已开启'], ['disabled', '未开启']];
  const microsoftVerificationOptions = [
    ['email', '邮箱验证码'], ['authenticator', 'Authenticator 手机确认'],
    ['totp', '动态验证码'], ['passkey', '通行密钥'], ['sms', '短信验证']
  ];
  const protectedImportPreviews = new WeakMap();
  const tableSettings = new Map();
  const mailExtractionSettingsKey = 'mail-extraction';
  const defaultMailPurposes = ['注册 Claude', '注册 GPT', '业务备用', '其他', '注册 Gemini', '注册 Grok'];
  const defaultAccountCities = new Map([
    ['马来西亚', ['吉隆坡', '槟城', '新山']],
    ['美国', ['纽约', '洛杉矶', '芝加哥']],
    ['日本', ['东京', '大阪']],
    ['新加坡', ['新加坡']]
  ]);
  let initialized = false;
  const localData = window.IDLocalData;
  let localInventoryVersion = 0;
  let localInventoryState = 'loading';
  let inventorySavePending = false;
  let relayExtractionPending = false;
  let appleRelayState = { parents: [], imports: [], events: [] };

  function inventoryNow() {
    if (!localData) return api.nowText();
    return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ');
  }

  function uid(prefix) {
    return localData ? `${prefix}-${crypto.randomUUID()}` : api.newId(prefix);
  }

  function inventoryDocument() {
    return structuredClone({
      mailboxes,
      accounts,
      batches,
      returnRecords,
      importRecords,
      registrationRecords,
      tableSettings: [...tableSettings],
      undo: [...undo],
      appleRelay: appleRelayState
    });
  }

  function replaceRows(rows, incoming = []) {
    rows.length = 0;
    for (const row of incoming) rows.push(row);
  }

  function applyInventoryDocument(data) {
    inventoryReadIndex = undefined;
    replaceRows(mailboxes, data?.mailboxes);
    replaceRows(accounts, data?.accounts);
    replaceRows(batches, data?.batches);
    replaceRows(returnRecords, data?.returnRecords);
    replaceRows(importRecords, data?.importRecords);
    replaceRows(registrationRecords, data?.registrationRecords);
    appleRelayState = data?.appleRelay || { parents: [], imports: [], events: [] };
    for (const [target, entries] of [
      [tableSettings, data?.tableSettings],
      [undo, data?.undo]
    ]) {
      target.clear();
      for (const [key, value] of entries || []) target.set(key, value);
    }
  }

  function inventoryRoute(route = api.state.route) {
    return /^(mailboxes\/(google|relay|microsoft)|accounts\/(gpt|claude|gemini|grok|apple-balances)|workspace\/(mail-submit|account-submit|mail-extract|account-extract|extractions(?:\/[^/]+)?))$/.test(
      route
    );
  }

  function applyCommittedInventory({ version, data, usageReview: review = [], accountSummaries: summaries, commerceVersion }) {
    if (version < localInventoryVersion) {
      localInventoryState = 'ready';
      return;
    }
    localInventoryVersion = version;
    applyInventoryDocument(data);
    if (Array.isArray(summaries)) {
      accountLifecycleLoaded = true;
      accountSummaries.clear();
      for (const summary of summaries) accountSummaries.set(summary.assetId, summary);
      lifecycleCommerceVersion = commerceVersion;
    }
    usageReview.clear();
    for (const row of review) usageReview.set(row.assetId, row);
    localInventoryState = 'ready';
  }

  let inventoryLoad;
  function readLocalInventory({ keepContent = false } = {}) {
    if (inventoryLoad) return inventoryLoad;
    if (!keepContent) localInventoryState = 'loading';
    inventoryLoad = localData.load('inventory').then(result => {
      applyCommittedInventory(result);
      return true;
    }).catch(() => {
      if (!keepContent) localInventoryState = 'error';
      return false;
    }).finally(() => {
      inventoryLoad = undefined;
      if (inventoryRoute() && !keepContent) {
        saveDrafts();
        api.render();
      }
    });
    return inventoryLoad;
  }

  // A new Google mailbox is an independent insertion. Preserve the freshly
  // loaded document and replay only that insertion after an explicit version
  // rejection; all other inventory operations keep their original conflict flow.
  function rebaseGoogleMailboxCreate(before, after, latest, values) {
    if (values?.['inventory-asset-id'] || values?.['inventory-asset-type'] !== 'google' ||
        !Array.isArray(before?.mailboxes) || !Array.isArray(after?.mailboxes) ||
        !Array.isArray(latest?.mailboxes) || !Array.isArray(latest?.accounts)) return null;
    const originalIds = new Set(before.mailboxes.map(item => item.id));
    const added = after.mailboxes.filter(item => !originalIds.has(item.id));
    if (added.length !== 1 || added[0].type !== 'google' || !added[0].id ||
        !identityKey(added[0]) || identityKey(added[0]) !== String(values['inventory-email'] || '').trim().toLowerCase())
      return null;
    const withoutAdded = { ...after, mailboxes: after.mailboxes.filter(item => item !== added[0]) };
    if (JSON.stringify(withoutAdded) !== JSON.stringify(before)) return null;
    if ([...latest.mailboxes, ...latest.accounts].some(item =>
      item.id === added[0].id || (item.type === 'google' && identityKey(item) === identityKey(added[0]))))
      return { duplicate: true };
    const rebased = structuredClone(latest);
    rebased.mailboxes.unshift(added[0]);
    return { data: rebased };
  }

  async function persistInventory(action, mutate, { relayExtraction = false } = {}) {
    if (localInventoryState !== 'ready' || inventorySavePending) {
      api.notify('库存尚未就绪或仍在保存，请稍候重试');
      return;
    }
    const before = inventoryDocument();
    const route = api.state.route;
    const drawerContent = document.querySelector('#drawer[open]')?.firstElementChild;
    const draftForm = document.querySelector('#drawer[open] form[data-inventory-draft]') ||
      ((action === 'inventory_extract' || !/^workspace\/(mail|account)-(submit|extract)$/.test(route))
        ? document.querySelector('#main form[data-inventory-draft]') : null);
    const draftKey = draftForm?.dataset.inventoryDraft;
    const submittedValues = draftForm ? api.readDraft(draftForm) : null;
    const submittedDraft = submittedValues ? JSON.stringify(submittedValues) : '';
    const actorId = currentActor().id;
    const viewActorId = api.state.actor?.id;
    const sentVersion = localInventoryVersion;
    let after, finish, saved;
    try {
      inventoryReadIndex = undefined;
      finish = mutate();
      if (!finish) return;
      after = inventoryDocument();
    } catch {
      api.notify('库存操作未通过，请重新核对资料');
      return;
    } finally {
      applyInventoryDocument(before);
    }

    inventorySavePending = true;
    const feedback = api.beginActionFeedback?.(null, '正在保存资料…');
    try {
      saved = await localData.save('inventory', localInventoryVersion, after, { action });
      applyCommittedInventory(saved);
      if (saved.appleBalance) api.modules.appleBalance?.applyCommittedBalance?.(saved.appleBalance);
    } catch (error) {
      const versionConflict = (error?.status === 409 || error?.statusCode === 409) &&
        error.message === '库存资料已在其他页面更新，请刷新后重试';
      if (versionConflict && action === 'inventory_create' &&
          submittedValues?.['inventory-asset-type'] === 'google' && !submittedValues?.['inventory-asset-id']) {
        const refreshed = await readLocalInventory({ keepContent: true });
        const unchanged = refreshed && localInventoryVersion > sentVersion && currentActor().id === actorId &&
          api.state.actor?.id === viewActorId &&
          api.state.route === route && document.querySelector('#drawer[open]')?.firstElementChild === drawerContent &&
          draftForm?.isConnected && JSON.stringify(api.readDraft(draftForm)) === submittedDraft;
        const rebased = unchanged ? rebaseGoogleMailboxCreate(before, after, inventoryDocument(), submittedValues) : null;
        if (rebased?.data) {
          try {
            saved = await localData.save('inventory', localInventoryVersion, rebased.data, { action });
            applyCommittedInventory(saved);
          } catch (retryError) {
            const rejected = retryError?.status === 409 || retryError?.statusCode === 409;
            await readLocalInventory({ keepContent: true });
            saveDrafts();
            api.notify(rejected
              ? '库存再次变化，本次未保存，输入已保留，请重新核对后重试'
              : '保存结果尚未确认，输入已保留，请先核对已有邮箱再重试');
            return;
          }
        } else {
          saveDrafts();
          api.notify(!refreshed
            ? '最新库存读取失败，输入已保留，请稍后重试'
            : rebased?.duplicate
              ? '相同的谷歌邮箱已存在，输入已保留，请先核对已有资料'
              : '库存或输入已变化，输入已保留，请重新核对后重试');
          return;
        }
      } else if (error?.status === 409 || error?.statusCode === 409) {
        await readLocalInventory();
        api.notify(
          localInventoryState === 'ready'
            ? relayExtraction
              ? '隐藏邮箱提取资格或库存已变化，本次未保存，请重新核对'
              : error.message || '库存已刷新，请重新打开并核对'
            : '其他操作已更新库存，本次未保存。重新读取库存失败，请重试'
        );
        return;
      } else {
        api.notify(
          relayExtraction && error?.status === 503
            ? '隐藏邮箱服务暂不可用，本次未提取，请稍后重试'
            : '本次操作未保存，请检查本机服务后重试'
        );
        return;
      }
    } finally {
      feedback?.finish();
      inventorySavePending = false;
    }

    if (
      api.state.route === route &&
      document.querySelector('#drawer[open]')?.firstElementChild === drawerContent &&
      (!draftForm || (draftForm.isConnected && JSON.stringify(api.readDraft(draftForm)) === submittedDraft))
    ) {
      if (draftKey) {
        api.state.drafts.delete(draftKey);
        draftForm.removeAttribute('data-inventory-draft');
      }
      api.completeAction ? api.completeAction(finish, '资料变更已保存') : finish();
    } else {
      saveDrafts();
      if (draftKey && JSON.stringify(api.state.drafts.get(draftKey)) === submittedDraft)
        api.state.drafts.delete(draftKey);
      const submittedId = submittedValues?.['inventory-asset-id'];
      const committedAsset = action === 'inventory_edit' && submittedId
        ? [...(saved.data?.mailboxes || []), ...(saved.data?.accounts || [])].find(
            asset => asset.id === submittedId && asset.type === submittedValues['inventory-asset-type']
          )
        : null;
      if (committedAsset && Number(committedAsset.version) > Number(submittedValues['inventory-version'])) {
        // Advance only the original version acknowledged by this save, never an arbitrary refreshed record.
        const matchesOriginal = values => values &&
          values['inventory-asset-id'] === submittedId &&
          values['inventory-asset-type'] === submittedValues['inventory-asset-type'] &&
          String(values['inventory-version']) === String(submittedValues['inventory-version']);
        const remaining = api.state.drafts.get(draftKey);
        if (matchesOriginal(remaining))
          api.state.drafts.set(draftKey, { ...remaining, 'inventory-version': String(committedAsset.version) });
        const currentForm = document.querySelector('#drawer[open] form[data-inventory-draft]');
        if (currentForm?.dataset.inventoryDraft === draftKey && matchesOriginal(api.readDraft(currentForm))) {
          const versionControl = currentForm.elements.namedItem('inventory-version');
          if (versionControl) versionControl.value = String(committedAsset.version);
        }
      }
      if (inventoryRoute()) api.render();
      api.notify('本次提交已保存，后续填写的内容已保留');
    }
    return true;
  }

  const inventoryActionCodes = {
    确认修改资料: 'inventory_edit',
    确认新增资料: 'inventory_create',
    确认提取: 'inventory_extract',
    确认归还: 'inventory_return',
    确认实际使用: 'inventory_use',
    确认批量导入: 'inventory_import',
    确认账号状态变化: 'inventory_health_change',
    撤回最近资料修改: 'inventory_undo',
    '永久删除 1 条库存资料': 'inventory_delete',
    确认本表设置: 'inventory_table_settings',
    确认登记注册结果: 'inventory_registration_result'
  };

  function confirmInventoryChange(title, detail, mutate, label, options) {
    const confirmedVersion = localInventoryVersion;
    api.confirmAction(
      title,
      detail,
      () => {
        if (!localData) {
          inventoryReadIndex = undefined;
          const finish = mutate();
          inventoryReadIndex = undefined;
          finish?.();
          return;
        }
        if (confirmedVersion !== localInventoryVersion) {
          api.notify('确认期间库存已变化，请重新打开并核对');
          return;
        }
        void persistInventory(inventoryActionCodes[title], mutate, options);
      },
      label
    );
  }

  function copyAssetLine(asset) {
    if (asset.type === 'microsoft') return asset.email;
    return `${displayIdentity(asset)}\t${asset.type === 'relay' ? asset.queryCode || '' : asset.password || ''}`;
  }
  function currentActor() {
    return (
      localData?.actor?.() ||
      (localData
        ? { id: 'local-operator', name: '本机操作员', role: 'admin' }
        : api.state.actor || { id: 'demo-lin', name: '林管理员', role: 'admin' })
    );
  }
  function admin() {
    return ['admin', 'super'].includes(currentActor().role);
  }
  function microsoftEntryAllowed(route = api.state.route) {
    return (!localData || admin()) &&
      [microsoftMailboxRoute, 'workspace/mail-extract', 'workspace/mail-submit'].includes(route);
  }
  function types() {
    return api.modules.operations?.getMailboxTypes?.() || baseTypes;
  }
  function enabledTypes() {
    return types()
      .filter((type) => type.enabled !== false && type.id !== 'microsoft')
      .map((type) => [type.id, type.label]);
  }
  function canExtractLocalRelay() {
    return Boolean(localData?.authRequired && admin() && localData.relay);
  }
  function mailboxWorkflowTypes(extraction = false) {
    return enabledTypes().filter(
      ([id]) =>
        id !== 'apple' && (id !== 'relay' || !localData || (extraction && canExtractLocalRelay()))
    );
  }
  function mailboxSubmissionTypes() {
    const choices = enabledTypes().filter(([id]) => id !== 'apple' && (id !== 'relay' || !localData || (admin() && localData.relay)));
    if (microsoftEntryAllowed()) choices.push(['microsoft', typeLabel('microsoft')]);
    return choices;
  }
  function phoneCodeUrl(value) {
    try {
      const url = new URL(String(value || '').trim());
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
    } catch { return ''; }
  }
  function phoneValue(value) {
    const url = phoneCodeUrl(value);
    return url ? `<a class="table-value-button" href="${esc(url)}" target="_blank" rel="noopener noreferrer nofollow">打开验证码</a>` : esc(value || '—');
  }
  function choiceLabel(choices, value, fallback = '未记录') {
    return choices.find(([key]) => key === value)?.[1] ?? fallback;
  }
  function microsoftRecoveryLabel(asset) {
    if (!asset.auxiliary) return '未绑定';
    const security = asset.microsoftSecurity;
    if (security?.recoveryAccess === 'inventory' &&
        !microsoftRecoveryMailbox(asset)) return '需核对关联';
    return choiceLabel(microsoftRecoveryOptions, security?.recoveryAccess, '未核验');
  }
  function microsoftRecoveryMailbox(asset) {
    const recoveryId = asset.microsoftSecurity?.recoveryMailboxId;
    const mailbox = recoveryId && assetById(recoveryId);
    return mailbox && ['google', 'relay', 'microsoft'].includes(mailbox.type) && !isAccount(mailbox) && !mailbox.relayDeleted &&
      mailbox.email.trim().toLowerCase() === asset.auxiliary?.trim().toLowerCase() ? mailbox : null;
  }
  function microsoftVerificationLabel(asset) {
    return (asset.microsoftSecurity?.verificationMethods || [])
      .map((method) => choiceLabel(microsoftVerificationOptions, method))
      .join('、') || '未记录';
  }
  function readMicrosoftSecurity(values, {
    loginMode = 'password', recoveryAccess = 'unknown', twoStep = 'unknown',
    verificationMethods = [], verificationDevice = ''
  } = {}) {
    const email = values.email.trim().toLowerCase();
    const auxiliary = (values.auxiliary || '').trim().toLowerCase();
    if (email.length > 254) throw new Error('邮箱地址最多 254 个字符', { cause: 'inventory-email' });
    if (values.source?.length > 200) throw new Error('来源渠道最多 200 个字符', { cause: 'inventory-source' });
    for (const [key, label] of [['password', '登录密码'], ['phone', '绑定手机号'], ['totp', '2FA 密钥'], ['appPassword', '应用专用密码']]) {
      if (values[key]?.length > 4096) throw new Error(`${label}超过长度限制`, { cause: `inventory-${key}` });
    }
    if (!microsoftLoginModes.some(([key]) => key === loginMode) ||
        !microsoftRecoveryOptions.some(([key]) => key === recoveryAccess) ||
        !microsoftTwoStepOptions.some(([key]) => key === twoStep) ||
        new Set(verificationMethods).size !== verificationMethods.length ||
        verificationMethods.some((method) => !microsoftVerificationOptions.some(([key]) => key === method))) {
      throw new Error('请核对登录方式、取码方式、两步验证和验证方式');
    }
    if (loginMode === 'password' && !values.password?.trim()) {
      throw new Error('密码登录必须填写登录密码', { cause: 'inventory-password' });
    }
    if (loginMode === 'passwordless' && values.password) {
      throw new Error('无密码登录请清空登录密码', { cause: 'inventory-password' });
    }
    if (loginMode === 'passwordless' && !verificationMethods.length) {
      throw new Error('无密码登录请选择实际使用的验证方式');
    }
    if (auxiliary && (auxiliary.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(auxiliary) || auxiliary === email)) {
      throw new Error('辅助邮箱必须是不同于当前账号的有效地址', { cause: 'inventory-auxiliary' });
    }
    if (!auxiliary && (recoveryAccess !== 'unknown' || verificationMethods.includes('email'))) {
      throw new Error('请填写已绑定的辅助邮箱，再登记取码或邮箱验证方式', { cause: 'inventory-auxiliary' });
    }
    if (values.totp && !verificationMethods.includes('totp')) throw new Error('填写 2FA 密钥时请选择动态验证码');
    if (verificationDevice.length > 200) throw new Error('验证设备最多 200 个字符', { cause: 'inventory-microsoft-device' });
    let recoveryMailboxId;
    if (recoveryAccess === 'inventory') {
      const matches = allAssets().filter((row) => ['google', 'relay', 'microsoft'].includes(row.type) &&
        !isAccount(row) && !row.relayDeleted &&
        row.email.trim().toLowerCase() === auxiliary);
      if (matches.length !== 1) throw new Error('辅助邮箱须唯一对应一条可查看的邮箱库存资料', { cause: 'inventory-auxiliary' });
      recoveryMailboxId = matches[0].id;
    }
    return {
      loginMode, recoveryAccess, twoStep, verificationDevice,
      verificationMethods: microsoftVerificationOptions.map(([key]) => key).filter((key) => verificationMethods.includes(key)),
      ...(recoveryMailboxId ? { recoveryMailboxId } : {})
    };
  }
  function fundingAppleRoute() {
    return ['accounts/apple-balances', 'mailboxes/apple'].includes(api.state.route);
  }
  function accountSubmissionRoute() {
    return ['workspace/account-submit', 'workspace/account-extract'].includes(api.state.route);
  }
  function accountEntryType(type) {
    return accountSubmissionTypes.some(([id]) => id === type);
  }
  function accountAssetKey(type) {
    return `inventory-edit:account-submit:new:${type}`;
  }
  function accountImportKey(type) {
    return `inventory-import:account-submit:${type}`;
  }
  function formFingerprint(values) {
    return JSON.stringify(
      Object.entries(values)
        .filter(
          ([key]) => !['inventory-import-preview-source', 'inventory-import-file'].includes(key)
        )
        .sort(([a], [b]) => a.localeCompare(b))
    );
  }
  function typeLabel(id) {
    return (
      types().find((type) => type.id === id)?.label ||
      { gpt: 'GPT 账号', claude: 'Claude 账号', gemini: 'Gemini 账号', grok: 'Grok 账号', apple: '苹果 ID', mixed: '混合资料' }[id] ||
      id
    );
  }
  function accountEmailType(asset) {
    return (
      types().find((type) => type.id === asset.emailType || type.label === asset.emailType)
        ?.label || '未记录'
    );
  }
  function accountKyc(asset) {
    if (accountSummaries.get(asset.id)?.latestKyc) return 'KYC 认证（历史）';
    if (asset.kyc === true || ['KYC 认证', 'KYC认证'].includes(asset.kyc)) return 'KYC 认证';
    if (asset.kyc === false || asset.kyc === '未认证') return '未认证';
    return '未记录';
  }
  function healthChangeTime(asset) {
    const label = asset.health === 'dead' ? '死号' : '解封中';
    const event = [...(asset.inventoryHistory || [])]
      .reverse()
      .find(
        (entry) =>
          (entry.action === '健康状态变化' && entry.detail === asset.health) ||
          (entry.action === '归还' && String(entry.detail || '').endsWith(` · ${label}`))
      );
    return event?.time || asset.healthChangedAt || '历史未记录';
  }
  function inventoryListTime(asset, tab) {
    const recorded = [asset.createdAt, asset.importedAt, asset.registered];
    if (tab === 'claimed') return [asset.claimedAt, ...recorded];
    if (tab === 'used') return [asset.actualUsedAt, asset.claudeHistory?.start, asset.usedAt, ...recorded];
    if (tab === 'dead' || tab === 'unlocking') return [healthChangeTime(asset), ...recorded];
    return recorded;
  }
  function wide(label, id, control, required = false, help = '') {
    return field(label, id, control, required, help).replace(
      'class="field"',
      'class="field form-field-wide"'
    );
  }
  function area(id, value = '', placeholder = '', rows = 3) {
    return `<textarea id="${id}" name="${id}" rows="${rows}" placeholder="${esc(placeholder)}">${esc(value)}</textarea>`;
  }
  function normalize(asset) {
    if (!asset.inventoryState) asset.inventoryState = asset.used ? 'used' : 'available';
    if (!asset.inventoryHistory) asset.inventoryHistory = [];
    if (!asset.usageLinks) asset.usageLinks = [];
    if (!asset.version) asset.version = 1;
    if (!asset.createdAt && asset.importedAt) asset.createdAt = asset.importedAt;
    if (!asset.health) asset.health = 'normal';
    if (!asset.status) asset.status = '正常';
    asset.used = asset.inventoryState !== 'available';
    return asset;
  }
  function allAssets() {
    return [...mailboxes, ...accounts]
      .filter((asset) => !localData || asset.type !== 'relay' || canExtractLocalRelay())
      .map(normalize);
  }
  function assetById(id) {
    return allAssets().find((asset) => asset.id === id);
  }
  function isAccount(asset) {
    return accounts.includes(asset);
  }
  function collection(kind) {
    return kind === 'account' ? accounts : mailboxes;
  }
  function age(asset) {
    const date = registrationInstant(registrationTime(asset));
    const now = Date.parse(inventoryNow().replace(' ', 'T') + ':00+08:00');
    return Number.isFinite(date) && date <= now ? Math.floor((now - date) / 3600000) : null;
  }
  function registrationTime(asset) {
    return String(asset.registered || '').trim() ||
      (asset.claudeHistory ? '' : asset.createdAt || asset.importedAt || '');
  }
  function registrationInstant(value) {
    const text = String(value || '').trim().replace(' ', 'T');
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return Date.parse(`${text}T00:00+08:00`);
    if (/T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(text)) return Date.parse(`${text}+08:00`);
    return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? Date.parse(text) : NaN;
  }
  function registrationInput(asset) {
    const instant = registrationInstant(registrationTime(asset));
    return Number.isFinite(instant)
      ? new Date(instant + 8 * 60 * 60 * 1000).toISOString().slice(0, 16)
      : '';
  }
  function parseRegistrationProxy(link, selected = '') {
    let raw = link.trim();
    const scheme = /^([a-z][a-z\d+.-]*):\/\//i.exec(raw)?.[1].toLowerCase();
    const proxyProtocol = selected || scheme;
    if (!Object.hasOwn(proxyDefaults, proxyProtocol)) throw new Error('请先选择有效的代理协议');
    if (scheme && scheme !== proxyProtocol) throw new Error('链接协议与所选代理协议不一致');
    try {
      const parts = !scheme && !raw.includes('@') && /^(\[[^\]]+\]|[^:/@]+):(\d+):([^:]*):(.*)$/.exec(raw);
      if (parts) raw = `${encodeURIComponent(parts[3])}:${encodeURIComponent(parts[4])}@${parts[1]}:${parts[2]}`;
      const proxyUrl = scheme ? raw : `${proxyProtocol}://${raw}`;
      const parsed = new URL(proxyUrl);
      if (/\s/.test(raw) || !parsed.hostname || parsed.port === '0' ||
          (parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash)
        throw new Error();
      return {
        proxyUrl,
        proxyProtocol,
        proxyHost: parsed.hostname,
        proxyPort: parsed.port || proxyDefaults[proxyProtocol],
        proxyUser: decodeURIComponent(parsed.username),
        proxyPassword: decodeURIComponent(parsed.password)
      };
    } catch {
      throw new Error('代理链接格式无效，请检查主机、端口和凭据');
    }
  }
  function ageLabel(asset) {
    const hours = age(asset);
    return hours === null ? '养号无法判定' : `${hours} 小时`;
  }
  function mailboxSuggestion(email) {
    const domain =
      String(email || '')
        .trim()
        .toLowerCase()
        .split('@')[1] || '';
    if (['gmail.com', 'googlemail.com'].includes(domain))
      return '地址像谷歌邮箱，也可能用于 Apple ID；以人工确认的资料类型为准。';
    if (['icloud.com', 'me.com', 'mac.com'].includes(domain))
      return '地址像苹果邮箱；是否为 Apple ID 或隐藏邮箱仍需人工确认。';
    if (domain === 'privaterelay.appleid.com')
      return '地址像苹果隐藏邮箱；仍以人工确认的资料类型为准。';
    return '地址无法确定业务类型；Apple ID 可以使用 Gmail 等邮箱地址。';
  }
  function personalCustomerOwned(asset) {
    return personalAccount(asset.type) && (asset.source === '客户提供' || ['客户自有', 'customer'].includes(asset.accountSource));
  }
  function personalDeliveryPending(asset) {
    return personalAccount(asset.type) && (accountSummaries.get(asset.id)?.label === '已保留待核对' ||
      api.modules.commerce?.hasPendingPersonalDelivery?.(asset.id));
  }
  const historicallyOpened = asset => asset.type === 'claude' && asset.claudeHistory?.phase === 'opened';
  const displayInventoryState = asset => historicallyOpened(asset) ? 'used' : asset.inventoryState;
  const acquisitionChoices = [['self_registered', '自己邮箱注册'], ['purchased', '网上购买']];
  const acquisitionLabel = value => acquisitionChoices.find(([id]) => id === value)?.[1] || '未登记';
  const mailHealth = asset => ({ dead: '死号', unlocking: '解封中' }[asset.health] || asset.status || '未登记');
  const mailUse = asset => asset.type === 'microsoft' && asset.inventoryState === 'available'
    ? asset.mailboxUsage || 'unknown' : displayInventoryState(asset);
  const mailUseLabels = { available: '未使用', claimed: '已提取', used: '已使用', unknown: '未登记' };
  const claudeAgingHours = () => settingsFor('claude').hours ?? 72;
  function claudeReadiness(asset) {
    if (asset.health === 'dead') return tag('死号', 'warning');
    if (historicallyOpened(asset)) return tag('历史已开通', 'success');
    if (asset.health !== 'normal' || asset.status !== '正常' || usageReview.has(asset.id)) return tag('资料待核对', 'warning');
    if (asset.inventoryState === 'used') return tag('已使用', 'success');
    if (asset.inventoryState === 'claimed') return tag('已提取', 'warning');
    const hours = age(asset);
    if (hours === null) return tag('注册时间待核对', 'warning');
    return hours >= claudeAgingHours() ? tag('可使用', 'success') : tag('养号中', 'warning');
  }
  function available(asset, forDelivery = false) {
    normalize(asset);
    if (historicallyOpened(asset) || personalCustomerOwned(asset) ||
        (!forDelivery && personalDeliveryPending(asset))) return false;
    if (asset.type === 'relay' && (localData || !api.modules.appleRelay?.isAvailable(asset)))
      return false;
    return (
      asset.inventoryState === 'available' &&
      !usageReview.has(asset.id) &&
      asset.health === 'normal' &&
      asset.status === '正常' &&
      (asset.type !== 'claude' || (age(asset) !== null && age(asset) >= claudeAgingHours()))
    );
  }
  function availableForDelivery(asset) {
    if (historicallyOpened(asset) || personalCustomerOwned(asset)) return false;
    if (available(asset, true)) return true;
    const claim = pendingClaim(asset);
    return asset.inventoryState === 'claimed' && claim?.batch.kind === 'account' &&
      claim.item.assetId === asset.id && claim.batch.id === asset.claimBatchId &&
      claim.batch.actorId === currentActor().id &&
      (!claim.batch.purpose || ['客户交付', '业务备用'].includes(claim.batch.purpose)) &&
      asset.health === 'normal' && asset.status === '正常' &&
      (asset.type !== 'claude' || (age(asset) ?? -1) >= claudeAgingHours()) &&
      !returnBlock(asset, claim.batch, claim.item, true) && !claim.item.orderId;
  }
  const usesRegistrationCity = type => type === 'claude';
  function usesAccountLocation(type) {
    return type === 'gpt' || type === 'claude';
  }
  function personalSourceMailboxes(type) {
    return allAssets().filter(row => {
      if (!['google', 'relay'].includes(row.type) || row.relayDeleted || row.health !== 'normal' ||
        row.status !== '正常' || usageReview.has(row.id) || row.usageLinks.length) return false;
      if (type === 'gemini' && row.type !== 'google') return false;
      if (row.type === 'google' && row.inventoryState === 'available') return true;
      if (row.inventoryState !== 'claimed') return false;
      const claim = pendingClaim(row);
      if (!claim || claim.batch.kind !== 'mail' || claim.batch.actorId !== currentActor().id ||
          claim.item.taskId || claim.item.orderId || claim.item.registrationId) return false;
      const purpose = registrationProduct(/^注册\s*(.+)$/.exec(claim.batch.purpose || '')?.[1]);
      return !stockType(purpose) || purpose === type;
    });
  }
  function personalAccountError(row) {
    if (row.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) return '邮箱格式不正确';
    if (row.type === 'gemini') return row.email ? '' : '请填写实际 Google 账号邮箱';
    if (!grokLoginOptions.some(([id]) => id === row.loginMethod) ||
        (row.loginMethod === 'x' ? !row.xHandle : !row.email)) return '请按登录方式填写邮箱或 X @账号';
    if (row.xHandle && !/^@[a-z0-9_]{1,15}$/i.test(row.xHandle)) return 'X @账号格式不正确';
    if (row.xLinkState === 'linked' && !row.xHandle) return '已绑定时请填写 X @账号';
    return '';
  }
  function settingsFor(type) {
    if (!tableSettings.has(type))
      tableSettings.set(type, {
        countries: ['马来西亚', '美国', '日本', '新加坡'],
        sources: ['自己注册', '线上购买', '客户提供'],
        hours: 72
      });
    return tableSettings.get(type);
  }
  function mailExtractionPurposes(type) {
    const values = tableSettings.get(mailExtractionSettingsKey)?.purposes;
    const choices = Array.isArray(values) ? values : defaultMailPurposes;
    return type === 'relay' ? choices.filter(purpose => !/^注册\s*Gemini$/i.test(purpose)) : choices;
  }
  function openMailPurposeSettings(reset = false) {
    if (api.state.route !== 'workspace/mail-extract') return;
    saveDrafts();
    const key = 'inventory-purpose-settings:mail';
    if (reset) api.state.drafts.delete(key);
    const saved = api.state.drafts.get(key) || {};
    showDrawer(
      '邮箱提取用途设置',
      '添加或移除后仅影响邮箱提取的后续选择，历史批次保留原用途。至少保留一个用途。',
      `<form id="inventory-purpose-settings-form" data-inventory-draft="${key}" novalidate><input type="hidden" name="inventory-purpose-settings-version" value="${esc(saved['inventory-purpose-settings-version'] ?? localInventoryVersion)}" />${api.optionListEditor({ id: 'inventory-mail-purposes', label: '提取用途', itemLabel: '用途', values: mailExtractionPurposes(), minItems: 1, draft: saved })}</form>`,
      button('重新读取', 'inventory-purpose-settings-reload', '', 'return') + button('取消', 'inventory-close') +
        '<button class="button primary" form="inventory-purpose-settings-form" type="submit">保存设置</button>',
      key
    );
  }
  function choicesWithCurrent(choices, current) {
    return current &&
      !choices.some((choice) => (Array.isArray(choice) ? choice[0] : choice) === current)
      ? [...choices, [current, `${current}（已有值）`]]
      : choices;
  }
  function log(asset, action, detail = '') {
    const actor = currentActor(),
      time = inventoryNow();
    asset.version++;
    asset.lastOperatedById = actor.id;
    asset.lastOperatedBy = actor.name;
    asset.lastOperatedAt = time;
    asset.inventoryHistory.push({
      id: uid('asset-event'),
      action,
      detail,
      actorId: actor.id,
      actor: actor.name,
      time
    });
  }
  function claimById(id) {
    for (const batch of batches) {
      const item = batch.items.find((entry) => entry.id === id);
      if (item) return { batch, item };
    }
    return null;
  }
  function pendingClaim(asset) {
    return asset.claimId ? claimById(asset.claimId) : null;
  }
  function mailboxClaim(asset) {
    const claim = pendingClaim(asset);
    if (!claim || claim.batch.kind !== 'mail' || claim.item.assetId !== asset.id) return null;
    return { id: claim.batch.id, label: extractionBatchNumbers().get(claim.batch.id) || claim.batch.id };
  }
  function itemLabel(item) {
    return (
      { pending: '待使用', used: '已使用', returned: '已归还', abnormal: '异常归还' }[
        item.status
      ] || '待核对'
    );
  }
  function itemTag(item) {
    const detected = item.status === 'pending' && usageReview.get(item.assetId);
    if (detected) return tag(detected.status === 'used' ? '检测到已使用' : '待核对', 'warning');
    return tag(
      itemLabel(item),
      item.status === 'used' ? 'success' : item.status === 'pending' ? 'warning' : ''
    );
  }
  function batchCounts(batch) {
    return {
      pending: batch.items.filter((item) => item.status === 'pending').length,
      used: batch.items.filter((item) => item.status === 'used').length,
      returned: batch.items.filter((item) => ['returned', 'abnormal'].includes(item.status)).length,
      returnable: batch.items.filter(item => !returnBlock(assetById(item.assetId), batch, item)).length
    };
  }
  function ownerAllowed(batch) {
    return admin() || batch.actorId === currentActor().id;
  }
  function returnBlock(asset, batch, item, forDelivery = false) {
    if (!asset) return '原资料不存在或无查看权限';
    if (!forDelivery && personalDeliveryPending(asset)) return '已有成品订单待核对';
    normalize(asset);
    if (batch && !ownerAllowed(batch)) return '只能归还本人领用资料';
    if (item && ['returned', 'abnormal'].includes(item.status)) return '本次领用已归还';
    if (item?.status === 'used') return '本次领用已实际使用';
    if (item && asset.claimId !== item.id)
      return '原领用已结束或已被其他批次重新提取，无有效归还资格';
    if (asset.inventoryState === 'used' || (asset.usageLinks.length && asset.accountLifecycle?.disposition !== 'recovered'))
      return `已使用 · ${asset.usageLinks.at(-1)?.label || '已有使用记录'}`;
    const detected = usageReview.get(asset.id);
    if (detected) return `${detected.status === 'used' ? '已使用' : '待核对'} · ${detected.message}`;
    const claim = pendingClaim(asset);
    if (!claim || claim.item.status !== 'pending') return '没有可归还的有效领用记录';
    if (claim.item.taskId || claim.item.registrationId || claim.item.orderId || reservations.has(asset.id))
      return '已关联任务或结果待核对，请先核实原任务';
    return '';
  }
  function createBatch(
    kind,
    chosen,
    purpose,
    notes = '',
    actor = currentActor(),
    time = inventoryNow()
  ) {
    const batch = {
      id: uid(kind === 'mail' ? 'MAIL' : 'ACCOUNT'),
      kind,
      purpose,
      notes,
      actorId: actor.id,
      actorName: actor.name,
      time,
      items: []
    };
    for (const asset of chosen) {
      normalize(asset);
      const item = {
        id: uid('claim'),
        assetId: asset.id,
        email: asset.email,
        type: asset.type,
        ...(personalAccount(asset.type) && { loginMethod: asset.loginMethod, xHandle: asset.xHandle || '' }),
        ...(asset.type === 'relay' ? { parentMailboxId: asset.parentMailboxId } : {}),
        status: 'pending',
        claimedAt: time,
        usedAt: '',
        returnedAt: '',
        reason: '',
        notes,
        taskId: '',
        orderId: '',
        registrationId: ''
      };
      batch.items.push(item);
      asset.inventoryState = 'claimed';
      asset.used = true;
      asset.claimId = item.id;
      asset.claimBatchId = batch.id;
      asset.purpose = purpose;
      asset.claimedAt = time;
      asset.extractionNotes = notes;
      log(asset, '提取', `${batch.id} · ${purpose}`);
    }
    batches.unshift(batch);
    return batch;
  }
  function consume(asset, claim, link) {
    normalize(asset);
    if (asset.inventoryState === 'used')
      return { ok: false, message: '资料已经实际使用，不能再次通用领用' };
    asset.inventoryState = 'used';
    asset.used = true;
    asset.actualUsedAt = inventoryNow();
    asset.usageLinks.push({
      ...link, time: asset.actualUsedAt,
      ...(claim && { claimId: claim.id, batchId: asset.claimBatchId })
    });
    if (claim) {
      claim.status = 'used';
      claim.usedAt = inventoryNow();
      claim.orderId = link.orderId || '';
    }
    log(asset, '确认使用', link.label || link.taskId || link.accountId || '已登记使用结果');
    return { ok: true };
  }
  function initialize() {
    if (initialized) return;
    initialized = true;
    if (localData) {
      applyInventoryDocument(null);
      void readLocalInventory();
      return;
    }
    if (!mailboxes.some((asset) => asset.id === 'apple-funding-demo-1'))
      mailboxes.unshift({
        id: 'apple-funding-demo-1',
        type: 'apple',
        email: 'apple.demo@example.test',
        password: 'Demo-Apple-Only',
        country: '美国',
        status: '正常',
        health: 'normal',
        source: '演示期初资料',
        registered: '2026-10-01T10:30',
        createdAt: '2026-11-03 10:30',
        phone: '',
        notes: '虚构 Apple ID；余额模块期初为 250 USD，不代表真实余额。',
        version: 1,
        inventoryState: 'available',
        used: false,
        inventoryHistory: [],
        usageLinks: []
      });
    allAssets();
    mailboxes
      .filter((asset) => asset.type === 'relay')
      .filter((asset) => /^mail-(27|28|29|30|31|32)$/.test(asset.id))
      .forEach((asset) => {
        const index = Number(asset.id.slice(5)) - 27;
        asset.parentMailboxId ||= `parent-demo-${(index % 2) + 1}`;
        asset.aliasId ||= `alias-demo-${index + 1}`;
        asset.queryCode ||= `DEMO-QUERY-${index + 1}`;
        asset.queryExpiry ||= '2026-12-03 10:30';
      });
    const chosen = mailboxes
      .filter((asset) => asset.type === 'google' && available(asset))
      .slice(0, 10);
    if (chosen.length) {
      const batch = createBatch(
        'mail',
        chosen,
        '注册 Claude',
        '昨天领取，七条已登记使用，三条等待处理',
        currentActor(),
        '2026-11-02 10:00'
      );
      chosen.slice(0, 7).forEach((asset, index) => {
        consume(asset, batch.items[index], {
          kind: 'manual-registration',
          accountId: `historical-demo-${index + 1}`,
          label: '已关联历史 Claude 注册结果'
        });
        batch.items[index].usedAt = '2026-11-02 11:00';
      });
    }
    importRecords.push({
      id: 'IMPORT-DEMO-001',
      type: 'google',
      time: '2026-11-01 09:00',
      actor: '林管理员',
      total: 20,
      success: 20,
      failed: 0,
      status: '已导入',
      results: []
    });
  }
  function view() {
    const route = api.state.route;
    if (!views.has(route))
      views.set(route, {
        tab: route.startsWith('mailboxes/') ? 'all' : 'available',
        query: '',
        country: '',
        status: '',
        usage: '',
        centerTab: 'pending',
        quickText: ''
      });
    return views.get(route);
  }
  function draft(key, defaults = {}) {
    return { ...defaults, ...(api.state.drafts.get(key) || {}) };
  }
  function saveDrafts() {
    for (const form of document.querySelectorAll(
      '#main form[data-inventory-draft], #drawer[open] form[data-inventory-draft]'
    )) {
      let values = api.readDraft(form);
      const type = values['inventory-settings-type'];
      if (form.id === 'inventory-settings-form' && usesRegistrationCity(type)) {
        const group = form.querySelector?.('#inventory-settings-city-groups');
        if (group) {
          const countries = settingsCountries(values, settingsFor(type));
          const countryList = JSON.stringify(countries);
          if (group.dataset.countries !== countryList) {
            group.innerHTML = accountCityEditors(type, countries, values);
            group.dataset.countries = countryList;
            values = api.readDraft(form);
          }
        }
      }
      api.state.drafts.set(form.dataset.inventoryDraft, values);
    }
  }
  function finishDrawer(key) {
    if (key) api.state.drafts.delete(key);
    document.querySelector('#drawer')?.close();
    api.state.drawerContext = '';
  }
  function showDrawer(title, description, body, footer = '', context = '') {
    api.openDrawer(title, description, body, footer, context);
  }

  function inventoryPage() {
    const kind = api.state.route.startsWith('accounts/') ? 'account' : 'mail';
    const type = api.state.route.split('/')[1];
    const microsoft = type === 'microsoft';
    const canManage = (!microsoft && !personalAccount(type)) || !localData || admin();
    const v = view();
    const assets = collection(kind)
      .map(normalize)
      .filter((asset) => asset.type === type);
    const useState = kind === 'mail' ? mailUse : displayInventoryState;
    const counts = {
      available: assets.filter(asset => useState(asset) === 'available' && asset.health === 'normal').length,
      claimed: assets.filter(asset => useState(asset) === 'claimed' && asset.health === 'normal').length,
      used: assets.filter(asset => useState(asset) === 'used').length,
      dead: assets.filter((asset) => asset.health === 'dead').length,
      unlocking: assets.filter((asset) => asset.health === 'unlocking').length
    };
    const title = typeLabel(type);
    const actions = canManage ?
      (microsoft ? '' : usageReviewButton()) + button('本表设置', 'inventory-settings', '', 'settings') +
      (type === 'claude' && localData && admin() ? button('历史账号入库', 'inventory-claude-history', '', 'upload') : '') +
      button('批量导入', 'inventory-import', '', 'upload') +
      button(kind === 'account' ? '新增账号' : '新增邮箱', 'inventory-add', 'primary', 'plus') : '';
    let body;
    if (v.tab === 'imports') body = importList(type);
    else if (v.tab === 'registrations') body = registrationList();
    else {
      const rows = assets.filter(
        (asset) =>
          (v.tab === 'all' || (['dead', 'unlocking'].includes(v.tab)
            ? asset.health === v.tab
            : (v.tab === 'used' || asset.health === 'normal') &&
              useState(asset) === v.tab)) &&
          (!v.query ||
            `${displayIdentity(asset)} ${asset.email || ''} ${asset.notes || ''} ${asset.purpose || ''} ${kind === 'mail' ? mailboxPlatformLabel(asset) : ''} ${microsoft ? asset.auxiliary || '' : ''}`
              .toLowerCase()
              .includes(v.query.toLowerCase())) &&
          (!v.country || asset.country === v.country) &&
          (!v.status || (kind === 'mail' ? mailHealth(asset) : asset.status) === v.status) &&
          (kind !== 'mail' || !v.usage || mailUse(asset) === v.usage)
      );
      const totpColumn = {
        id: 'totp', label: '2FA 密钥', class: 'mono wide-cell', long: true,
        render: (asset) => esc(asset.totp || '未录入')
      };
      const appPasswordColumn = {
        id: 'appPassword', label: '应用专用密码', class: 'mono wide-cell', long: true,
        render: (asset) => esc(asset.appPassword || '未录入')
      };
      const columns = [
        ...(kind === 'account' && !personalAccount(type)
          ? [
              {
                id: 'emailType',
                label: '邮箱类型',
                render: (asset) => esc(accountEmailType(asset))
              }
            ]
          : []),
        {
          id: 'email',
          label: personalAccount(type) ? '账号标识' : kind === 'account' ? '账号 / 邮箱' : '邮箱账号',
          class: 'email-cell',
          render: (asset) =>
            textAction(displayIdentity(asset), 'inventory-detail', `data-id="${esc(asset.id)}" data-table-value-preview`, 'table-value-ellipsis')
        },
        ...(kind === 'account' && type !== 'apple' ? [{ id: 'acquisitionMethod', label: '账号来源',
          render: asset => esc(acquisitionLabel(asset.acquisitionMethod)) }] : []),
        ...(mailboxType(type) ? [{ id: 'registrationPlatform', label: '注册平台',
          render: asset => esc(mailboxPlatformLabel(asset)) }] : []),
        ...(type === 'claude' && assets.some(asset => asset.claudeHistory) ? [
          { id: 'claudeHistoryState', label: '历史登记状态', render: asset => esc(claudeHistoryStates[asset.claudeHistory?.phase] || '—') }
        ] : []),
        {
          id: 'password',
          label: kind === 'account' ? '账号密码' : microsoft ? '登录密码' : '邮箱密码',
          class: 'mono',
          long: true,
          render: (asset) => esc(asset.password ||
            (microsoft && asset.microsoftSecurity?.loginMode === 'passwordless' ? '无密码登录' : '未录入'))
        },
        ...(personalAccount(type) ? [
          { id: 'loginMethod', label: '登录方式', render: asset => esc(choiceLabel(grokLoginOptions, asset.loginMethod)) },
          { id: 'customer', label: '当前客户', render: asset => esc(accountSummaries.get(asset.id)?.customer || '未分配') }
        ] : []),
        ...(microsoft ? [
          { id: 'loginMode', label: '登录方式', render: (asset) => esc(choiceLabel(microsoftLoginModes, asset.microsoftSecurity?.loginMode)) },
          { id: 'auxiliary', label: '辅助邮箱', class: 'wide-cell', long: true },
          { id: 'recoveryAccess', label: '辅助邮箱取码方式', render: (asset) => esc(microsoftRecoveryLabel(asset)) },
          { id: 'twoStep', label: '两步验证', render: (asset) => esc(choiceLabel(microsoftTwoStepOptions, asset.microsoftSecurity?.twoStep, '未核验')) },
          { id: 'verificationMethods', label: '验证方式', render: (asset) => esc(microsoftVerificationLabel(asset)) },
          { id: 'verificationDevice', label: '验证设备／审批人', long: true, render: (asset) => esc(asset.microsoftSecurity?.verificationDevice || '—') },
          totpColumn,
          { id: 'phone', label: '绑定手机号', render: (asset) => phoneValue(asset.phone) },
          appPasswordColumn
        ] : []),
        ...(['google', 'gpt'].includes(type) ? [totpColumn] : []),
        ...(type === 'google'
          ? [
              { id: 'auxiliary', label: '辅助邮箱', class: 'wide-cell', long: true },
              { id: 'phone', label: '绑定电话／验证码', render: asset => phoneValue(asset.phone) },
              appPasswordColumn
            ]
          : []),
        { id: 'country', label: usesAccountLocation(type) ? '注册国家' : '国家地区' },
        ...(usesRegistrationCity(type) ? [{ id: 'city', label: '注册城市' }] : []),
        {
          id: 'status',
          label: kind === 'mail' ? '邮箱状态' : '账号状态',
          render: asset => {
            const state = mailHealth(asset);
            return tag(state, state === '正常' ? 'success' : 'warning');
          }
        },
        {
          id: 'use',
          label: '使用状态',
          render: (asset) => kind === 'mail'
            ? tag(mailUseLabels[mailUse(asset)] || '未登记', mailUse(asset) === 'used' ? 'success' : '')
            : usageReview.has(asset.id)
            ? tag(usageReview.get(asset.id).status === 'used' ? '检测到已使用' : '待核对', 'warning')
            :
            tag(
              (historicallyOpened(asset) ? '历史已开通' : accountSummaries.get(asset.id)?.label) ||
              { available: '未使用', claimed: '已提取待使用', used: '已实际使用' }[
                displayInventoryState(asset)
              ],
              displayInventoryState(asset) === 'used'
                ? 'success'
                : asset.inventoryState === 'claimed'
                  ? 'warning'
                  : ''
            )
        },
        ...(usesAccountLocation(type) ? [
          { id: 'currentCustomer', label: '当前客户', render: asset => esc(accountSummaries.get(asset.id)?.customer || '未分配') },
          { id: 'reuseState', label: '库存用途', render: asset => esc(asset.accountLifecycle?.disposition === 'retired' ? '不再复用' : accountSummaries.get(asset.id)?.lastRecoveredAt ? '回收复用' : '常规库存') },
          { id: 'lastRecoveredAt', label: '最近回收时间', render: asset => esc(accountSummaries.get(asset.id)?.lastRecoveredAt || '—') }
        ] : []),
        ...(type === 'claude'
          ? [
              { id: 'proxyUrl', label: '注册 IP 链接', class: 'mono wide-cell', long: true },
              {
                id: 'proxyProtocol',
                label: '代理类型',
                render: (asset) =>
                  esc(
                    { http: 'HTTP', https: 'HTTPS', socks5: 'SOCKS5' }[asset.proxyProtocol] ||
                      '未记录'
                  )
              },
              { id: 'proxyHost', label: '代理主机', class: 'mono', long: true },
              { id: 'proxyPort', label: '代理端口', class: 'mono' },
              { id: 'proxyUser', label: '代理账号', class: 'mono', long: true },
              { id: 'proxyPassword', label: '代理密码', class: 'mono', long: true,
                render: (asset) => esc(asset.proxyPassword || '未录入') },
              { id: 'age', label: '养号时长', render: (asset) => ageLabel(asset) },
              {
                id: 'ready',
                label: '是否可用',
                render: claudeReadiness
              },
              { id: 'kyc', label: 'KYC 状态', render: (asset) => esc(accountKyc(asset)) }
            ]
          : []),
        ...(type === 'relay'
          ? [
              { id: 'parentMailboxId', label: '主邮箱编号',
                render: (asset) => esc(api.modules.appleRelay?.displayId('parent', asset.parentMailboxId) || '待接入') },
              { id: 'aliasId', label: '隐藏邮箱编号',
                render: (asset) => esc(api.modules.appleRelay?.displayId('alias', asset) || '待接入') },
              { id: 'queryCode', label: '查询码', long: true },
              { id: 'queryExpiry', label: '查询码到期' }
            ]
          : []),
        ...(v.tab !== 'available'
          ? [
              { id: 'purpose', label: '用途' },
              { id: 'usedAt', label: '提取时间', render: (asset) => esc(asset.claimedAt || asset.usedAt || '未记录') },
              ...(v.tab === 'used' ? [{
                id: 'actualUsedAt', label: '实际使用时间',
                render: (asset) => esc(asset.actualUsedAt || (historicallyOpened(asset) && String(asset.claudeHistory.start || '').replace('T', ' ')) || pendingClaim(asset)?.item.usedAt || '未记录')
              }, {
                id: 'usedHealth', label: '健康状态',
                render: (asset) => esc({ dead: '死号', unlocking: '解封中' }[asset.health] || '正常')
              }] : []),
              { id: 'extractionNotes', label: '提取备注', class: 'wide-cell', long: true }
            ]
          : []),
        ...(['dead', 'unlocking'].includes(v.tab)
          ? [
              {
                id: 'healthChangedAt',
                label: v.tab === 'dead' ? '死号时间' : '进入解封中时间',
                render: (asset) => esc(healthChangeTime(asset))
              }
            ]
          : []),
        { id: 'source', label: '来源渠道' },
        {
          id: 'registered',
          label: '注册时间',
          render: (asset) => esc(String(registrationTime(asset) || '未提供').replace('T', ' '))
        },
        {
          id: 'createdBy',
          label: '录入人',
          render: (asset) => esc(asset.createdBy || '历史未记录')
        },
        {
          id: 'createdAt',
          label: '录入时间',
          render: (asset) => esc(asset.createdAt || '历史未记录')
        },
        {
          id: 'lastOperatedBy',
          label: '最近操作人',
          render: (asset) => esc(asset.lastOperatedBy || '历史未记录')
        },
        {
          id: 'lastOperatedAt',
          label: '最近操作时间',
          render: (asset) => esc(asset.lastOperatedAt || '历史未记录')
        },
        { id: 'device', label: '登录设备', long: true },
        { id: 'notes', label: '备注 1', class: 'wide-cell', long: true },
        { id: 'notes2', label: '备注 2', class: 'wide-cell', long: true },
        {
          id: 'actions',
          label: '操作',
          action: true,
          render: (asset) => {
            const attrs = `data-id="${esc(asset.id)}"`;
            return `<div class="action-links">${canManage ? textAction('编辑', 'inventory-edit', attrs) : ''}${textAction('详情', 'inventory-detail', attrs)}${canManage ? textAction('更多操作', 'inventory-more', `${attrs} aria-haspopup="menu" aria-expanded="false"`, '', 'down') : ''}</div>`;
          }
        }
      ];
      const selection = api.getSelection('inventory-module-assets');
      body = `<div class="toolbar list-filters"><div class="toolbar-left"><div class="search-field">${icon('search')}<input data-auto-search id="inventory-list-query" aria-label="搜索库存资料" placeholder="${microsoft ? '搜索邮箱、辅助邮箱或备注' : '搜索账号、备注或用途'}" value="${esc(v.query)}" /></div><select id="inventory-country" aria-label="筛选国家">${options(choicesWithCurrent([['', '全部国家'], ...settingsFor(type).countries], v.country), v.country)}</select><select id="inventory-status" aria-label="筛选${kind === 'mail' ? '邮箱' : '账号'}状态">${options([['', '全部状态'], '正常', '冻结', '封控中', ...(kind === 'mail' ? ['死号', '解封中'] : [])], v.status)}</select>${kind === 'mail' ?
        `<select id="inventory-usage-filter" aria-label="筛选使用状态">${options([['', '全部使用状态'], ...Object.entries(mailUseLabels)], v.usage)}</select>` : ''}</div><div class="toolbar-right">${button('列设置', 'column-settings', '', 'columns', `data-table-id="${esc(title)}库存"`)}${microsoft ? '' : button('提取与归还', 'inventory-center', '', 'return')}${button(microsoft ? '复制邮箱地址' : '复制所选', 'inventory-copy-selected', '', 'copy', selection.size ? '' : 'disabled')}${!microsoft && v.tab === 'claimed' ? button('归还所选', 'inventory-return-selected', '', 'return', selection.size ? '' : 'disabled') : ''}</div></div>${table(columns, pageRows(rows, asset => inventoryListTime(asset, v.tab)), 'inventory-module-assets', `${title}库存`)}${pagination(rows.length)}`;
    }
    const tabItems = [
      ...(kind === 'mail' ? [['all', '全部', assets.length]] : []),
      ['available', usesAccountLocation(type) ? '可用库存' : '库存', counts.available],
      ['claimed', '已提取', counts.claimed],
      ['used', '已使用', counts.used],
      ['dead', '死号', counts.dead],
      ['unlocking', '解封中', counts.unlocking],
      ['imports', '导入记录', '']
    ];
    return (
      header(title, microsoft ? '维护 Outlook、Hotmail 等个人微软邮箱的登录、验证和辅助邮箱资料，并追溯状态与导入记录。'
        : type === 'claude' ? '历史登记状态保留原记录。是否可用按注册时间、养号门槛及账号状态判定。'
        : '资料只保存一份，提取、实际使用、归还与异常记录分别追溯。', actions) +
      summary([
        ['全部资料', assets.length, '条'],
        [microsoft ? '未使用' : '当前可提取', microsoft ? counts.available : assets.filter(available).length, '条', true],
        ['待使用', counts.claimed, '条'],
        ['已实际使用', counts.used, '条']
      ]) +
      `<section class="panel"><div class="tabs" role="tablist" aria-label="库存视图" data-page-actions="tabs">${tabItems.map(([id, label, count]) => `<button class="tab ${v.tab === id ? 'active' : ''}" role="tab" aria-selected="${v.tab === id}" data-action="inventory-tab" data-tab="${id}">${label}${count !== '' ? `<span class="tab-count">${count}</span>` : ''}</button>`).join('')}</div>${body}</section>`
    );
  }

  function workspaceHeading(title, description, id, glyph, tone, actions = '') {
    return `<div class="panel-heading"><div class="section-title-row"><span class="inventory-workspace-icon" data-tone="${tone}" aria-hidden="true">${icon(glyph)}</span><h2 id="${id}">${esc(title)}</h2>${api.titleInfo?.(title, description, id + '-help') || ''}</div>${actions}</div>`;
  }
  function recentExtractionList(rows) {
    const numbers = extractionBatchNumbers();
    return rows.length ? `<ul class="inventory-workspace-records inventory-extraction-records">${rows.map(batch => {
      const counts = batchCounts(batch);
      return `<li><strong class="inventory-extraction-number">${esc(numbers.get(batch.id) ?? batch.id)}</strong><span class="inventory-extraction-status">${tag(counts.pending ? `待处理 ${counts.pending}` : '已处理', counts.pending ? 'warning' : 'success')}</span><span class="inventory-extraction-purpose" title="${esc(batch.purpose || '未记录')}">${esc(batch.purpose || '未记录')}</span><span class="inventory-extraction-count">${batch.items.length} 条</span><span class="inventory-extraction-actor" title="${esc(batch.actorName || '未记录')}">${esc(batch.actorName || '未记录')}</span><time class="inventory-extraction-time" title="北京时间">${esc(workspaceRecordTime(batch.time))}</time><div class="inventory-record-actions">${textAction('明细', 'inventory-batch', `data-id="${esc(batch.id)}"`)}${textAction(counts.returnable ? `归还（${counts.returnable}）` : '无可归还项', 'inventory-batch-return', `data-id="${esc(batch.id)}" ${counts.returnable ? '' : 'disabled title="查看明细了解已使用、已归还或业务占用原因"'}`)}</div></li>`;
    }).join('')}</ul>` : empty('暂无提取批次', '完成提取后在这里查看最近批次。');
  }
  function extractionPage(account = accountSubmissionRoute()) {
    const kind = account ? 'account' : 'mail';
    const defaultPurposes = account ? ['客户交付', '比特充值', '业务备用', '其他'] : mailExtractionPurposes();
    const key = `inventory-extract:${kind}`;
    const list = account
      ? stockTypes
      : mailboxWorkflowTypes(true);
    const d = draft(key, {
      'inventory-extract-type': list[0]?.[0],
      'inventory-quantity': '3',
      'inventory-purpose': defaultPurposes[0] || ''
    });
    const purposes = account ? defaultPurposes : mailExtractionPurposes(d['inventory-extract-type']);
    const selectedPurpose = purposes.includes(d['inventory-purpose']) ? d['inventory-purpose'] : '';
    const purposeChoices = selectedPurpose ? purposes : [['', '原用途已移除，请重新选择'], ...purposes];
    const purposeControl = account
      ? select('inventory-purpose', purposeChoices, selectedPurpose)
      : `<div class="option-entry-controls">${select('inventory-purpose', purposeChoices, selectedPurpose)}${button('设置', 'inventory-purpose-settings', '', 'settings', 'aria-label="设置邮箱提取用途"')}</div>`;
    const recent = window.IDListOrder.sortByRecordTime(
      batches.filter((batch) => batch.kind === kind && ownerAllowed(batch)), batch => batch.time
    ).slice(0, 5);
    const availableCounts = list
      .map(([type, label]) => `<span>${esc(label)} <strong>${type === 'relay' && localData
        ? '提交时核对'
        : collection(kind).filter((asset) => asset.type === type && available(asset)).length}</strong></span>`)
      .join('');
    return (
      header(
        account ? '账号提取' : '邮箱提取',
        '左侧录入或批量导入资料，右侧从可用库存提取。提取后进入待使用，后续处理可进入提取与归还。',
        button('提取与归还', 'inventory-center', '', 'return')
      ) +
      `<div class="inventory-workspace"><div class="inventory-workspace-columns">${submissionPanel(account)}<section class="panel inventory-extraction-panel" aria-labelledby="inventory-extraction-heading">${workspaceHeading('提取资料', '从可用库存按数量提取。确认实际使用后不再进入通用可提取库存；数量不足时不会减少数量提交。', 'inventory-extraction-heading', 'download', 'violet')}<div class="form-panel"><form id="inventory-extract-form" data-inventory-draft="${key}" novalidate><input type="hidden" name="inventory-kind" value="${kind}" /><div class="form-grid inventory-extraction-fields">${field(account ? '账号类型' : '邮箱类型', 'inventory-extract-type', select('inventory-extract-type', list, d['inventory-extract-type']), true)}${field('提取数量', 'inventory-quantity', input('inventory-quantity', d['inventory-quantity'], 'type="number" min="1" max="100"'), true)}${wide('提取用途', 'inventory-purpose', purposeControl, true)}${selectedPurpose === '其他' ? wide('用途说明', 'inventory-purpose-other', input('inventory-purpose-other', d['inventory-purpose-other'] || '', 'placeholder="填写具体用途"'), true) : ''}${wide('备注', 'inventory-extract-notes', area('inventory-extract-notes', d['inventory-extract-notes'] || '', '记录本批资料用途和操作说明'))}</div><div class="inventory-extraction-summary"><div class="inventory-availability" aria-label="当前可用库存">${availableCounts}</div><div class="inventory-extraction-actions" data-page-actions="before-submit"><button class="button primary" type="submit">确认提取</button></div></div></form></div><section class="inventory-extraction-history" aria-labelledby="inventory-extraction-history-heading"><div class="panel-heading"><h3 id="inventory-extraction-history-heading">最近提取批次</h3>${button('全部记录', 'inventory-center')}</div><div class="panel-body inventory-workspace-history" tabindex="0" aria-label="最近提取批次列表">${recentExtractionList(recent)}</div></section></section></div></div>`
    );
  }
  function extractionBatchNumbers() {
    const numbers = new Map();
    const dailyCounts = new Map();
    // New batches are prepended. Number the full history from oldest to newest.
    for (const batch of batches.slice().reverse()) {
      const date = /^(\d{4})-(\d{2})-(\d{2})(?:[ T]|$)/.exec(batch.time);
      if (!date) continue;
      const day = date[1].slice(-2) + date[2] + date[3];
      const sequence = (dailyCounts.get(day) || 0) + 1;
      dailyCounts.set(day, sequence);
      numbers.set(batch.id, `hd${day}-${String(sequence).padStart(2, '0')}`);
    }
    return numbers;
  }
  function batchTable(rows, numbers = extractionBatchNumbers()) {
    return table(
      [
        {
          id: 'id',
          label: '提取批次',
          render: (batch) =>
            textAction(numbers.get(batch.id) ?? batch.id, 'inventory-batch',
              `data-id="${esc(batch.id)}" title="${esc(batch.id)}"`)
        },
        {
          id: 'kind',
          label: '资料类别',
          render: (batch) => (batch.kind === 'mail' ? '邮箱' : '账号')
        },
        { id: 'purpose', label: '用途' },
        { id: 'actorName', label: '提取人' },
        { id: 'time', label: '提取时间' },
        { id: 'total', label: '提取数量', render: (batch) => batch.items.length },
        {
          id: 'pending',
          label: '待处理',
          render: (batch) =>
            tag(
              String(batchCounts(batch).pending),
              batchCounts(batch).pending ? 'warning' : 'success'
            )
        },
        { id: 'used', label: '已使用', render: (batch) => batchCounts(batch).used },
        { id: 'returned', label: '已归还', render: (batch) => batchCounts(batch).returned },
        { id: 'returnable', label: '可归还', render: batch => tag(String(batchCounts(batch).returnable), batchCounts(batch).returnable ? 'success' : '') },
        {
          id: 'actions',
          label: '操作',
          action: true,
          render: (batch) =>
            `<div class="action-links">${textAction('明细', 'inventory-batch', `data-id="${batch.id}"`)}${textAction(batchCounts(batch).returnable ? `归还（${batchCounts(batch).returnable}）` : '无可归还项', 'inventory-batch-return', `data-id="${batch.id}" ${batchCounts(batch).returnable ? '' : 'disabled title="查看明细了解已使用、已归还或业务占用原因"'}`)}</div>`
        }
      ],
      rows,
      '',
      '提取批次',
      { title: '没有符合条件的批次', description: '可以先提取资料，之后在这里持续处理。' }
    );
  }
  function centerPage() {
    const v = view();
    const numbers = extractionBatchNumbers();
    const visible = batches.filter((batch) => ownerAllowed(batch));
    const pending = visible.reduce((sum, batch) => sum + batchCounts(batch).pending, 0);
    const pendingBatches = visible.filter(batch => batchCounts(batch).pending > 0);
    const visibleReturns = returnRecords.filter(entry => admin() || entry.actorId === currentActor().id);
    let body;
    if (v.centerTab === 'quick') {
      const d = draft('inventory-quick', { 'inventory-quick-text': '' });
      body = `<div class="form-panel"><form id="inventory-quick-form" data-inventory-draft="inventory-quick" novalidate><div class="form-grid">${wide('邮箱或账号', 'inventory-quick-text', area('inventory-quick-text', d['inventory-quick-text'], '每行一个邮箱或账号，定位有效提取记录', 5), true)}${field(
        '资料类别',
        'inventory-quick-kind',
        select(
          'inventory-quick-kind',
          [
            ['all', '邮箱与账号'],
            ['mail', '邮箱'],
            ['account', '账号']
          ],
          d['inventory-quick-kind'] || 'all'
        )
      )}${field('资料类型', 'inventory-quick-type', select('inventory-quick-type', [['', '全部类型'], ['google', '谷歌邮箱'], ['relay', '苹果隐藏邮箱'], ...stockTypes], d['inventory-quick-type'] || ''))}</div><div class="form-footer"><span class="footnote">先读取最新库存逐项核对；同一地址匹配多条时须明确选择，不会直接归还。</span><button class="button primary" type="submit">查找并核对</button></div></form></div>`;
    } else if (v.centerTab === 'returns') {
      const rows = visibleReturns;
      body = table(
        [
          { id: 'id', label: '归还编号' },
          { id: 'batchId', label: '原提取批次', render: (entry) => esc(numbers.get(entry.batchId) ?? entry.batchId) },
          { id: 'email', label: '邮箱 / 账号', render: row => esc(displayIdentity(row)) },
          { id: 'reason', label: '归还理由', long: true },
          { id: 'time', label: '归还时间' },
          { id: 'actor', label: '操作人' },
          { id: 'notes', label: '备注', long: true },
          {
            id: 'actions',
            label: '操作',
            action: true,
            render: (entry) =>
              textAction('原批次', 'inventory-batch', `data-id="${entry.batchId}"`)
          }
        ],
        pageRows(rows, entry => entry.time),
        '',
        '归还记录',
        { title: '暂无归还记录', description: '完成归还后会保留原批次、理由、时间和操作人。' }
      ) + pagination(rows.length);
    } else {
      const rows = (v.centerTab === 'pending' ? pendingBatches : visible).filter(
        (batch) =>
          (!v.query ||
            `${numbers.get(batch.id) ?? ''} ${batch.id} ${batch.purpose} ${batch.actorName} ${batch.items.map(displayIdentity).join(' ')}`
              .toLowerCase()
              .includes(v.query.toLowerCase()))
      );
      body = `<div class="toolbar"><div class="toolbar-left"><div class="search-field">${icon('search')}<input data-auto-search id="inventory-center-query" aria-label="搜索提取记录" placeholder="搜索批次、邮箱、用途或提取人" value="${esc(v.query)}" /></div></div>${button('提取邮箱', 'inventory-go', '', 'download', 'data-route="workspace/mail-extract"')}${button('提取账号', 'inventory-go', '', 'download', 'data-route="workspace/account-extract"')}</div>${batchTable(pageRows(rows, batch => batch.time), numbers)}${pagination(rows.length)}`;
    }
    return (
      header(
        '提取与归还',
        localData
          ? '已提取不等于已实际使用。每条资料保留原提取批次，关闭页面后可继续处理。'
          : '已提取不等于已实际使用。每条资料保留原提取批次，关闭页面后可继续处理；原型刷新重置。'
      ) +
      summary([
        ['提取批次', visible.length, '个'],
        ['待处理资料', pending, '条', true],
        ['已确认使用', visible.reduce((sum, batch) => sum + batchCounts(batch).used, 0), '条'],
        ['归还记录', visibleReturns.length, '条']
      ]) +
      `<section class="panel"><div class="tabs" role="tablist" aria-label="提取与归还视图">${[
        ['pending', '我的待处理', pendingBatches.length],
        ['history', '提取历史', visible.length],
        ['quick', '快捷归还'],
        ['returns', '归还记录', visibleReturns.length]
      ]
        .map(([id, label, count]) => {
          const countId = 'inventory-center-count-' + id;
          return `<button type="button" role="tab" aria-selected="${v.centerTab === id}" aria-label="${label}"${count === undefined ? '' : ` aria-describedby="${countId}"`} class="tab ${v.centerTab === id ? 'active' : ''}" data-action="inventory-center-tab" data-tab="${id}">${label}${count === undefined ? '' : `<span class="tab-count" id="${countId}">${count}</span>`}</button>`;
        })
        .join('')}</div>${body}</section>`
    );
  }
  function batchPage(batch) {
    if (!batch || !ownerAllowed(batch))
      return (
        header('提取批次', '只能查看有权限的提取记录。') +
        empty('批次不存在或无权限', '返回提取与归还查找记录。')
      );
    const count = batchCounts(batch);
    const number = extractionBatchNumbers().get(batch.id) ?? batch.id;
    const selected = api.getSelection('inventory-claims');
    return (
      header(
        '提取批次明细',
        `${number} · ${batch.actorName} · ${batch.time} · ${batch.purpose}`,
        button('返回提取与归还', 'inventory-center') +
          button('复制所选', 'inventory-claim-copy', '', 'copy', selected.size ? '' : 'disabled') +
          button('登记使用', 'inventory-claim-use', '', 'check',
            batch.items.some(item => selected.has(item.id) && useAllowed({ item, batch })) ? '' : 'disabled') +
          button(
            '归还所选',
            'inventory-claim-return',
            'primary',
            'return',
            batch.items.some(item => selected.has(item.id) && !returnBlock(assetById(item.assetId), batch, item)) ? '' : 'disabled'
          )
      ) +
      summary([
        ['原提取', batch.items.length, '条'],
        ['待使用', count.pending, '条', true],
        ['已实际使用', count.used, '条'],
        ['已归还', count.returned, '条']
      ]) +
      `<section class="panel"><div class="panel-heading"><h2 title="${esc(batch.id)}">${esc(number)}</h2><div class="toolbar-right" data-page-actions></div></div>${table(
        [
          { id: 'email', label: '邮箱 / 账号', class: 'email-cell', render: row => esc(displayIdentity(row)) },
          { id: 'type', label: '资料类型', render: (item) => typeLabel(item.type) },
          { id: 'status', label: '处理状态', render: itemTag },
          { id: 'returnEligibility', label: '归还资格', class: 'wide-cell', render: item => esc(returnBlock(assetById(item.assetId), batch, item) || '可归还') },
          { id: 'usageEvidence', label: '使用依据', long: true },
          { id: 'claimedAt', label: '提取时间' },
          { id: 'usedAt', label: '实际使用时间' },
          { id: 'returnedAt', label: '归还时间' },
          { id: 'reason', label: '归还理由', long: true },
          { id: 'notes', label: '备注', long: true },
          {
            id: 'actions',
            label: '操作',
            action: true,
            render: (item) =>
              `<div class="action-links">${textAction('复制', 'inventory-item-copy', `data-id="${item.id}"`)}${textAction('资料', 'inventory-detail', `data-id="${item.assetId}"`)}${textAction(returnBlock(assetById(item.assetId), batch, item) ? '不可归还' : '归还', 'inventory-item-return', `data-id="${item.id}" ${returnBlock(assetById(item.assetId), batch, item) ? 'disabled' : ''}`)}</div>`
          }
        ],
        batch.items.map((item) => {
          const asset = assetById(item.assetId);
          const links = asset?.usageLinks || [];
          const link = links.find((entry) => entry.claimId === item.id) ||
            (item.status === 'used' && links.at(-1));
          const corrected = asset?.usageCorrections?.some((row) => row.originalLink?.claimId === item.id);
          const usageEvidence = link?.label ||
            (item.status === 'pending' && usageReview.get(item.assetId)?.message) ||
            (corrected ? '原使用关联已更正' : undefined);
          return { ...item, usageEvidence };
        }),
        'inventory-claims',
        '批次明细'
      )}</section>`
    );
  }
  function selectedClaims() {
    const ids = api.getSelection('inventory-claims');
    return batches.flatMap((batch) =>
      batch.items.filter((item) => ids.has(item.id)).map((item) => ({ batch, item }))
    );
  }
  function usageReviewButton() {
    return localData && admin() && [...usageReview.keys()].some(assetById)
      ? button('核对使用关联', 'inventory-usage-review', '', 'check')
      : '';
  }
  function openUsageReview() {
    const rows = [...usageReview.values()].map((row) => ({ ...row, asset: assetById(row.assetId) }))
      .filter((row) => row.asset);
    const confirmable = rows.filter((row) => row.status === 'used');
    if (!rows.length) return api.notify('当前没有待核对的使用关联');
    showDrawer('核对使用关联', '同步有明确依据的记录。有冲突的资料保留待核对。',
      table([
        { id: 'email', label: '邮箱 / 账号', render: (row) => esc(displayIdentity(row.asset)) },
        { id: 'type', label: '资料类型', render: (row) => esc(typeLabel(row.asset.type)) },
        { id: 'status', label: '结果', render: (row) => esc(row.status === 'used' ? '检测到已使用' : '待核对') },
        { id: 'message', label: '依据', render: (row) => esc(row.message) }
      ], rows.map((row) => ({ ...row, id: row.assetId })), '', '库存使用关联'),
      button('关闭', 'inventory-close') +
      button(`同步已确认 ${confirmable.length} 条`, 'inventory-usage-confirm', 'primary', 'check',
        confirmable.length ? '' : 'disabled')
    );
  }
  let returnReviewRequest = 0;
  async function reviewReturn(claims, extraRows = [], preselect = true) {
    if (!localData) return requestReturn(claims, extraRows, preselect);
    const request = ++returnReviewRequest;
    const route = api.state.route;
    const ids = claims.map(({ item }) => item.id);
    const context = api.state.drawerContext;
    const ready = await readLocalInventory({ keepContent: true });
    if (request !== returnReviewRequest || route !== api.state.route || context !== api.state.drawerContext) return;
    if (!ready) return api.notify('未能核对最新库存，请重试');
    const fresh = ids.map(claimById);
    requestReturn(fresh.filter(Boolean), [...extraRows, ...fresh.flatMap((entry, i) => entry ? [] : [{ email: claims[i].item.email, reason: '原领用已变化或无查看权限，请重新查找' }])], preselect);
  }
  async function reviewQuickReturn(form) {
    const data = api.readForm(form), snapshot = JSON.stringify(data), request = ++returnReviewRequest;
    const route = api.state.route, actorId = currentActor().id;
    const current = () => request === returnReviewRequest && route === api.state.route && actorId === currentActor().id &&
      form.isConnected !== false && JSON.stringify(api.readForm(form)) === snapshot;
    const tokens = String(data['inventory-quick-text'] || '').split(/\r?\n/).flatMap((line, index) =>
      line.split(/[\s,;，；]+/).map(value => value.trim().toLowerCase()).filter(Boolean).map(email => ({ email, line: index + 1 })));
    if (!tokens.length) return api.setError('inventory-quick-text', '请填写至少一个邮箱或账号');
    if (localData && !await readLocalInventory({ keepContent: true })) {
      if (current()) api.notify('未能核对最新库存，输入已保留，请重试');
      return;
    }
    if (!current()) return;
    const claims = [], errors = [], seen = new Set();
    for (const { email, line } of tokens) {
      if (seen.has(email)) { errors.push({ email, line, reason: '重复输入，不重复处理' }); continue; }
      seen.add(email);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !/^@[a-z0-9_]{1,15}$/i.test(email)) {
        errors.push({ email, line, reason: '邮箱或账号格式不正确' });
        continue;
      }
      const candidates = allAssets().filter(asset => (identityKey(asset) === email || asset.email?.toLowerCase() === email) &&
        (!data['inventory-quick-type'] || asset.type === data['inventory-quick-type']) &&
        (data['inventory-quick-kind'] === 'all' || (isAccount(asset) ? 'account' : 'mail') === data['inventory-quick-kind']));
      if (!candidates.length) { errors.push({ email, line, reason: '未找到对应类型资料或无查看权限' }); continue; }
      for (const asset of candidates) {
        const match = pendingClaim(asset) || batches.filter(batch => batch.kind === (isAccount(asset) ? 'account' : 'mail'))
          .flatMap(batch => batch.items.filter(item => item.assetId === asset.id).map(item => ({ batch, item })))[0];
        if (match && !ownerAllowed(match.batch)) errors.push({ email, line, type: asset.type, reason: '无权处理当前领用记录' });
        else if (match) claims.push({ ...match, line, ambiguous: candidates.length > 1 });
        else errors.push({ email, line, type: asset.type, reason: asset.inventoryState === 'used' ? '资料已实际使用，不能归还' : '当前没有有效领用，已在库存或已归还' });
      }
    }
    requestReturn(claims, errors);
  }
  function requestReturn(claims, extraRows = [], preselect = true) {
    if (!claims.length && !extraRows.length) {
      api.notify('请先选择需要处理的资料');
      return;
    }
    const checked = claims.map(({ batch, item, line, ambiguous }) => ({
      batch,
      item,
      line, ambiguous,
      asset: assetById(item.assetId),
      blocked: returnBlock(assetById(item.assetId), batch, item)
    }));
    const allowed = checked.filter((entry) => !entry.blocked);
    const numbers = extractionBatchNumbers();
    const displayRows = [
      ...checked,
      ...extraRows.map((row) => ({
        item: { email: row.email, type: row.type }, line: row.line,
        batch: { id: row.batchId || '—' },
        blocked: row.reason
      }))
    ];
    const key = `inventory-return:${checked
      .map(({ item }) => item.id)
      .sort()
      .join(',')}:${extraRows
      .map((row) => row.email)
      .sort()
      .join(',')}`;
    const saved = api.state.drafts.get(key);
    const selected = allowed.filter(({ item, ambiguous }) =>
      saved ? Boolean(saved[`inventory-return-choice-${item.id}`]) : preselect && !ambiguous
    );
    showDrawer(
      '核对归还资料',
      '只解除合法的本次领用，不抹掉实际注册、充值、订单或原提取记录。',
      `<form id="inventory-return-form" data-inventory-draft="${esc(key)}" novalidate><div class="toolbar"><div class="toolbar-left"><span class="footnote">勾选本次需要归还的资料，未勾选的继续保留领用。</span></div>${button('全选可归还', 'inventory-return-all', '', '', allowed.length ? '' : 'disabled')}${button('取消全选', 'inventory-return-clear', '', '', allowed.length ? '' : 'disabled')}</div>${table(
        [
          {
            id: 'selection',
            label: '选择',
            class: 'check-cell',
            render: (row) =>
              `<input type="checkbox" id="inventory-return-choice-${esc(row.item.id || `blocked-${row.id}`)}" name="inventory-return-choice-${esc(row.item.id || `blocked-${row.id}`)}" value="${esc(row.item.id || '')}" data-return-claim aria-label="归还 ${esc(displayIdentity(row.item))}" ${row.blocked ? 'disabled' : selected.some(({ item }) => item.id === row.item.id) ? 'checked' : ''} />`
          },
          { id: 'line', label: '输入行', render: row => row.line || '—' },
          { id: 'type', label: '资料类型', render: row => esc(row.item.type ? typeLabel(row.item.type) : '—') },
          { id: 'email', label: '邮箱 / 账号', render: (row) => esc(displayIdentity(row.item)) },
          { id: 'batch', label: '原批次', render: (row) => esc(numbers.get(row.batch.id) ?? row.batch.id) },
          {
            id: 'result',
            label: '处理资格',
            class: 'wide-cell',
            render: (row) => row.blocked ? esc(row.blocked) : row.ambiguous ? tag('可归还，需明确选择目标', 'warning') : tag('可归还', 'success')
          }
        ],
        displayRows.map((row, index) => ({ ...row, id: String(index) })),
        '',
        '归还核对'
      )}<div class="form-grid section-gap">${field('归还理由', 'inventory-return-reason', select('inventory-return-reason', ['未使用', '死号', '解封中'], saved?.['inventory-return-reason'] || '未使用'), true)}${wide('归还备注', 'inventory-return-notes', area('inventory-return-notes', saved?.['inventory-return-notes'] || '', '选填：记录归还情况'))}</div></form>`,
      `<span class="footnote" id="inventory-return-summary" role="status">已选 ${selected.length} 条 / 可归还 ${allowed.length} 条，${displayRows.length - allowed.length} 条被阻止；仅处理勾选资料</span>${button('取消', 'inventory-close')}<button class="button primary" form="inventory-return-form" type="submit" ${selected.length ? '' : 'disabled'}>确认归还</button>`,
      key
    );
  }
  function updateReturnSelection(form) {
    if (!form) return;
    const boxes = [...form.querySelectorAll('input[data-return-claim]')];
    const allowed = boxes.filter((node) => !node.disabled);
    const selected = allowed.filter((node) => node.checked);
    const summary = document.getElementById('inventory-return-summary');
    if (summary)
      summary.textContent = `已选 ${selected.length} 条 / 可归还 ${allowed.length} 条，${boxes.length - allowed.length} 条被阻止；仅处理勾选资料`;
    const submit = document.querySelector('button[form="inventory-return-form"][type="submit"]');
    if (submit) submit.disabled = !selected.length;
    api.state.drafts.set(form.dataset.inventoryDraft, api.readForm(form));
  }
  function useAllowed({ item, batch }) {
    const asset = assetById(item.assetId);
    return (
      asset &&
      !personalAccount(asset.type) &&
      item.status === 'pending' &&
      ownerAllowed(batch) &&
      asset.claimId === item.id &&
      asset.inventoryState === 'claimed' &&
      (!asset.usageLinks.length || asset.accountLifecycle?.disposition === 'recovered') &&
      !item.taskId &&
      !item.registrationId &&
      !reservations.has(asset.id)
    );
  }
  function confirmUse(claims) {
    const eligible = claims.filter(useAllowed);
    if (eligible.length !== claims.length || !eligible.length) {
      api.notify('仅能登记本人可处理、无未完成任务的待使用资料');
      return;
    }
    const key = `inventory-use:${eligible.map(({ item }) => item.id).sort().join(',')}`;
    const saved = draft(key);
    const purposes = usePurposesFor(eligible);
    showDrawer(
      '登记实际使用',
      '确认后资料永久退出通用可提取库存。同一邮箱不可再提取注册其他产品。',
      `<form id="inventory-use-form" data-inventory-draft="${esc(key)}" novalidate><input type="hidden" name="inventory-use-ids" value="${esc(eligible.map(({ item }) => item.id).join(','))}" /><div class="form-grid">${field('实际用途', 'inventory-use-purpose', select('inventory-use-purpose', [['', '请选择实际用途'], ...purposes], saved['inventory-use-purpose']), true)}${wide('使用结果', 'inventory-use-result', area('inventory-use-result', saved['inventory-use-result'] || '', '记录平台、关联账号或订单说明'), true)}</div></form>`,
      button('取消', 'inventory-close') +
        '<button class="button primary" form="inventory-use-form" type="submit">核对使用结果</button>',
      key
    );
  }
  function usePurposesFor(claims) {
    return claims.some(({ item }) => assetById(item.assetId)?.type === 'relay')
      ? actualUsePurposes.filter(purpose => !['注册 Gemini', '注册 Apple ID'].includes(purpose))
      : actualUsePurposes;
  }

  function assetEditor(id = '', forcedType = '', sourceId = '') {
    const original = id ? assetById(id) : null;
    const accountEntry = accountSubmissionRoute();
    const type =
      original?.type ||
      forcedType ||
      (accountEntry
        ? 'gpt'
        : /^(accounts|mailboxes)\//.test(api.state.route)
          ? api.state.route.split('/')[1]
          : 'google');
    if (accountEntry && (!accountEntryType(type) || id)) {
      api.notify('请从对应账号卡片录入新资料');
      return;
    }
    if (type === 'relay') {
      if (api.modules.appleRelay) api.modules.appleRelay.openAliasEditor(id);
      else api.notify('隐藏邮箱管理尚未就绪，请刷新页面后重试');
      return;
    }
    const microsoft = type === 'microsoft';
    if (microsoft && (!microsoftEntryAllowed() || (id && api.state.route !== microsoftMailboxRoute))) return;
    const personal = personalAccount(type);
    if (localData && personal && !admin()) return;
    const source = sourceId && personalSourceMailboxes(type).find(row => row.id === sourceId);
    if (sourceId && !source) {
      api.notify('该邮箱已不可用于本次注册，请重新核对');
      return;
    }
    const account = usesAccountLocation(type) || personal;
    const fundingApple = type === 'apple' && (fundingAppleRoute() || accountEntry);
    const key = accountEntry ? accountAssetKey(type) :
      source ? 'inventory-edit:source:' + source.id + ':' + type : `inventory-edit:${id || `new:${type}`}`;
    accountAssetContext = accountEntry ? { key, type } : null;
    const d = draft(
      key,
      original || {
        email: source?.email || '',
        sourceMailboxId: source?.id || '',
        password: '',
        status: '正常',
        source: '自己注册',
        country: '',
        registered: inventoryNow().replace(' ', 'T')
      }
    );
    const val = (name) => d[`inventory-${name}`] ?? d[name] ?? '';
    const acquisition = val('acquisitionMethod') || (original ? '' : 'self_registered');
    const purchased = acquisition === 'purchased';
    const config = settingsFor(type);
    const country = d['inventory-country-edit'] ?? d.country ?? '';
    const typeChoices = microsoft
      ? [['microsoft', typeLabel('microsoft')]]
      : accountEntry
      ? accountSubmissionTypes
      : personal ? [[type, typeLabel(type)]] : account
        ? stockTypes.filter(([id]) => !personalAccount(id))
        : mailboxWorkflowTypes();
    let fields = `<input type="hidden" name="inventory-asset-id" value="${esc(id)}" /><input type="hidden" name="inventory-version" value="${esc(d['inventory-version'] ?? original?.version ?? '')}" />`;
    if (accountEntry)
      fields += `<input type="hidden" name="inventory-entry-scope" value="account-submit" /><input type="hidden" name="inventory-entry-type" value="${type}" />`;
    fields += fundingApple
      ? '<input type="hidden" name="inventory-asset-type" value="apple" />'
      : field(
          '资料类型',
          original ? 'inventory-asset-type-label' : 'inventory-asset-type',
          original
            ? `${input('inventory-asset-type-label', typeLabel(type), 'readonly')}<input type="hidden" name="inventory-asset-type" value="${type}" />`
            : select('inventory-asset-type', typeChoices, type),
          true,
          original ? '创建后不可更改资料类型。' : '请按实际用途人工确认，邮箱域名不会自动改变类型。'
        );
    if (account) fields += field('账号来源', 'inventory-acquisitionMethod',
      select('inventory-acquisitionMethod', [...(original ? [['', '未登记']] : []), ...acquisitionChoices], acquisition),
      !original, '自注册可选择系统邮箱，也可独立录入。购买账号保留已知的注册资料。');
    fields += wide(
      fundingApple ? '苹果 ID' : type === 'gemini' ? 'Google 账号邮箱' : account ? '账号邮箱' : '邮箱账号',
      'inventory-email',
      input(
        'inventory-email',
        val('email'),
        original ? 'readonly' : 'placeholder="name@example.test" autocomplete="off"'
      ),
      type !== 'grok',
      account || fundingApple
        ? ''
        : `<span id="inventory-type-suggestion">${esc(mailboxSuggestion(val('email')))}</span>`
    );
    if (account && !personal)
      fields += field(
        '邮箱类型',
        'inventory-emailType',
        select('inventory-emailType', enabledTypes(), val('emailType') || 'google'),
        true
      );
    if (personal) {
      fields += type === 'gemini'
        ? '<input type="hidden" name="inventory-loginMethod" value="google" />'
        : field('登录方式', 'inventory-loginMethod', select('inventory-loginMethod', grokLoginOptions, val('loginMethod') || 'email'), true) +
          field('X @账号', 'inventory-xHandle', input('inventory-xHandle', val('xHandle'),
            original?.loginMethod === 'x' ? 'readonly' : 'placeholder="@username" maxlength="16"')) +
          field('X 绑定状态', 'inventory-xLinkState', select('inventory-xLinkState', xLinkOptions, val('xLinkState') || 'unknown'));
      fields += field('平台账号编号', 'inventory-platformAccountId', input('inventory-platformAccountId', val('platformAccountId'), 'maxlength="120"'));
    }
    if (account) {
      const linked = original?.sourceMailboxId && assetById(original.sourceMailboxId);
      const choices = [['', '独立录入'], ...personalSourceMailboxes(type)
        .map(row => [row.id, `${row.email} · ${row.inventoryState === 'claimed' ? '本人已领用' : '可用库存'}`])];
      fields += original ? field('来源邮箱', 'inventory-sourceMailboxDisplay',
        input('inventory-sourceMailboxDisplay', linked?.email || (original.sourceMailboxId ? '原资料待核对' : '独立录入'), 'readonly'))
        : field('来源邮箱', 'inventory-sourceMailboxId',
          select('inventory-sourceMailboxId', choicesWithCurrent(choices, val('sourceMailboxId')), val('sourceMailboxId'))
            .replace('<select ', purchased ? '<select disabled ' : '<select '),
          false, '仅在选中本系统邮箱时登记实际使用。');
    }
    if (microsoft) fields += field('使用状态', 'inventory-mailboxUsage',
      select('inventory-mailboxUsage', [['', '未登记'], ['available', '未使用'], ['used', '已使用']], val('mailboxUsage')));
    const security = original?.microsoftSecurity || {};
    if (microsoft)
      fields += field(
        '登录方式', 'inventory-microsoft-login',
        select('inventory-microsoft-login', microsoftLoginModes, d['inventory-microsoft-login'] ?? security.loginMode ?? 'password'),
        true
      );
    fields += field(
      account ? '账号密码' : microsoft ? '登录密码' : '邮箱密码',
      'inventory-password',
      input('inventory-password', val('password'), 'autocomplete="off"'),
      ['google', 'apple'].includes(type) && (!original || Boolean(original.password)),
      microsoft ? '密码登录必填。无密码登录留空，并记录实际验证方式。' : ''
    );
    if (['google', 'apple'].includes(type))
      fields += wide(
        '绑定电话',
        'inventory-phone',
        `<div class="option-entry-controls">${input('inventory-phone', val('phone'), 'placeholder="电话号码或 HTTP(S) 验证码链接"')}<a id="inventory-phone-code-link" class="button" href="${esc(phoneCodeUrl(val('phone')) || '#')}" target="_blank" rel="noopener noreferrer nofollow" ${phoneCodeUrl(val('phone')) ? '' : 'hidden'}>查看验证码</a></div><label class="checkbox-label"><input type="checkbox" id="inventory-no-phone" name="inventory-no-phone" ${(api.state.drafts.has(key) ? Boolean(d['inventory-no-phone']) : original && !original.phone) ? 'checked' : ''} />确认未绑定电话</label>`,
        true
      );
    if (microsoft)
      fields += field('绑定手机号', 'inventory-phone', input('inventory-phone', val('phone')));
    const countrySelect = select(
      'inventory-country-edit',
      choicesWithCurrent([['', '请选择国家'], ...config.countries], country),
      country
    );
    fields += field(
      account ? '注册国家' : '国家地区',
      'inventory-country-edit',
      account
        ? `<div class="option-entry-controls">${countrySelect}${locationSettingsButton(type, 'asset', id)}</div>`
        : countrySelect,
      (usesAccountLocation(type) && !purchased && (!original || Boolean(original.country))) ||
        (['google', 'apple'].includes(type) && (!original || Boolean(original.country)))
    );
    if (fundingApple && window.IDAppleFunding) {
      fields += field('Id地区', 'inventory-appStoreRegion',
        select('inventory-appStoreRegion', [['', '请选择 Id地区'], ...Object.entries(window.IDAppleFunding.appleRegions)],
          val('appStoreRegion')), !original, '以苹果 ID 在 App Store 使用的国家或地区为准。');
      if (!original)
        fields += field('期初余额（USD）', 'inventory-appleOpeningBalance',
          input('inventory-appleOpeningBalance', d['inventory-appleOpeningBalance'] ?? '0.00', 'inputmode="decimal"'), true);
    }
    if (usesRegistrationCity(type))
      fields += field(
        '注册城市',
        'inventory-city',
        select('inventory-city', accountCityChoices(type, country, original, val('city')), val('city')),
        !purchased && (!original || Boolean(original.city)),
        '请先选国家。地区／城市可在本账号的国家地区设置中维护。'
      );
    fields +=
      field(
        '账号状态',
        'inventory-status-edit',
        select(
          'inventory-status-edit',
          ['正常', '冻结', '封控中'],
          d['inventory-status-edit'] ?? d.status
        ),
        true
      ) +
      field(
        '来源渠道',
        'inventory-source',
        select(
          'inventory-source',
          choicesWithCurrent(config.sources, val('source')),
          val('source')
        ),
        type !== 'claude'
      ) +
      field(
        '注册时间',
        'inventory-registered',
        input(
          'inventory-registered',
          d['inventory-registered'] ?? (original ? registrationInput(original) : d.registered),
          'type="datetime-local"'
        ),
        false,
        '可留空，保存时取本条资料的录入时间。'
      ) +
      field(
        '录入时间',
        'inventory-createdAt',
        input(
          'inventory-createdAt',
          original ? original.createdAt || '历史未记录' : inventoryNow(),
          'readonly'
        ),
        false,
        '系统生成，编辑资料不会改变。'
      ) +
      field('登录设备', 'inventory-device',
        input('inventory-device', val('device'), type === 'google' ? 'maxlength="200"' : ''), type === 'claude' && !purchased && (!original || Boolean(original.device)));
    if (type === 'google' || type === 'gpt' || microsoft || personal)
      fields += wide(
        '2FA 密钥',
        'inventory-totp',
        input('inventory-totp', val('totp'), 'autocomplete="off"')
      );
    if (type === 'google' || microsoft)
      fields += wide(
        '辅助邮箱',
        'inventory-auxiliary',
        input('inventory-auxiliary', val('auxiliary'))
      );
    if (microsoft) {
      fields += field(
        '辅助邮箱取码方式', 'inventory-microsoft-recovery',
        select('inventory-microsoft-recovery', microsoftRecoveryOptions, d['inventory-microsoft-recovery'] ?? security.recoveryAccess ?? 'unknown'),
        false, '选择系统内邮箱时，辅助邮箱地址须对应唯一一条已有库存资料。'
      ) + field(
        '两步验证', 'inventory-microsoft-two-step',
        select('inventory-microsoft-two-step', microsoftTwoStepOptions, d['inventory-microsoft-two-step'] ?? security.twoStep ?? 'unknown')
      );
      const methods = microsoftVerificationOptions.map(([method, label]) => {
        const name = `inventory-microsoft-method-${method}`;
        const checked = d[name] ?? security.verificationMethods?.includes(method);
        return `<label class="checkbox-label"><input type="checkbox" id="${name}" name="${name}" ${checked ? 'checked' : ''} />${esc(label)}</label>`;
      }).join('');
      fields += wide(
        '验证方式', 'inventory-microsoft-methods',
        `<div class="inline-checks" id="inventory-microsoft-methods" role="group" aria-label="验证方式" tabindex="-1">${methods}</div>`
      ) + wide(
        '验证设备／审批人', 'inventory-microsoft-device',
        input('inventory-microsoft-device', d['inventory-microsoft-device'] ?? security.verificationDevice ?? '', 'maxlength="200"'),
        false, '需要手机确认或通行密钥时，可登记实际可用的设备或确认人。'
      );
    }
    if (type === 'google' || type === 'apple' || microsoft)
      fields += wide(
        '应用专用密码',
        'inventory-appPassword',
        input('inventory-appPassword', val('appPassword'), 'autocomplete="off"')
      );
    if (type === 'apple') {
      for (const keyName of ['security1', 'security2', 'security3'])
        fields += field(
          `密保 ${keyName.slice(-1)}`,
          `inventory-${keyName}`,
          input(`inventory-${keyName}`, val(keyName))
        );
      fields += field(
        '密保生日',
        'inventory-birthday',
        input('inventory-birthday', val('birthday'), 'type="date"')
      );
    }
    if (type === 'claude')
      fields +=
        field(
          '代理协议',
          'inventory-proxy-protocol',
          select(
            'inventory-proxy-protocol',
            [['', '选择代理协议'], ...proxyProtocols],
            (d['inventory-proxy-protocol'] ?? original?.proxyProtocol) || (original ? '' : 'socks5')
          )
        ) +
        wide(
          '注册代理链接',
          'inventory-proxy-url',
          input(
            'inventory-proxy-url',
            d['inventory-proxy-url'] ?? original?.proxyUrl ?? '',
            'placeholder="粘贴代理链接，自动填入下方四项"'
          ),
          !purchased && (!original || Boolean(original.proxyUrl)),
          '支持代理链接、主机:端口或主机:端口:账号:密码；带协议时自动识别。'
        ) +
        field(
          '代理主机',
          'inventory-proxy-host',
          input('inventory-proxy-host', d['inventory-proxy-host'] ?? original?.proxyHost ?? '')
        ) +
        field(
          '代理端口',
          'inventory-proxy-port',
          input(
            'inventory-proxy-port',
            d['inventory-proxy-port'] ?? original?.proxyPort ?? '',
            'inputmode="numeric"'
          )
        ) +
        field(
          '代理账号',
          'inventory-proxy-user',
          input('inventory-proxy-user', d['inventory-proxy-user'] ?? original?.proxyUser ?? '')
        ) +
        field(
          '代理密码',
          'inventory-proxy-pass',
          input(
            'inventory-proxy-pass',
            d['inventory-proxy-pass'] ?? original?.proxyPassword ?? '',
            'autocomplete="off"'
          )
        );
    fields +=
      wide('备注 1', 'inventory-notes', area('inventory-notes', val('notes'), '', 2)) +
      wide('备注 2', 'inventory-notes2', input('inventory-notes2', val('notes2')));
    showDrawer(
      original ? '编辑资料' : `新增${typeLabel(type)}`,
      localData
        ? '账号标识创建后不可修改。注册时间与系统入库时间分别保存。'
        : '账号标识创建后不可修改。注册时间与系统入库时间分别保存；资料只用于当前原型。',
      `<form id="inventory-asset-form" data-inventory-draft="${key}" novalidate><div class="form-grid">${fields}</div></form>`,
      button('取消', 'inventory-close') +
        '<button class="button primary" form="inventory-asset-form" type="submit">核对并保存</button>',
      key
    );
  }
  function locationSettingsButton(type, from = '', id = '') {
    return button('设置', 'inventory-location-settings', '', 'settings',
      `data-type="${esc(type)}" data-from="${esc(from)}" data-id="${esc(id)}"`);
  }
  function cityOptions(type, country) {
    const configured = settingsFor(type).cities;
    const values = Array.isArray(configured)
      ? configured.find((entry) => Array.isArray(entry) && entry[0] === country)?.[1]
      : undefined;
    return Array.isArray(values) ? values : defaultAccountCities.get(country) || [];
  }
  function accountCityChoices(type, country, original, current = '') {
    const values = settingsFor(type).countries.includes(country) ? cityOptions(type, country) : [];
    const choices = [
      [
        '',
        !country ? '请先选择注册国家' : values.length ? '请选择注册城市' : '请先在本表设置添加城市'
      ],
      ...values
    ];
    const previous = original?.country === country ? original.city : '';
    const withPrevious = choicesWithCurrent(choices, previous);
    if (
      current &&
      !withPrevious.some((choice) => (Array.isArray(choice) ? choice[0] : choice) === current)
    ) {
      return [...withPrevious, [current, `${current}（请重新选择）`]];
    }
    return withPrevious;
  }
  function accountLocationError(type, country, city, original) {
    if (original && (original.country || '') === country && (!usesRegistrationCity(type) || (original.city || '') === city)) return '';
    if (!country) return '缺少注册国家';
    if (!settingsFor(type).countries.includes(country)) return '注册国家未在本账号的国家地区设置启用';
    if (!usesRegistrationCity(type)) return '';
    if (!city) return '缺少地区／城市';
    return cityOptions(type, country).includes(city) ? '' : '地区／城市不在所选国家的设置中';
  }
  function settingsCountries(values, config) {
    const raw = values['inventory-settings-countries'];
    return [...new Set(raw === undefined ? config.countries : api.readOptionList(raw))];
  }
  function accountCityEditorId(country) {
    const token = Array.from(country, (char) => char.codePointAt(0).toString(16)).join('-');
    return `inventory-settings-city-${token}`;
  }
  function accountCityEditors(type, countries, draft) {
    return countries
      .map((country) =>
        api.optionListEditor({
          id: accountCityEditorId(country),
          label: `${country} · ${type === 'claude' ? '注册城市' : '地区／城市'}`,
          itemLabel: '地区／城市名称',
          values: cityOptions(type, country),
          minItems: 0,
          draft
        })
      )
      .join('');
  }
  function correctableUsage(link) {
    return Boolean(link?.occurredAt && (
      (link.kind === 'registration' && link.accountId && !link.registrationId) ||
      (link.kind === 'order-use' && link.orderId)
    ));
  }
  function usageAssetById(id) {
    return assetById(id) || (admin() && mailboxes.find((row) => row.type === 'relay' && row.id === id));
  }
  function mailboxPlatformChoices(asset) {
    const known = new Set(mailboxPlatforms(asset).map(([key]) => key));
    const hasAi = [...known].some(key => key !== 'apple');
    return (asset.type === 'relay' ? relayRegistrationPlatforms : registrationPlatforms)
      .filter(([key]) => !known.has(key) && (key === 'apple' || !hasAi));
  }
  function mailboxPlatformButton(asset) {
    return mailboxType(asset?.type) && asset.inventoryState === 'used' && (!localData || admin()) && mailboxPlatformChoices(asset).length
      ? button('标记注册平台', 'inventory-mailbox-platform', '', 'edit', `data-id="${esc(asset.id)}"`)
      : '';
  }
  function openMailboxPlatform(id) {
    const asset = usageAssetById(id);
    if (!mailboxPlatformButton(asset)) return;
    const choices = mailboxPlatformChoices(asset);
    if (!choices.length) { api.notify('该邮箱的可选平台均已登记'); return; }
    const key = `inventory-mailbox-platform:${id}`;
    const saved = draft(key);
    showDrawer('标记注册平台', '补录已核实的平台注册用途，保留原使用时间和领用批次。',
      `<form id="inventory-mailbox-platform-form" data-inventory-draft="${esc(key)}" novalidate><input type="hidden" name="inventory-platform-asset" value="${esc(id)}" /><input type="hidden" name="inventory-platform-version" value="${esc(saved['inventory-platform-version'] ?? asset.version)}" /><div class="form-grid">${wide('邮箱账号', 'inventory-platform-email', input('inventory-platform-email', asset.email, 'readonly'))}${field('已登记平台', 'inventory-platform-known', input('inventory-platform-known', mailboxPlatformLabel(asset), 'readonly'))}${field('注册平台', 'inventory-platform-product', select('inventory-platform-product', [['', '请选择已注册平台'], ...choices], saved['inventory-platform-product'] || ''), true)}</div></form>`,
      button('取消', 'inventory-close') +
        (saved['inventory-platform-version'] && Number(saved['inventory-platform-version']) !== asset.version
          ? button('重新核对当前记录', 'inventory-platform-review', '', '', `data-id="${esc(id)}"`) : '') +
        '<button class="button primary" form="inventory-mailbox-platform-form" type="submit">保存标记</button>', key);
  }
  function submitMailboxPlatform(form) {
    const data = api.readForm(form);
    const id = data['inventory-platform-asset'];
    const product = data['inventory-platform-product'];
    const choice = registrationPlatforms.find(([key]) => key === product);
    if (!choice) { api.setError('inventory-platform-product', '请选择已核实的注册平台'); return; }
    const version = Number(data['inventory-platform-version']);
    const eligible = () => {
      const asset = usageAssetById(id);
      return asset && mailboxPlatformButton(asset) && asset.version === version &&
        mailboxPlatformChoices(asset).some(([key]) => key === product) ? asset : null;
    };
    if (!eligible()) { api.notify('邮箱或平台标记已变化，请重新核对；输入已保留'); return; }
    confirmInventoryChange('确认登记注册结果', `确认此邮箱已注册 ${choice[1]}，保存后保留原有使用记录。`, () => {
      const asset = eligible();
      if (!asset) { api.notify('确认期间邮箱已变化，请重新核对'); return; }
      asset.usageLinks.push({ kind: 'registration', product, label: `人工登记 · 已注册 ${choice[1]}`, time: inventoryNow() });
      log(asset, '标记注册平台', choice[1]);
      return () => { finishDrawer(form.dataset.inventoryDraft); api.render(); api.notify('注册平台已保存'); };
    });
  }
  function personalRegistrationButtons(asset) {
    if ((!admin() && localData) || !asset || !['google', 'relay'].includes(asset.type)) return '';
    return (asset.type === 'relay' ? ['grok'] : ['gemini', 'grok'])
      .filter(type => personalSourceMailboxes(type).some(row => row.id === asset.id))
      .map(type => button('登记' + typeLabel(type), 'inventory-personal-registration', '', 'plus',
        'data-id="' + esc(asset.id) + '" data-type="' + type + '"')).join('');
  }
  function usageDetails(asset) {
    const links = (asset.usageLinks || []).map((link, index) => {
      const action = localData && admin() && correctableUsage(link)
        ? button('更正关联', 'inventory-usage-correction', '', '',
            `data-id="${esc(asset.id)}" data-index="${index}"`)
        : '';
      const reference = link.accountId || link.orderId || link.taskId;
      const details = [link.label || '使用登记', reference, link.time].filter(Boolean).join(' · ');
      const account = link.accountId && assetById(link.accountId);
      const linked = account && stockType(account.type) && api.canVisit('accounts/' + account.type)
        ? button('查看关联账号', 'inventory-detail', '', '', 'data-id="' + esc(account.id) + '"') : '';
      return `<div class="toolbar"><p>${esc(details)}</p>${linked}${action}</div>`;
    });
    const corrections = (asset.usageCorrections || []).map((row) =>
      `<div class="guide-item"><strong>已更正 · ${esc(row.originalLink.label || '使用登记')}</strong><p>${esc(row.time)} · ${esc(row.actor)} · ${esc(row.reason)}</p></div>`
    );
    return links.length || corrections.length
      ? `<section class="form-section"><h3>使用关联</h3>${links.join('')}${corrections.join('')}</section>`
      : '';
  }
  function openUsageCorrection(id, index) {
    const asset = usageAssetById(id);
    const link = asset?.usageLinks[index];
    if (!localData || !admin() || !correctableUsage(link)) return;
    const key = `inventory-usage-correction:${id}:${link.accountId || link.orderId}`;
    const reason = draft(key)['inventory-usage-correction-reason'];
    showDrawer(
      '更正使用关联',
      '更正后会保留原依据，并根据其他使用记录重新核对库存状态。',
      `<div class="property-list"><div class="property-row"><span>邮箱 / 账号</span><strong>${esc(displayIdentity(asset))}</strong></div><div class="property-row"><span>原使用关联</span><strong>${esc(link.label)}</strong></div></div><form id="inventory-usage-correction-form" data-inventory-draft="${esc(key)}" data-asset-id="${esc(id)}" data-link-index="${index}" data-version="${localInventoryVersion}" novalidate>${field('更正理由', 'inventory-usage-correction-reason', area('inventory-usage-correction-reason', reason || '', '填写误关联的依据'), true)}</form>`,
      button('返回详情', 'inventory-detail', '', '', `data-id="${esc(id)}"`) +
        '<button class="button primary" type="submit" form="inventory-usage-correction-form">核对更正</button>',
      key
    );
  }
  function submitUsageCorrection(form) {
    const reason = String(api.readForm(form)['inventory-usage-correction-reason'] || '').trim();
    if (!reason || reason.length > 300) {
      api.setError('inventory-usage-correction-reason', '请填写 1–300 字的更正理由');
      return;
    }
    const { assetId, linkIndex, version, inventoryDraft } = form.dataset;
    const asset = usageAssetById(assetId);
    const index = Number(linkIndex);
    if (!localData || !admin() || !correctableUsage(asset?.usageLinks[index]) ||
        Number(version) !== localInventoryVersion) {
      api.notify('资料已变化，请重新打开详情后更正');
      return;
    }
    const route = api.state.route;
    api.confirmAction('确认更正使用关联',
      `${asset.email} · ${asset.usageLinks[index].label}。系统会保留原关联和更正记录。`,
      async () => {
        if (inventorySavePending) return;
        inventorySavePending = true;
        try {
          const saved = await localData.save('inventory/usage-correction', Number(version), {
            assetId, linkIndex: index, reason
          });
          applyCommittedInventory(saved);
          if (api.state.route === route && form.isConnected &&
              String(api.readForm(form)['inventory-usage-correction-reason'] || '').trim() === reason) {
            finishDrawer(inventoryDraft);
            api.render();
            assetDetail(assetId);
          }
          api.notify('使用关联已更正，原依据已保留');
        } catch (error) {
          if (error?.status === 409) await readLocalInventory({ keepContent: true });
          api.notify(error?.message || '更正未保存，请重新核对');
        } finally {
          inventorySavePending = false;
        }
      }, '确认更正'
    );
  }
  function accountLifecycleActions(asset) {
    const summary = accountSummaries.get(asset.id);
    if (!localData || !admin() || !summary?.systemOwned || asset.inventoryState !== 'used' || historicallyOpened(asset)) return '';
    return `<div class="toolbar">${button('恢复可用库存', 'inventory-account-lifecycle', '', 'return', `data-id="${esc(asset.id)}" data-operation="release"`)}${summary.disposition !== 'retired' ? button('停止复用', 'inventory-account-lifecycle', '', '', `data-id="${esc(asset.id)}" data-operation="retire"`) : ''}</div>`;
  }
  function accountLifecycleDetails(asset) {
    const summary = accountSummaries.get(asset.id);
    if (!summary) return '';
    const kyc = summary.latestKyc;
    const values = [['当前使用情况', summary.label], ['当前客户', summary.customer],
      ['最近回收时间', summary.lastRecoveredAt || '未回收'],
      ...(asset.type === 'claude' ? [['当前 KYC 核实', summary.currentKyc], ['历史 KYC', kyc?.kyc || '未记录'],
        ['历史认证人', kyc?.verifier || '未记录'], ['历史认证电话', kyc?.verifierPhone || '未记录'],
        ['历史认证租户', kyc?.tenant || '未记录'], ['认证来源订单', kyc?.orderNo || '未记录']] : [])];
    const columns = [
      { id: 'orderNo', label: '订单编号' }, { id: 'customer', label: '历史客户' },
      { id: 'businessType', label: '业务类型' }, { id: 'payment', label: '付款方式' },
      { id: 'paymentId', label: '付款账号／尾号' },
      { id: 'paidAmount', label: '原代付金额', render: row => esc([row.paidAmount, row.paidCurrency].filter(Boolean).join(' ') || '待补充') },
      { id: 'paidConfirmed', label: '付款确认', render: row => esc(row.paidConfirmed ? '已确认' : '待核对') },
      ...(asset.type === 'claude' ? [{ id: 'kyc', label: 'KYC 记录' }, { id: 'verifier', label: '认证人' }, { id: 'verifierPhone', label: '认证电话' }] : []),
      { id: 'released', label: '客户使用关系', render: row => esc(row.released ? '已结束' : '保留中') },
      { id: 'actions', label: '操作', action: true, render: row => textAction('原订单', 'inventory-lifecycle-order', `data-id="${esc(row.id)}"`) }
    ];
    const labels = { release: '恢复可用库存', retire: '停止复用', assign: '分配客户', renew: '原客户续费' };
    return `<section class="form-section"><h3>账号使用与回收</h3><div class="property-list">${values.map(([label, value]) => `<div class="property-row"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join('')}</div>${accountLifecycleActions(asset)}</section><section class="form-section account-lifecycle-history"><h3>历史订单、付款与认证资料</h3>${summary.orders.length ? table(columns, summary.orders, '', '账号历史订单') : empty('暂无明确关联订单', '历史来源不明时保留待核对，不按邮箱猜测归属。')}</section><section class="form-section"><h3>分配与回收记录</h3>${summary.events.length ? `<ul class="timeline">${summary.events.slice().reverse().map(event => `<li><div><strong>${esc(labels[event.action] || '历史记录')}</strong><p>${esc(event.time)} · ${esc(event.actor || '历史未记录')}${event.reason ? ` · ${esc(event.reason)}` : ''}</p></div></li>`).join('')}</ul>` : empty('暂无回收记录', '原始使用记录继续保留。')}</section>`;
  }
  let accountLifecycleOpenGeneration = 0;
  async function openAccountLifecycle(id, operation, review = false) {
    if (!localData?.changeAccountLifecycle || !admin()) return;
    const generation = ++accountLifecycleOpenGeneration, route = api.state.route;
    const origin = document.querySelector('#drawer[open]')?.firstElementChild;
    if (!await readLocalInventory({ keepContent: true })) return api.notify('暂时无法核对库存，请重试');
    if (generation !== accountLifecycleOpenGeneration || route !== api.state.route ||
      document.querySelector('#drawer[open]')?.firstElementChild !== origin) return;
    const asset = assetById(id), summary = accountSummaries.get(id);
    if (!asset || !summary?.systemOwned || asset.inventoryState !== 'used') return api.notify('账号状态已变化，请刷新后重新选择');
    const key = `inventory-account-lifecycle:${id}:${operation}`;
    const saved = draft(key);
    if (review) {
      saved['inventory-lifecycle-version'] = localInventoryVersion;
      saved['inventory-lifecycle-commerce-version'] = lifecycleCommerceVersion;
      saved['inventory-lifecycle-asset-version'] = asset.version;
      saved['inventory-lifecycle-command-id'] = uid('account-lifecycle');
      for (const name of ['controlled', 'access', 'tasks', 'early']) delete saved[`inventory-lifecycle-${name}`];
      api.state.drafts.set(key, saved);
    }
    const title = operation === 'release' ? '恢复可用库存' : '停止复用';
    const checked = name => saved[`inventory-lifecycle-${name}`] === 'on' ? ' checked' : '';
    const confirmation = (name, label, text) => field(label, `inventory-lifecycle-${name}`,
      `<label class="checkbox-label"><input id="inventory-lifecycle-${name}" name="inventory-lifecycle-${name}" type="checkbox"${checked(name)}><span>${text}</span></label>`, true);
    showDrawer(title, '结束本系统的客户占用，保留原订单、付款、认证和领用记录；不更改平台订阅或执行退款。',
      `<div class="property-list"><div class="property-row"><span>账号邮箱</span><strong>${esc(displayIdentity(asset))}</strong></div><div class="property-row"><span>当前客户</span><strong>${esc(summary.customer)}</strong></div><div class="property-row"><span>处理结果</span><strong>${operation === 'release' ? '进入可用库存，标记回收复用' : '保留已使用，标记不再复用'}</strong></div></div><form id="inventory-account-lifecycle-form" data-inventory-draft="${esc(key)}" novalidate>
      ${[['id', id], ['operation', operation], ['version', saved['inventory-lifecycle-version'] ?? localInventoryVersion],
        ['commerce-version', saved['inventory-lifecycle-commerce-version'] ?? lifecycleCommerceVersion],
        ['asset-version', saved['inventory-lifecycle-asset-version'] ?? asset.version],
        ['command-id', saved['inventory-lifecycle-command-id'] || uid('account-lifecycle')]].map(([name, value]) => `<input type="hidden" name="inventory-lifecycle-${name}" value="${esc(value)}">`).join('')}
      <div class="form-grid">${wide('处理原因', 'inventory-lifecycle-reason', area('inventory-lifecycle-reason', saved['inventory-lifecycle-reason'] || '', '记录客户结束使用或停止复用的原因'), true)}
      ${confirmation('controlled', '账号控制权', '已确认账号仍由我们控制')}${confirmation('access', '客户访问', '已核对并处理原客户的访问权限')}${confirmation('tasks', '执行任务', '已核对没有执行中任务或未知付款结果')}
      ${field('未到期处理', 'inventory-lifecycle-early', `<label class="checkbox-label"><input id="inventory-lifecycle-early" name="inventory-lifecycle-early" type="checkbox"${checked('early')}><span>如订阅仍未到期，我确认提前结束本次客户使用</span></label>`)}
      </div><div id="inventory-lifecycle-error" class="field-error" role="alert" hidden></div></form>`,
      button('取消', 'inventory-close') + `<button class="button primary" type="submit" form="inventory-account-lifecycle-form">核对并${title}</button>`, key);
  }
  function submitAccountLifecycle(form) {
    const values = api.readDraft(form);
    const reason = String(values['inventory-lifecycle-reason'] || '').trim();
    api.setError('inventory-lifecycle-reason', reason && reason.length <= 300 ? '' : '请填写 1–300 字处理原因');
    if (!reason || reason.length > 300) return;
    const data = { assetId: values['inventory-lifecycle-id'], action: values['inventory-lifecycle-operation'],
      assetVersion: Number(values['inventory-lifecycle-asset-version']), commandId: values['inventory-lifecycle-command-id'], reason,
      controlled: values['inventory-lifecycle-controlled'] === 'on', accessReviewed: values['inventory-lifecycle-access'] === 'on',
      tasksReviewed: values['inventory-lifecycle-tasks'] === 'on', endEarly: values['inventory-lifecycle-early'] === 'on' };
    const body = { version: Number(values['inventory-lifecycle-version']), commerceVersion: Number(values['inventory-lifecycle-commerce-version']), data };
    const fingerprint = JSON.stringify(values), key = form.dataset.inventoryDraft, route = api.state.route;
    api.confirmAction(data.action === 'release' ? '确认恢复可用库存' : '确认停止复用',
      '保留全部原订单、付款、KYC 与历史记录，只更新本次客户使用关系。', () => {
        if (!form.isConnected || api.state.route !== route || JSON.stringify(api.readDraft(form)) !== fingerprint)
          return api.notify('确认期间输入已变化，请重新核对');
        const submit = document.querySelector('[form="inventory-account-lifecycle-form"][type="submit"]');
        if (inventorySavePending) return;
        inventorySavePending = true;
        if (submit) submit.disabled = true;
        void localData.changeAccountLifecycle(body).then(result => {
          applyCommittedInventory(result);
          const unchanged = form.isConnected && api.state.route === route && JSON.stringify(api.readDraft(form)) === fingerprint;
          if (unchanged) { form.removeAttribute('data-inventory-draft'); finishDrawer(key); api.render(); }
          else if (JSON.stringify(api.state.drafts.get(key)) === fingerprint) api.state.drafts.delete(key);
          api.notify('账号使用处理已保存，原历史资料保留');
        }).catch(async error => {
          if (!error.status || error.status === 409) await readLocalInventory({ keepContent: true });
          const receipt = assetById(data.assetId)?.accountLifecycleEvents?.find(event => event.id === data.commandId);
          if (receipt && receipt.action === data.action && receipt.actorId === currentActor().id && receipt.request?.reason === reason && form.isConnected && JSON.stringify(api.readDraft(form)) === fingerprint) {
            form.removeAttribute('data-inventory-draft'); finishDrawer(key); api.render();
            return api.notify('已回读确认该操作保存成功');
          }
          if (form.isConnected) {
            api.setError('inventory-lifecycle', error.message || '保存结果未确认，输入保留；可原样重试核对回执');
            if (error.status === 409) form.querySelector('#inventory-lifecycle-error').insertAdjacentHTML('beforeend',
              button('重新核对', 'inventory-lifecycle-review', '', '', `data-id="${esc(data.assetId)}" data-operation="${esc(data.action)}"`));
          }
        }).finally(() => { inventorySavePending = false; if (submit?.isConnected) submit.disabled = false; });
      });
  }
  function assetDetail(id) {
    const asset = usageAssetById(id);
    if (!asset) return;
    if (asset.type === 'relay') {
      if (api.modules.appleRelay) api.modules.appleRelay.openAliasDetail(id);
      else api.notify('隐藏邮箱管理尚未就绪，请刷新页面后重试');
      return;
    }
    const claim = pendingClaim(asset);
    const microsoft = asset.type === 'microsoft';
    const personal = personalAccount(asset.type);
    const source = stockType(asset.type) && ((asset.sourceMailboxId && usageAssetById(asset.sourceMailboxId)) || mailboxes.find(row =>
      registrationAddress(row.email) === registrationAddress(asset.email) &&
      (row.type !== 'relay' || !localData || canExtractLocalRelay()) && mailboxRegistrationAccount(row)?.id === asset.id));
    const sourceClaim = source && mailboxClaim(source);
    const security = asset.microsoftSecurity;
    const recoveryMailbox = microsoft && microsoftRecoveryMailbox(asset);
    const rows = [
      ['资料编号', asset.id],
      ['邮箱 / 账号', displayIdentity(asset)],
      [microsoft ? '登录密码' : '密码', asset.password || (security?.loginMode === 'passwordless' ? '无密码登录' : '未填写')],
      ['资料类型', typeLabel(asset.type)],
      ...(personal ? [
        ['登录方式', choiceLabel(grokLoginOptions, asset.loginMethod)],
        ['订阅邮箱', asset.email || '未登记'],
        ['平台账号编号', asset.platformAccountId || '未登记'],
        ...(asset.type === 'grok' ? [['X @账号', asset.xHandle || '未登记'],
          ['X 绑定状态', choiceLabel(xLinkOptions, asset.xLinkState)]] : [])
      ] : isAccount(asset) ? [['邮箱类型', accountEmailType(asset)]] : []),
      ...(stockType(asset.type) ? [
        ['账号来源', acquisitionLabel(asset.acquisitionMethod)],
        ['来源邮箱', source?.email || (asset.sourceMailboxId ? '待核对' : '未关联')],
        ...(sourceClaim ? [['邮箱领用批次', sourceClaim.label]] : [])
      ] : []),
      [isAccount(asset) ? '注册国家' : '国家地区', asset.country || '未填写'],
      ...(usesRegistrationCity(asset.type) ? [['注册城市', asset.city || '未填写']] : []),
      ['来源渠道', asset.source || '未填写'],
      ['账号状态', { normal: asset.status, dead: '死号', unlocking: '解封中' }[asset.health]],
      ...(asset.claudeHistory ? [['历史登记状态', claudeHistoryStates[asset.claudeHistory.phase]]] : []),
      [
        '使用状态',
        isAccount(asset) ? accountSummaries.get(asset.id)?.label || mailUseLabels[displayInventoryState(asset)] :
          mailUseLabels[mailUse(asset)] || '未登记'
      ],
      ...(mailboxType(asset.type) ? [['注册平台', mailboxPlatformLabel(asset)]] : []),
      ['注册时间', registrationTime(asset) || '未提供'],
      ['录入人', asset.createdBy || '历史未记录'],
      ['录入人编号', asset.createdById, 'operatorId'],
      ['录入时间', asset.createdAt || '历史未记录'],
      ['最近操作人', asset.lastOperatedBy || '历史未记录'],
      ['最近操作人编号', asset.lastOperatedById, 'operatorId'],
      ['最近操作时间', asset.lastOperatedAt || '历史未记录'],
      ['登录设备', asset.device || '未填写'],
      ['备注 1', asset.notes || '未填写'],
      ['备注 2', asset.notes2 || '未填写']
    ];
    if (microsoft)
      rows.push(
        ['登录方式', choiceLabel(microsoftLoginModes, security?.loginMode)],
        ['辅助邮箱取码方式', microsoftRecoveryLabel(asset)],
        ['两步验证', choiceLabel(microsoftTwoStepOptions, security?.twoStep, '未核验')],
        ['验证方式', microsoftVerificationLabel(asset)],
        ['验证设备／审批人', security?.verificationDevice || '未填写']
      );
    if (['google', 'gpt', 'microsoft'].includes(asset.type) || personal) rows.push(['2FA 密钥', asset.totp || '未填写']);
    if (['google', 'microsoft'].includes(asset.type)) rows.push(['辅助邮箱', asset.auxiliary || '未填写']);
    if (['google', 'apple', 'microsoft'].includes(asset.type))
      rows.push(
        ['绑定电话／验证码', asset.phone || '未绑定或未记录'],
        ['应用专用密码', asset.appPassword || '未填写']
      );
    if (asset.type === 'relay')
      rows.push(
        ['主邮箱编号', api.modules.appleRelay?.displayId('parent', asset.parentMailboxId) || '待接入'],
        ['隐藏邮箱编号', api.modules.appleRelay?.displayId('alias', asset) || '待接入'],
        ['查询码', asset.queryCode || '未填写'],
        ['查询码到期', asset.queryExpiry || '未填写']
      );
    if (asset.purpose || asset.claimedAt || asset.usedAt || asset.extractionNotes)
      rows.push(
        ['提取用途', asset.purpose || '未填写'],
        ['提取时间', asset.claimedAt || asset.usedAt || '未记录'],
        ['提取备注', asset.extractionNotes || '未填写']
      );
    if (asset.actualUsedAt) rows.push(['实际使用时间', asset.actualUsedAt]);
    if (['dead', 'unlocking'].includes(asset.health))
      rows.push([asset.health === 'dead' ? '死号时间' : '进入解封中时间', healthChangeTime(asset)]);
    if (asset.type === 'apple')
      rows.push(
        ['密保 1', asset.security1 || '未填写'],
        ['密保 2', asset.security2 || '未填写'],
        ['密保 3', asset.security3 || '未填写'],
        ['密保生日', asset.birthday || '未填写']
      );
    if (asset.type === 'claude')
      rows.push(
        ['养号时长', ageLabel(asset)],
        ['KYC 状态', accountKyc(asset)],
        ['注册 IP 链接', asset.proxyUrl || '未填写'],
        [
          '代理类型',
          { http: 'HTTP', https: 'HTTPS', socks5: 'SOCKS5' }[asset.proxyProtocol] || '未填写'
        ],
        ['代理主机', asset.proxyHost || '未填写'],
        ['代理端口', asset.proxyPort || '未填写'],
        ['代理账号', asset.proxyUser || '未填写'],
        ['代理密码', asset.proxyPassword || '未填写']
      );
    const history = asset.inventoryHistory.length
      ? `<ul class="timeline">${asset.inventoryHistory
          .slice()
          .reverse()
          .map(
            (entry) =>
              `<li><div><strong>${esc(entry.action === '健康状态变化' ? '账号状态变化' : entry.action)}</strong><p>${esc(entry.time)} · ${esc(entry.actor)} · ${esc(entry.detail)}</p></div></li>`
          )
          .join('')}</ul>`
      : empty('暂无操作记录', '新增、修改、提取和归还都会记录。');
    const properties = rows.map(([name, value, kind]) =>
      kind === 'operatorId'
        ? api.operatorIdProperty(name, value)
        : `<div class="property-row"><span>${esc(name)}</span><strong>${name === '绑定电话／验证码' ? phoneValue(value) : esc(value)}</strong></div>`
    ).join('');
    showDrawer(
      '资料详情',
      '资料、提取、实际使用、归还和任务来源保持关联。',
      `<div class="property-list">${properties}</div>${source ? button('查看来源邮箱', 'inventory-detail', '', 'mail', `data-id="${esc(source.id)}"`) : ''}${sourceClaim ? button('查看邮箱领用批次', 'inventory-batch', '', 'orders', `data-id="${esc(sourceClaim.id)}"`) : ''}${recoveryMailbox ? button('查看辅助邮箱资料', 'inventory-detail', '', 'mail', `data-id="${esc(recoveryMailbox.id)}"`) : ''}${claim ? button('查看原提取批次', 'inventory-batch', '', 'orders', `data-id="${claim.batch.id}"`) : ''}${accountLifecycleDetails(asset)}${usageDetails(asset)}<section class="form-section"><h3>操作记录</h3>${history}</section>`,
      button('关闭', 'inventory-close') + mailboxPlatformButton(asset) + personalRegistrationButtons(asset)
    );
  }
  function assetMore(id, node) {
    const asset = assetById(id);
    if (!asset) return;
    api.openActionMenu(node, mailboxPlatformButton(asset) + `<div class="property-list"><div class="property-row"><span>邮箱 / 账号</span><strong>${esc(displayIdentity(asset))}</strong></div></div><div class="guide-list"><div class="guide-item"><h3>账号状态</h3><div class="toolbar">${asset.health === 'normal' ? button('移入死号', 'inventory-health', 'danger', '', `data-id="${id}" data-health="dead"`) + button('移入解封中', 'inventory-health', '', '', `data-id="${id}" data-health="unlocking"`) : button('恢复资料', 'inventory-health', '', 'return', `data-id="${id}" data-health="normal"`)}</div></div><div class="guide-item"><h3>使用与归还</h3><div class="toolbar">${accountLifecycleActions(asset)}${asset.inventoryState === 'claimed' ? button('归还资料', 'inventory-return-asset', '', 'return', `data-id="${id}"`) : ''}${asset.type === 'relay' || asset.type === 'google' || asset.type === 'apple' ? button('登记注册结果', 'inventory-register', '', 'play', `data-id="${id}"`) : ''}${button('查看记录', 'inventory-detail', '', 'orders', `data-id="${id}"`)}</div></div><div class="guide-item"><h3>资料更正</h3><div class="toolbar">${button('撤回最近修改', 'inventory-undo', '', 'return', `data-id="${id}" ${undo.has(id) ? '' : 'disabled'}`)}${asset.health === 'dead' && asset.type !== 'relay' ? button('永久删除', 'inventory-delete', 'danger', '', `data-id="${id}"`) : ''}</div></div>${asset.type === 'relay' ? `<div class="guide-item"><h3>邮箱操作</h3><div class="toolbar">${button('查看邮件', 'inventory-mail-read', '', 'mail', `data-id="${id}"`)}${button('复制查询码', 'inventory-copy-query', '', 'copy', `data-id="${id}"`)}</div></div>` : ''}</div>`);
  }
  const workspaceRecordTimeFormat = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });
  function workspaceRecordTime(value) {
    if (!value) return '时间未记录';
    const at = /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
    return Number.isFinite(at) ? workspaceRecordTimeFormat.format(at) : value;
  }
  function recentImportRecord(row) {
    return `<li><strong class="inventory-import-type">${esc(typeLabel(row.type))}</strong><span class="inventory-import-status">${tag(row.status || '已导入', row.failed ? 'warning' : 'success')}</span><span class="inventory-import-count">成功 ${esc(row.success ?? '未记录')} 条${row.failed ? `<span class="inventory-import-errors">错误 ${esc(row.failed)} 行</span>` : ''}</span><span class="inventory-import-actor">${esc(row.actor || '未记录')}</span><time class="inventory-import-time" title="北京时间">${esc(workspaceRecordTime(row.time))}</time><div class="inventory-import-actions">${textAction('详情', 'inventory-import-detail', `data-id="${esc(row.id)}"`)}</div></li>`;
  }
  function submissionPanel(accountEntry = false) {
    const choices = accountEntry ? accountSubmissionTypes : mailboxSubmissionTypes();
    const relayResults = accountEntry ? [] : (api.state.drafts.get('inventory-relay-entry-results')?.ids || []).map(assetById).filter(asset => asset?.type === 'relay');
    const results = relayResults.length ? `<section class="panel result-panel"><div class="panel-heading"><h2>本次隐藏邮箱录入结果</h2>${button('继续录入', 'inventory-add-type', '', 'plus', 'data-type="relay"')}</div>${table([
      { id: 'email', label: '隐藏邮箱' },
      { id: 'parent', label: '所属主邮箱', render: row => esc(api.modules.appleRelay?.getParent(row.parentMailboxId)?.email || '—') },
      { id: 'createdAt', label: '录入时间' },
      { id: 'result', label: '结果', render: () => tag('已登记', 'success') },
      { id: 'actions', label: '操作', action: true, render: row => textAction('复制邮箱地址', 'inventory-relay-entry-copy', `data-id="${esc(row.id)}"`) }
    ], relayResults, '', '快捷隐藏邮箱录入结果')}</section>` : '';
    const scope = accountEntry ? 'account' : 'mail';
    const recent = scopedImportRecords('', scope).slice(0, 5);
    return `<section class="panel inventory-submission-panel" aria-labelledby="inventory-submission-heading">${workspaceHeading('提交资料', accountEntry
      ? '选择账号类型后单条录入或批量导入。抽屉关闭后保留草稿；苹果 ID 仅录入资料，余额另行记账。'
      : '选择邮箱类型后单条录入或批量预检。隐藏邮箱须关联所属主邮箱；不同类型的草稿独立保留。', 'inventory-submission-heading', 'upload', 'teal')}<div class="panel-body"><div class="submission-grid">${choices
        .map(
          ([type, label]) =>
            `<div class="guide-item"><div class="inventory-submission-title"><h3>${esc(label)}</h3><div class="action-links">${accountEntry && usesAccountLocation(type) ? textAction('设置', 'inventory-location-settings', `data-type="${type}"`) : ''}${accountEntry ? textAction('账号管理', 'inventory-go', `data-route="accounts/${type === 'apple' ? 'apple-balances' : type}"`) : ''}</div></div><div class="toolbar">${button(type === 'relay' ? '登记隐藏邮箱' : '单条录入', 'inventory-add-type', '', 'plus', `data-type="${type}"`)}${button('批量导入', 'inventory-import', '', 'upload', `data-type="${type}"`)}</div></div>`
        )
        .join(
          ''
        )}</div></div>${results}<div class="panel-heading"><h3>近期导入</h3>${button('全部导入', 'inventory-entry-imports')}</div><div class="panel-body inventory-workspace-history" tabindex="0" aria-label="近期导入列表">${recent.length ? `<ul class="inventory-workspace-records inventory-import-records">${recent.map(recentImportRecord).join('')}</ul>` : empty('暂无导入记录', '完成批量导入后在这里查看结果。')}</div></section>`;
  }
  function scopedImportRecords(type = '', scope = '') {
    const rows = [...importRecords, ...(api.modules.appleRelay?.listImports?.() || [])].filter(
      (record) =>
        (!type || record.type === type || record.types?.includes(type)) &&
        (!scope ||
          (record.types || [record.type]).every((id) =>
            scope === 'account'
              ? accountEntryType(id)
              : mailboxSubmissionTypes().some(([typeId]) => typeId === id)
          ))
    );
    return window.IDListOrder.sortByRecordTime(rows, row => row.time);
  }
  function importList(type = '', scope = '', rows = scopedImportRecords(type, scope)) {
    return rows.length
      ? table(
          [
            { id: 'id', label: '导入批次', render: (row) =>
              esc(row.type === 'relay' ? api.modules.appleRelay?.displayImportId?.(row.id) ?? row.id : row.id) },
            { id: 'type', label: '资料类型', render: (row) => typeLabel(row.type) },
            { id: 'time', label: '导入时间' },
            { id: 'actor', label: '操作人' },
            { id: 'total', label: '总数' },
            { id: 'success', label: '成功' },
            { id: 'failed', label: '错误行' },
            { id: 'status', label: '结果' },
            {
              id: 'actions',
              label: '操作',
              action: true,
              render: (row) => textAction('详情', 'inventory-import-detail', `data-id="${row.id}"`)
            }
          ],
          rows,
          '',
          '导入记录'
        )
      : empty('暂无导入记录', '完成预检与确认导入后保留批次。');
  }
  function openEntryImports() {
    saveDrafts();
    const scope = accountSubmissionRoute() ? 'account' : 'mail';
    const key = `inventory-entry-imports:${scope}`;
    const rows = scopedImportRecords('', scope);
    const saved = draft(key, { page: 1, pageSize: window.IDPagination.defaultPageSize });
    saved.page = Math.min(saved.page, Math.max(1, Math.ceil(rows.length / saved.pageSize)));
    api.state.drafts.set(key, saved);
    showDrawer(accountSubmissionRoute() ? '账号导入记录' : '邮箱导入记录', '按导入时间倒序排列，可查看每个批次的完整明细。',
      importList('', scope, rows.slice((saved.page - 1) * saved.pageSize, saved.page * saved.pageSize)) +
        window.IDPagination.render({ id: key, ...saved, total: rows.length }),
      button('关闭', 'inventory-close'));
  }
  document.addEventListener?.('id-pagination-change', event => {
    const key = `inventory-entry-imports:${accountSubmissionRoute() ? 'account' : 'mail'}`;
    if (event.detail.id !== key || !event.target.closest('#drawer[open]') ||
        !/^workspace\/(account|mail)-(extract|submit)$/.test(api.state.route)) return;
    api.state.drafts.set(key, { page: event.detail.page, pageSize: event.detail.pageSize });
    openEntryImports();
  });
  function parseRegistrationProxySafe(value) {
    try { return value ? parseRegistrationProxy(value) : {}; } catch { return {}; }
  }
  function openClaudeHistoryIntake() {
    if (!localData || !admin() || !['accounts/claude', 'subscriptions/claude'].includes(api.state.route)) return;
    saveDrafts();
    preparedClaudeHistory = null;
    const subscription = api.state.route === 'subscriptions/claude';
    const fields = subscription ? claudeHistoryFields : claudeHistoryFields.filter(([, key]) => !['plan', 'start', 'expiry'].includes(key));
    const draftKey = claudeHistoryKey + (subscription ? ':subscription' : ':account');
    const header = fields.map(([label]) => label).join('\t');
    const content = draft(draftKey)[claudeHistoryContentId] ?? header + '\n';
    showDrawer(subscription ? 'Claude 订阅历史入库' : 'Claude 历史账号入库', subscription
      ? '登记已开通的 Claude 历史订阅，不生成订单。' : '登记养号中或死号的历史账号。',
      `<form id="${claudeHistoryKey}-form" data-history-kind="${subscription ? 'subscription' : 'account'}" data-inventory-draft="${draftKey}" novalidate><div class="form-grid">${
        wide('历史资料', claudeHistoryContentId, area(claudeHistoryContentId, content, '', 8), true,
          subscription ? '按表头粘贴表格或 CSV，仅登记已开通账号，填写套餐及开通、到期时间。' : '按表头粘贴表格或 CSV，登记状态填写养号中或死号。订阅历史请到订阅管理登记。')
      }</div><div id="${claudeHistoryKey}-review" class="section-gap" aria-live="polite"></div></form>`,
      button('取消', 'inventory-close') + button('预检资料', 'inventory-claude-history-preview') +
      `<button class="button primary" form="${claudeHistoryKey}-form" type="submit" disabled>确认入库</button>`,
      draftKey);
  }
  function claudeHistoryFormCurrent(form, content) {
    return form.closest('#drawer[open]') && api.state.route ===
      (form.dataset.historyKind === 'subscription' ? 'subscriptions/claude' : 'accounts/claude') &&
      form.elements.namedItem(claudeHistoryContentId)?.value === content;
  }
  function claudeHistorySubmitButton() {
    return document.querySelector('button[form="' + claudeHistoryKey + '-form"][type="submit"]');
  }
  async function previewClaudeHistory(form) {
    if (!form || form.dataset.checking || inventorySavePending) return;
    const content = form.elements.namedItem(claudeHistoryContentId).value;
    const review = form.querySelector('#' + claudeHistoryKey + '-review');
    const submit = claudeHistorySubmitButton();
    preparedClaudeHistory = null;
    submit.disabled = true;
    review.textContent = '';
    let lines;
    try {
      lines = content.split(/\r?\n/)[0].includes('\t')
        ? content.split(/\r?\n/).map(line => line.split('\t')).filter(line => line.some(value => value.trim()))
        : api.legacy.parseCsv(content);
    } catch {
      return api.setError(claudeHistoryContentId, '请检查 CSV 引号和列格式');
    }
    const fields = form.dataset.historyKind === 'subscription' ? claudeHistoryFields :
      claudeHistoryFields.filter(([, key]) => !['plan', 'start', 'expiry'].includes(key));
    const labels = lines.shift();
    if (labels?.length !== fields.length ||
        fields.some(([label], index) => labels[index].trim() !== label) ||
        !lines.length || lines.length > 100 || lines.some(line => line.length > fields.length))
      return api.setError(claudeHistoryContentId, '请保留完整表头并填写 1 至 100 条账号资料');

    const rows = lines.map(line => Object.fromEntries(fields.map(([, field], index) => [field, line[index] || ''])));
    if (rows.some(row => form.dataset.historyKind === 'subscription'
      ? row.state.trim() !== '已开通' : !['养号中', '死号'].includes(row.state.trim())))
      return api.setError(claudeHistoryContentId, form.dataset.historyKind === 'subscription'
        ? '订阅历史只登记已开通账号' : '账号历史只登记养号中或死号');
    api.setError(claudeHistoryContentId, '');
    form.dataset.checking = 'true';
    review.textContent = '正在预检历史资料…';
    try {
      const result = await localData.claudeHistoryIntake({ mode: 'preview', rows });
      if (!claudeHistoryFormCurrent(form, content)) return;
      preparedClaudeHistory = { form, content, inputRows: rows, ...result };
      review.innerHTML = table([
        { id: 'line', label: '序号' }, { id: 'email', label: '邮箱' }, { id: 'state', label: '登记状态' },
        { id: 'registered', label: '注册时间' },
        ...(form.dataset.historyKind === 'subscription' ? [
          { id: 'plan', label: '套餐' }, { id: 'start', label: '开通时间' }, { id: 'expiry', label: '到期时间' }
        ] : []), { id: 'result', label: '核对结果' }, { id: 'error', label: '待修正' }
      ], result.rows, '', 'claude-history-preview');
      const invalid = result.rows.some(row => row.error);
      submit.disabled = invalid || !result.pending;
      api.notify(invalid ? '请修正问题后重新预检' :
        result.pending ? '预检通过，待入库 ' + result.pending + ' 条' : '这些账号已登记');
    } catch (error) {
      if (claudeHistoryFormCurrent(form, content)) {
        review.textContent = '';
        api.setError(claudeHistoryContentId, error.message);
      }
    } finally {
      delete form.dataset.checking;
    }
  }
  function submitClaudeHistory(form) {
    const prepared = preparedClaudeHistory;
    if (!prepared || prepared.form !== form || !claudeHistoryFormCurrent(form, prepared.content) ||
        !prepared.pending || prepared.rows.some(row => row.error))
      return api.setError(claudeHistoryContentId, '请先按当前内容完成预检');
    const actor = currentActor();
    api.confirmAction('确认 Claude 历史入库', '将按预检结果保存 ' + prepared.pending + ' 条 Claude 账号历史。',
      async () => {
        if (inventorySavePending || preparedClaudeHistory !== prepared ||
            !claudeHistoryFormCurrent(form, prepared.content)) return;
        inventorySavePending = true;
        const submit = claudeHistorySubmitButton();
        submit.disabled = true;
        const input = form.elements.namedItem(claudeHistoryContentId);
        input.readOnly = true;
        try {
          const result = await localData.claudeHistoryIntake({ mode: 'confirm',
            rows: prepared.inputRows, inventoryVersion: prepared.inventoryVersion });
          if (currentActor().id !== actor.id) return;
          applyCommittedInventory(result.inventory);
          if (claudeHistoryFormCurrent(form, prepared.content)) {
            finishDrawer(form.dataset.inventoryDraft);
            api.render();
          } else if (api.state.drafts.get(form.dataset.inventoryDraft)?.[claudeHistoryContentId] === prepared.content) {
            api.state.drafts.delete(form.dataset.inventoryDraft);
          }
          api.notify('Claude 历史入库 ' + result.imported + ' 条，已有 ' + result.reused + ' 条');
        } catch (error) {
          if (claudeHistoryFormCurrent(form, prepared.content)) {
            form.querySelector('#' + claudeHistoryKey + '-review').textContent = '';
            api.setError(claudeHistoryContentId, error.message + '，请重新预检');
          } else api.notify(error.message);
        } finally {
          inventorySavePending = false;
          input.readOnly = false;
          if (preparedClaudeHistory === prepared) preparedClaudeHistory = null;
        }
      });
  }
  function importEditor(type = '') {
    const routeType = api.state.route.split('/')[1];
    if (accountSubmissionRoute() || (api.state.route.startsWith('accounts/') && (routeType === 'gpt' || personalAccount(routeType)))) {
      openAccountImport(accountSubmissionRoute() ? type || 'gpt' : routeType);
      return;
    }
    if (type === 'relay' || api.state.route === 'mailboxes/relay') {
      if (api.modules.appleRelay) api.modules.appleRelay.openAliasImport();
      else api.notify('隐藏邮箱管理尚未就绪，请刷新页面后重试');
      return;
    }
    accountImportContext = null;
    const microsoft = type === 'microsoft' || api.state.route === microsoftMailboxRoute;
    if (microsoft && !microsoftEntryAllowed()) return;
    const fundingApple = fundingAppleRoute();
    const account = !fundingApple && api.state.route.startsWith('accounts/');
    const choices = microsoft
      ? [['microsoft', '微软邮箱']]
      : fundingApple
      ? [['apple', '苹果 ID']]
      : account
        ? [
            ['gpt', 'GPT 账号'],
            ['claude', 'Claude 账号']
          ]
        : mailboxWorkflowTypes().filter(([id]) => id !== 'relay');
    const key = microsoft ? 'inventory-import:microsoft' : fundingApple ? 'inventory-import:apple-balance' : 'inventory-import';
    const d = draft(key, {
      'inventory-import-type':
        type ||
        (choices.some(([id]) => id === api.state.route.split('/')[1])
          ? api.state.route.split('/')[1]
          : choices[0]?.[0])
    });
    const example = microsoft ? accountCsvTemplate('microsoft') :
      '邮箱,密码,电话,国家,城市,注册时间,资料类型,登录设备,注册代理链接\ndemo@example.test,Demo-Only!,演示电话,马来西亚,吉隆坡,,谷歌邮箱,设备名称,';
    const typeField = microsoft
      ? '<input type="hidden" name="inventory-import-type" value="microsoft" />' + field('资料类型', 'inventory-import-type-display', input('inventory-import-type-display', '微软邮箱', 'readonly'))
      : field('默认资料类型', 'inventory-import-type', select('inventory-import-type', choices, d['inventory-import-type']), true);
    const sourceOptions = microsoft ? settingsFor('microsoft').sources : ['自己注册', '线上购买', '客户提供'];
    const noPhoneField = microsoft ? '' : wide('无绑定电话', 'inventory-import-no-phone', `<label class="checkbox-label"><input id="inventory-import-no-phone" name="inventory-import-no-phone" type="checkbox" ${d['inventory-import-no-phone'] ? 'checked' : ''} />确认空电话资料均未绑定电话号码</label>`);
    showDrawer(
      '批量导入预检',
      microsoft ? '仅导入微软邮箱。可录入邮箱和登录密码两列，也可按示例表头补齐验证资料。多种验证方式用分号分隔。'
        : '逐行确认最终类型和注册时间后再导入；地址识别仅作建议，不会自动更改类型。',
      `<form id="inventory-import-form" data-inventory-draft="${key}" novalidate><div class="form-grid">${typeField}${field('来源渠道', 'inventory-import-source', select('inventory-import-source', sourceOptions, d['inventory-import-source'] || sourceOptions[0]), true)}${field('CSV 文件', 'inventory-import-file', '<input id="inventory-import-file" type="file" accept=".csv,text/csv" />')}${wide('导入内容', 'inventory-import-content', area('inventory-import-content', d['inventory-import-content'] || '', example, 6), true)}${noPhoneField}</div></form><div id="inventory-import-results"></div>`,
      (microsoft ? button('复制示例 CSV', 'inventory-copy-microsoft-template', '', 'copy') : '') + button('取消', 'inventory-close') +
        '<button class="button primary" form="inventory-import-form" type="submit">检查并预览</button>',
      key
    );
    const form = document.getElementById('inventory-import-form');
    if (form && d['inventory-import-preview-source']) submitImport(form, false, d);
  }
  const accountCsvFields = [
    ['email', '账号邮箱', ['邮箱', '邮箱账号', '苹果ID', 'ID账号', 'email']],
    ['password', '账号密码', ['密码', '邮箱密码', '登录密码', 'password']],
    ['emailType', '邮箱类型', ['emailType'], ['gpt', 'claude']],
    ['phone', '绑定电话', ['电话', '手机号', '绑定手机号', 'phone'], ['apple', 'microsoft']],
    ['country', '国家地区', ['国家', '注册国家', 'country']],
    ['city', '注册城市', ['城市', '地区', '地区／城市', '地区/城市', '注册地区', '注册地区／城市', 'city', 'region'], ['claude']],
    ['status', '账号状态', ['状态', 'status']],
    ['source', '来源渠道', ['来源', 'source']],
    ['registered', '注册时间', ['registered', 'registeredAt']],
    ['totp', '2FA密钥', ['2FA', 'totp'], ['gpt', 'microsoft', 'gemini', 'grok']],
    ['loginMethod', '账号登录方式', ['loginMethod'], ['grok']],
    ['xHandle', 'X账号', ['X @账号', 'xHandle'], ['grok']],
    ['xLinkState', 'X绑定状态', ['xLinkState'], ['grok']],
    ['platformAccountId', '平台账号编号', ['platformAccountId'], ['gemini', 'grok']],
    ['auxiliary', '辅助邮箱', ['恢复邮箱', 'auxiliary'], ['microsoft']],
    ['loginMode', '登录方式', ['loginMode'], ['microsoft']],
    ['recoveryAccess', '辅助邮箱取码方式', ['取码方式', 'recoveryAccess'], ['microsoft']],
    ['twoStep', '两步验证', ['twoStep'], ['microsoft']],
    ['verificationMethods', '验证方式', ['verificationMethods'], ['microsoft']],
    ['verificationDevice', '验证设备／审批人', ['验证设备', '审批人', 'verificationDevice'], ['microsoft']],
    ['proxyUrl', '注册代理链接', ['注册IP链接', '注册代理', 'proxyUrl'], ['claude']],
    ['proxyProtocol', '代理协议', ['代理类型', 'proxyProtocol'], ['claude']],
    ['proxyHost', '代理主机', ['proxyHost'], ['claude']],
    ['proxyPort', '代理端口', ['proxyPort'], ['claude']],
    ['proxyUser', '代理账号', ['proxyUser'], ['claude']],
    ['proxyPassword', '代理密码', ['proxyPassword'], ['claude']],
    ['appPassword', '应用专用密码', ['appPassword'], ['apple', 'microsoft']],
    ['security1', '密保1', ['security1'], ['apple']],
    ['security2', '密保2', ['security2'], ['apple']],
    ['security3', '密保3', ['security3'], ['apple']],
    ['birthday', '密保生日', ['生日', 'birthday'], ['apple']],
    ['device', '登录设备', ['设备', 'device']],
    ['notes', '备注1', ['备注', 'notes']],
    ['notes2', '备注2', ['notes2']],
    ['acquisitionMethod', '账号来源', ['acquisitionMethod'], ['gpt', 'claude', 'gemini', 'grok']],
    ['type', '资料类型', ['账号类型', '产品类型', 'type']]
  ];
  function csvFieldName(value) {
    return String(value || '')
      .replace(/^\uFEFF/, '')
      .replace(/\s/g, '')
      .toLowerCase();
  }
  function csvField(value) {
    const normalized = csvFieldName(value);
    return accountCsvFields.find(([, label, aliases]) =>
      [label, ...aliases].some((name) => csvFieldName(name) === normalized)
    );
  }
  function accountCsvTemplate(type) {
    const country = usesAccountLocation(type)
      ? settingsFor(type).countries.find(value => !usesRegistrationCity(type) || cityOptions(type, value).length) || ''
      : settingsFor(type).countries[0] || '';
    const values = {
      email: `submit.${type}@example.test`,
      password: 'Demo-Account-Only!',
      emailType: '谷歌邮箱',
      loginMethod: '邮箱登录',
      xLinkState: '未核验',
      phone: '演示电话',
      country,
      city: usesRegistrationCity(type) ? cityOptions(type, country)[0] || '' : '',
      status: '正常',
      source: '自己注册',
      acquisitionMethod: '自己邮箱注册',
      registered: '2026-10-29T09:20',
      totp: 'DEMO-TOTP-ONLY',
      proxyUrl: 'socks5://demo:demo@proxy.example.test:1080',
      proxyProtocol: 'socks5',
      proxyHost: 'proxy.example.test',
      proxyPort: '1080',
      proxyUser: 'demo',
      proxyPassword: 'demo',
      appPassword: 'Demo-App-Only',
      security1: '演示答案一',
      security2: '演示答案二',
      security3: '演示答案三',
      birthday: '1990-01-02',
      device: '演示设备',
      notes: '演示备注一',
      notes2: '演示备注二'
    };
    if (type === 'microsoft') Object.assign(values, {
      phone: '', auxiliary: 'recovery@example.test', loginMode: '密码登录', recoveryAccess: '人工取码',
      twoStep: '已开启', verificationMethods: '邮箱验证码;动态验证码', verificationDevice: '',
      appPassword: ''
    });
    const fields = accountCsvFields.filter(
      ([key, , , types]) => key !== 'type' && (!types || types.includes(type))
    );
    return [
      fields.map(([key, label]) => type === 'microsoft' && key === 'password' ? '登录密码' : label).join(','),
      fields
        .map(([key]) => {
          const value = values[key] || '';
          return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
        })
        .join(',')
    ].join('\n');
  }
  function openAccountImport(type) {
    if (!accountEntryType(type)) {
      api.notify('请从对应产品账号入口导入');
      return;
    }
    const key = accountImportKey(type),
      d = draft(key, { 'inventory-import-type': type });
    accountImportContext = { key, type, route: api.state.route };
    const example = accountCsvTemplate(type);
    const fields =
      `<input type="hidden" name="inventory-import-scope" value="account-submit" /><input type="hidden" name="inventory-import-locked-type" value="${type}" />` +
      field(
        '账号类型',
        'inventory-import-type',
        select('inventory-import-type', [[type, typeLabel(type)]], type),
        true
      ) +
      (type !== 'apple' ? field('默认账号来源', 'inventory-import-acquisition',
        select('inventory-import-acquisition', acquisitionChoices, d['inventory-import-acquisition'] || 'self_registered')) : '') +
      field(
        '默认来源',
        'inventory-import-source',
        select(
          'inventory-import-source',
          settingsFor(type).sources,
          d['inventory-import-source'] || '自己注册'
        ),
        true
      ) +
      (type === 'apple' || personalAccount(type)
        ? ''
        : field(
            '默认邮箱类型',
            'inventory-import-email-type',
            select(
              'inventory-import-email-type',
              enabledTypes(),
              d['inventory-import-email-type'] || 'google'
            ),
            true
          )) +
      field(
        'CSV 文件',
        'inventory-import-file',
        '<input id="inventory-import-file" type="file" accept=".csv,text/csv" />'
      ) +
      wide(
        '导入内容',
        'inventory-import-content',
        area('inventory-import-content', d['inventory-import-content'] || '', example, 7),
        true,
        `${usesRegistrationCity(type) ? '注册国家和城市必填，使用本账号设置中的选项。' : type === 'gpt' ? '注册国家必填。' : ''}支持带表头 CSV 和旧版七列。注册时间可留空，按录入时间保存。余额、使用状态、KYC 和养号结果不接受导入。`
      ) +
      (type === 'apple'
        ? wide(
            '无绑定电话',
            'inventory-import-no-phone',
            `<label class="checkbox-label"><input id="inventory-import-no-phone" name="inventory-import-no-phone" type="checkbox" ${d['inventory-import-no-phone'] ? 'checked' : ''} />确认空电话资料均未绑定电话号码</label>`
          )
        : '');
    showDrawer(
      `批量导入${typeLabel(type)}`,
      '每批只提交一种账号资料，逐行检查后整批确认；不注册账号，不改变任何余额或业务使用状态。',
      `<form id="inventory-import-form" data-inventory-draft="${key}" novalidate><div class="form-grid">${fields}</div><div class="toolbar">${usesAccountLocation(type) ? locationSettingsButton(type, 'import') : ''}${localData ? '' : button('填入示例 CSV', 'inventory-import-example', '', 'copy')}</div></form><div id="inventory-import-results"></div>`,
      button('取消', 'inventory-close') +
        '<button class="button primary" form="inventory-import-form" type="submit">检查并预览</button>',
      key
    );
    const form = document.getElementById('inventory-import-form');
    if (form && d['inventory-import-preview-source']) submitImport(form, false, d);
  }
  function validCalendarDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return false;
    const [, year, month, day] = match.map(Number),
      date = new Date(Date.UTC(year, month - 1, day));
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    );
  }
  function validRegisteredDate(value) {
    const match = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2}))?$/.exec(value);
    return Boolean(
      match &&
      validCalendarDate(match[1]) &&
      (!match[2] || (Number(match[2]) < 24 && Number(match[3]) < 60)) &&
      age({ registered: value }) !== null
    );
  }
  function accountImportFingerprint(d, context, results) {
    return JSON.stringify([
      d['inventory-import-scope'],
      d['inventory-import-locked-type'],
      d['inventory-import-type'],
      d['inventory-import-content'] || '',
      d['inventory-import-source'] || '',
      d['inventory-import-email-type'] || '',
      Boolean(d['inventory-import-no-phone']),
      results.map((row) => [row.line, d[`inventory-import-row-type-${row.line}`] ?? context.type]),
      Object.entries(d)
        .filter(
          ([name]) =>
            name.startsWith('inventory-import-row-type-') &&
            !results.some((row) => name === `inventory-import-row-type-${row.line}`)
        )
        .sort(([a], [b]) => a.localeCompare(b))
    ]);
  }
  function validAccountImportContext(form, d, context) {
    return Boolean(
      context &&
      api.state.route === context.route &&
      (accountSubmissionRoute() || ((context.type === 'gpt' || personalAccount(context.type)) &&
        api.state.route === 'accounts/' + context.type)) &&
      form.dataset.inventoryDraft === context.key &&
      d['inventory-import-scope'] === 'account-submit' &&
      d['inventory-import-locked-type'] === context.type &&
      d['inventory-import-type'] === context.type &&
      accountEntryType(context.type)
    );
  }
  function csvChoice(value, choices, fallback, label) {
    if (!value) return fallback;
    const selected = choices.find((pair) => pair.some((name) => csvFieldName(name) === csvFieldName(value)));
    if (!selected) throw new Error(`请填写有效的${label}`);
    return selected[0];
  }
  function parseAccountImport(rows, d, context) {
    const microsoft = context.type === 'microsoft';
    const personal = personalAccount(context.type);
    const legacyKeys = ['email', 'password', 'phone', 'country', 'city', 'registered', 'type',
      ...(microsoft ? ['device', 'proxyUrl'] : [])];
    const firstKeys = rows[0].map((value) => csvField(value)?.[0] || '');
    const legacyHeader =
      !microsoft && firstKeys.length === 7 && firstKeys.every((key, index) => key === legacyKeys[index]);
    const hasHeader =
      legacyHeader ||
      (!String(rows[0][0]).includes('@') && rows[0].some((value) => csvField(value)));
    const keys = hasHeader ? firstKeys : legacyKeys;
    const extended = hasHeader && !legacyHeader;
    const dataRows = hasHeader ? rows.slice(1) : rows;
    const headerErrors = [];
    if (extended) {
      const seenKeys = new Set();
      for (let index = 0; index < keys.length; index++) {
        const definition = csvField(rows[0][index]);
        if (!definition) headerErrors.push(`不支持的表头：${rows[0][index] || '空表头'}`);
        else if (definition[3] && !definition[3].includes(context.type) && !(context.type === 'gpt' && definition[0] === 'city'))
          headerErrors.push(`本类资料不支持字段：${definition[1]}`);
        else if (seenKeys.has(definition[0])) headerErrors.push(`重复表头：${definition[1]}`);
        seenKeys.add(keys[index]);
      }
      if (!keys.includes('email') && !(context.type === 'grok' && keys.includes('xHandle')))
        headerErrors.push('缺少账号邮箱表头');
    }
    const knownTypes = new Map(
      (microsoft ? [['microsoft', '微软邮箱']] : accountSubmissionTypes).flatMap(([id, label]) => [
        [csvFieldName(id), id],
        [csvFieldName(label), id],
        [csvFieldName(typeLabel(id)), id]
      ])
    );
    const existing = new Set(
      allAssets().map((asset) => `${asset.type}:${identityKey(asset)}`)
    );
    return dataRows.map((columns, index) => {
      const line = index + (hasHeader ? 2 : 1),
        values = {};
      keys.forEach((key, column) => {
        if (!key || (key === 'city' && context.type === 'gpt')) return;
        const value = String(columns[column] ?? '');
        values[key] = (microsoft || personal) && ['password', 'appPassword'].includes(key) ? value : value.trim();
      });
      if (microsoft) values.email = (values.email || '').toLowerCase();
      let personalIssue = '';
      if (personal) {
        try {
          values.loginMethod = context.type === 'gemini' ? 'google' :
            csvChoice(values.loginMethod, grokLoginOptions, values.xHandle && !values.email ? 'x' : 'email', '账号登录方式');
          values.xLinkState = csvChoice(values.xLinkState, xLinkOptions, 'unknown', 'X 绑定状态');
          personalIssue = personalAccountError({ ...values, type: context.type });
        } catch (issue) { personalIssue = issue.message; }
      }
      const email = values.email || '',
        selectedType = d[`inventory-import-row-type-${line}`] ?? context.type,
        csvType = values.type ? knownTypes.get(csvFieldName(values.type)) : context.type,
        key = `${context.type}:${personal ? identityKey(values) : email.toLowerCase()}`;
      let error = headerErrors[0] || '';
      if (!error && columns.length > keys.length)
        error = '存在多余列；扩展字段请使用完整表头，不会静默丢弃';
      if (!error && dataRows.length > 500) error = '单次最多导入 500 条资料';
      if (!error && (selectedType !== context.type || csvType !== context.type))
        error = microsoft ? '本页仅导入微软邮箱，请修改 CSV 后重新预检'
          : '本批类型与账号卡片不一致，请修改 CSV 后重新预检';
      if (!error && personal) error = personalIssue;
      if (!error && !personal && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) error = '邮箱格式错误';
      if (!error && existing.has(key)) error = '相同类型邮箱重复，不覆盖原资料';
      existing.add(key);
      if (!error && context.type === 'apple' && !values.password) error = '缺少密码';
      if (!error && context.type === 'apple' && !values.phone && !d['inventory-import-no-phone'])
        error = '需确认未绑定电话';
      if (!error && context.type === 'apple' && !values.country) error = '缺少国家';
      if (context.type !== 'apple' && !microsoft) {
        try {
          values.acquisitionMethod = csvChoice(values.acquisitionMethod, acquisitionChoices,
            d['inventory-import-acquisition'] || 'self_registered', '账号来源');
        } catch (issue) { error ||= issue.message; }
      }
      const purchased = values.acquisitionMethod === 'purchased';
      if (!error && context.type === 'claude' && !purchased && !values.device) error = '缺少登录设备';
      if (!error && context.type === 'claude' && !purchased && !values.proxyUrl) error = '缺少注册代理链接';
      if (!error && values.phone && /^[a-z][a-z0-9+.-]*:/i.test(values.phone) && !phoneCodeUrl(values.phone)) error = '验证码链接仅支持有效的 HTTP(S) 地址';
      if (!error && usesAccountLocation(context.type) && (!purchased || values.country || values.city))
        error = accountLocationError(context.type, values.country, values.city,
          purchased && !values.city ? { country: values.country, city: '' } : null);
      if (!error && values.registered && !validRegisteredDate(values.registered))
        error = '注册时间无效或晚于当前时间，请按北京时间填写';
      if (!error && values.birthday && !validCalendarDate(values.birthday))
        error = '密保生日不是有效日期';
      values.status ||= '正常';
      if (!error && !['正常', '冻结', '封控中'].includes(values.status))
        error = '账号状态只能填写正常、冻结或封控中';
      values.source ||= d['inventory-import-source'] || '自己注册';
      if (microsoft && !error) {
        try {
          const { loginMode, recoveryAccess, twoStep, verificationMethods, verificationDevice, ...fields } = values;
          if (fields.city || fields.proxyUrl) throw new Error('微软邮箱不录入注册城市或代理链接');
          values.microsoftSecurity = readMicrosoftSecurity(fields, {
            loginMode: csvChoice(loginMode, microsoftLoginModes, 'password', '登录方式'),
            recoveryAccess: csvChoice(recoveryAccess, microsoftRecoveryOptions, 'unknown', '辅助邮箱取码方式'),
            twoStep: csvChoice(twoStep, microsoftTwoStepOptions, 'unknown', '两步验证状态'),
            verificationMethods: (verificationMethods || '').split(/[;；、]/).filter((value) => value.trim())
              .map((value) => csvChoice(value, microsoftVerificationOptions, '', '验证方式')),
            verificationDevice
          });
          values.auxiliary = (values.auxiliary || '').toLowerCase();
          for (const key of ['loginMode', 'recoveryAccess', 'twoStep', 'verificationMethods', 'verificationDevice', 'proxyUrl'])
            delete values[key];
        } catch (issue) {
          error = issue.message;
        }
      }
      if (context.type !== 'apple' && !microsoft && !personal) {
        const emailType = values.emailType || d['inventory-import-email-type'];
        values.emailType =
          enabledTypes().find(([id, label]) =>
            [id, label].some((value) => csvFieldName(value) === csvFieldName(emailType))
          )?.[0] || '';
        if (!error && !values.emailType) error = '请确认有效邮箱类型，不按邮箱地址自动推算';
      }
      if (context.type === 'claude') {
        try {
          if (values.proxyProtocol) values.proxyProtocol = values.proxyProtocol.toLowerCase();
          if (values.proxyUrl) {
            const parsedFields = parseRegistrationProxy(values.proxyUrl, values.proxyProtocol);
            for (const [name, value] of Object.entries(parsedFields)) {
              if (name !== 'proxyUrl' && values[name] && values[name] !== value)
                throw new Error('代理链接与拆分字段不一致');
              values[name] = value;
            }
          }
          if (
            ['proxyProtocol', 'proxyHost', 'proxyPort', 'proxyUser', 'proxyPassword'].some(
              (name) => values[name]
            )
          ) {
            if (
              !['socks5', 'http', 'https'].includes(values.proxyProtocol) ||
              !values.proxyHost ||
              !/^\d+$/.test(values.proxyPort || '') ||
              Number(values.proxyPort) < 1 ||
              Number(values.proxyPort) > 65535
            )
              throw new Error('代理拆分字段不完整或端口无效');
          }
        } catch (issue) {
          error ||= issue.message || '代理格式无效';
        }
      }
      delete values.type;
      return {
        ...values,
        id: String(line),
        line,
        type: context.type,
        email,
        password: values.password || '',
        phone: values.phone || '',
        country: values.country || '',
        city: values.city || '',
        registered: values.registered || '',
        fields: values,
        error
      };
    });
  }
  function registrationList() {
    return registrationRecords.length
      ? table(
          [
            { id: 'id', label: '注册记录' },
            { id: 'email', label: '邮箱' },
            { id: 'product', label: '产品' },
            {
              id: 'state',
              label: '结果',
              render: (row) =>
                tag(
                  row.state,
                  row.state === '成功' ? 'success' : row.state === '待核对' ? 'warning' : ''
                )
            },
            { id: 'accountId', label: '新账号编号' },
            {
              id: 'createdBy',
              label: '首次登记人',
              render: (row) => esc(row.createdBy || '历史未记录')
            },
            {
              id: 'createdAt',
              label: '首次登记时间',
              render: (row) => esc(row.createdAt || '历史未记录')
            },
            {
              id: 'actor',
              label: '最近结果登记人',
              render: (row) => esc(row.actor || '历史未记录')
            },
            { id: 'time', label: '最近结果登记时间' }
          ],
          window.IDListOrder.sortByRecordTime(registrationRecords, row => [row.createdAt, row.time]),
          '',
          '注册记录'
        )
      : empty('暂无注册记录', '从未使用邮箱的“更多操作”中登记或模拟注册结果。');
  }
  function openRegistration(assetId) {
    const asset = assetById(assetId);
    if (
      !asset ||
      isAccount(asset) ||
      asset.inventoryState === 'used' ||
      asset.health !== 'normal'
    ) {
      api.notify('请选择正常且尚未实际使用的邮箱');
      return;
    }
    const claim = pendingClaim(asset);
    if (localData && asset.type === 'relay' && (!claim || !ownerAllowed(claim.batch))) {
      api.notify('请先在邮箱提取领取隐藏邮箱，再登记本次注册结果');
      return;
    }
    const pendingRecord = registrationRecords.find(
      (record) => record.id === claim?.item.registrationId
    );
    if (claim?.item.taskId) {
      api.notify('当前邮箱已有未结束任务');
      return;
    }
    const key = `inventory-registration:${asset.id}:${pendingRecord?.id || 'new'}`;
    const saved = draft(key);
    const products = relayRegistrationPlatforms;
    const current = registrationProduct(pendingRecord?.product);
    showDrawer(
      '登记注册结果',
      '这里只登记外部注册结果，不启动注册器。成功后邮箱退出通用库存；账号资料请在账号管理独立录入。',
      `<form id="inventory-registration-form" data-inventory-draft="${esc(key)}" novalidate><input type="hidden" name="inventory-registration-asset" value="${asset.id}" /><input type="hidden" name="inventory-registration-id" value="${pendingRecord?.id || ''}" /><div class="form-grid">${wide('邮箱账号', 'inventory-registration-email', input('inventory-registration-email', asset.email, 'readonly'))}${field(
        '产品',
        'inventory-registration-product',
        select(
          'inventory-registration-product',
          [['', '请选择实际注册平台'], ...choicesWithCurrent(products, current)],
          saved['inventory-registration-product'] ?? (current || (asset.type === 'relay' ? '' : 'gpt'))
        ),
        true
      )}${field('注册结果', 'inventory-registration-result', select('inventory-registration-result', ['成功', '失败且未使用', '待核对'], saved['inventory-registration-result'] ?? pendingRecord?.state ?? '成功'), true)}</div></form>`,
      button('取消', 'inventory-close') +
        '<button class="button primary" form="inventory-registration-form" type="submit">核对登记结果</button>',
      key
    );
  }
  function saveAsset(form) {
    const data = api.readForm(form),
      id = data['inventory-asset-id'],
      type = data['inventory-asset-type'];
    if (type === 'relay') {
      api.notify('隐藏邮箱须从所属 Apple 主邮箱登记，请使用隐藏邮箱专用入口');
      return;
    }
    const entryContext = accountAssetContext;
    const accountEntry =
      accountSubmissionRoute() ||
      data['inventory-entry-scope'] === 'account-submit' ||
      String(form.dataset.inventoryDraft || '').startsWith('inventory-edit:account-submit:');
    const microsoft = type === 'microsoft';
    const route = api.state.route;
    const microsoftDraft = form.dataset.inventoryDraft === 'inventory-edit:new:microsoft';
    const personal = personalAccount(type);
    const inputSnapshot = accountEntry || microsoft || personal || type === 'apple' || (type === 'google' && !id)
      ? formFingerprint(data) : '';
    const productAccount = usesAccountLocation(type) || personal;
    const acquisition = data['inventory-acquisitionMethod'] || (productAccount && !id ? 'self_registered' : '');
    const purchased = acquisition === 'purchased';
    const previous = id ? assetById(id) : null;
    const sourceEntry = productAccount && !id && ['mailboxes/google', 'mailboxes/relay'].includes(api.state.route) &&
      Boolean(data['inventory-sourceMailboxId']) && form.dataset.inventoryDraft ===
        'inventory-edit:source:' + data['inventory-sourceMailboxId'] + ':' + type;
    if (personal && !accountEntry && !sourceEntry && api.state.route !== 'accounts/' + type) {
      api.notify('请从对应产品账号管理录入资料');
      return;
    }
    if (microsoft ? !microsoftEntryAllowed(route) || (id ? route !== microsoftMailboxRoute : !microsoftDraft)
      : route === microsoftMailboxRoute || microsoftDraft) {
      api.notify('请从对应的邮箱管理页面重新录入');
      return;
    }
    if (
      accountEntry &&
      (!entryContext ||
        !accountSubmissionRoute() ||
        form.dataset.inventoryDraft !== entryContext.key ||
        data['inventory-entry-scope'] !== 'account-submit' ||
        data['inventory-entry-type'] !== entryContext.type ||
        type !== entryContext.type ||
        id ||
        !accountEntryType(type))
    ) {
      api.notify('账号提交类型或入口已变化，请从对应账号卡片重新录入');
      return;
    }
    let first = '';
    const required = type === 'grok' ? [] : ['inventory-email'];
    if (['google', 'apple'].includes(type) && (!previous || previous.password)) required.push('inventory-password');
    if (['google', 'apple'].includes(type) && (!previous || previous.country)) required.push('inventory-country-edit');
    if (type === 'claude' && !purchased) {
      if (!previous || previous.device) required.push('inventory-device');
      if (!previous || previous.proxyUrl) required.push('inventory-proxy-url');
    }
    for (const name of required) {
      const error = !String(data[name] || '').trim() ? '请填写此项资料' : '';
      api.setError(name, error);
      if (error && !first) first = name;
    }
    const email = String(data['inventory-email'] || '');
    const identity = personal ? {
      type, email: email.trim(), loginMethod: type === 'gemini' ? 'google' : data['inventory-loginMethod'],
      xHandle: String(data['inventory-xHandle'] || '').trim(),
      platformAccountId: String(data['inventory-platformAccountId'] || '').trim(),
      xLinkState: data['inventory-xLinkState'] || 'unknown'
    } : { email };
    const personalError = personal && personalAccountError(identity);
    if (personal) api.setError('inventory-xHandle', '');
    if (personalError) {
      const name = type === 'grok' && identity.loginMethod === 'x' ? 'inventory-xHandle' : 'inventory-email';
      api.setError(name, personalError);
      first ||= name;
    } else if (!personal && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(microsoft ? email.trim() : email)) {
      api.setError('inventory-email', '邮箱格式不正确');
      first ||= 'inventory-email';
    }
    const registrationProblem = !id && data['inventory-sourceMailboxId'] &&
      registrationInputProblem(type, email, data['inventory-source']);
    if (registrationProblem) {
      api.setError('inventory-email', registrationProblem);
      first ||= 'inventory-email';
    }
    if (
      !registrationProblem && allAssets().some(
        (asset) =>
          asset.id !== id &&
          asset.type === type &&
          identityKey(asset) === identityKey(identity)
      )
    ) {
      api.setError('inventory-email', '相同类型中已经存在该账号');
      first ||= 'inventory-email';
    }
    if (
      ['google', 'apple'].includes(type) &&
      !data['inventory-phone']?.trim() &&
      !data['inventory-no-phone']
    ) {
      api.setError('inventory-phone', '填写电话，或明确确认未绑定电话');
      first ||= 'inventory-phone';
    }
    const phone = String(data['inventory-phone'] || '').trim();
    if (phone && phone !== previous?.phone && /^[a-z][a-z0-9+.-]*:/i.test(phone) && !phoneCodeUrl(phone)) {
      api.setError('inventory-phone', '验证码链接仅支持有效的 HTTP(S) 地址');
      first ||= 'inventory-phone';
    }
    if (first) {
      document.getElementById(first).focus();
      return;
    }
    if (
      accountEntry &&
      type !== 'apple' && !personal && (data['inventory-emailType'] || !purchased) &&
      !enabledTypes().some(([value]) => value === data['inventory-emailType'])
    ) {
      api.setError('inventory-emailType', '请选择有效邮箱类型');
      return;
    }
    if (
      accountEntry &&
      data['inventory-birthday'] &&
      !validCalendarDate(data['inventory-birthday'])
    ) {
      api.setError('inventory-birthday', '密保生日不是有效日期');
      return;
    }
    if ((accountEntry || microsoft || personal) && !['正常', '冻结', '封控中'].includes(data['inventory-status-edit'])) {
      api.setError('inventory-status-edit', '请选择有效账号状态');
      return;
    }
    const original = previous;
    if (
      ![
        ...stockTypes.map(([value]) => value),
        ...enabledTypes().map(([value]) => value),
        ...(microsoft ? ['microsoft'] : []),
        ...(fundingAppleRoute() ? ['apple'] : [])
      ].includes(type) ||
      (id && !original)
    ) {
      api.notify('资料类型或原资料无效，请重新选择');
      return;
    }
    let sourceMailbox;
    if (productAccount) {
      const sourceId = data['inventory-sourceMailboxId'];
      api.setError('inventory-sourceMailboxId', '');
      if (sourceId) {
        sourceMailbox = personalSourceMailboxes(type).find(row => row.id === sourceId);
        if (id || purchased || !sourceMailbox || data['inventory-source'] === '客户提供' ||
            sourceMailbox.email.toLowerCase() !== identity.email.trim().toLowerCase()) {
          api.setError('inventory-sourceMailboxId', '所选库存邮箱须与注册邮箱一致。网上购买请选择独立录入。');
          return;
        }
      }
    }
    if (original && (original.type !== type || original.email !== data['inventory-email'].trim())) {
      api.notify('资料类型和邮箱标识创建后不可修改');
      return;
    }
    if (usesAccountLocation(type)) {
      const country = data['inventory-country-edit'] || '';
      const city = data['inventory-city'] || '';
      const issue = purchased && !city
        ? country && !settingsFor(type).countries.includes(country) && country !== original?.country ? '请选择有效注册国家' : ''
        : accountLocationError(type, country, city, original);
      const locationField = usesRegistrationCity(type) && settingsFor(type).countries.includes(country)
        ? 'inventory-city'
        : 'inventory-country-edit';
      api.setError('inventory-country-edit', locationField === 'inventory-country-edit' ? issue : '');
      api.setError('inventory-city', locationField === 'inventory-city' ? issue : '');
      if (issue) {
        document.getElementById(locationField)?.focus();
        return;
      }
    }
    if (type === 'apple' && Object.hasOwn(data, 'inventory-appStoreRegion')) {
      const rules = window.IDAppleFunding;
      const regionError = (!id || data['inventory-appStoreRegion']) && !rules?.appleRegion(data['inventory-appStoreRegion']);
      const balanceError = !id && rules?.appleAmountUnits(data['inventory-appleOpeningBalance']) === null;
      api.setError('inventory-appStoreRegion', regionError ? '请选择已核实的 Id地区' : '');
      if (!id) api.setError('inventory-appleOpeningBalance', balanceError ? '请输入非负美元金额，最多四位小数' : '');
      if (regionError || balanceError) return;
    }
    if (data['inventory-registered'] && data['inventory-registered'] !== (original && registrationInput(original)) &&
        !validRegisteredDate(data['inventory-registered'])) {
      api.setError('inventory-registered', '注册时间无效或晚于当前时间，请按北京时间填写');
      return;
    }
    let microsoftSecurity;
    if (microsoft) {
      for (const field of ['inventory-password', 'inventory-auxiliary', 'inventory-totp', 'inventory-appPassword',
        'inventory-source', 'inventory-phone', 'inventory-microsoft-device', 'inventory-microsoft-methods'])
        api.setError(field, '');
      if (!String(data['inventory-source'] || '').trim()) {
        api.setError('inventory-source', '请选择来源渠道');
        return;
      }
      const savedSecurity = original?.microsoftSecurity;
      const security = {
        loginMode: data['inventory-microsoft-login'],
        recoveryAccess: data['inventory-microsoft-recovery'],
        twoStep: data['inventory-microsoft-two-step'],
        verificationMethods: microsoftVerificationOptions
          .map(([method]) => method).filter((method) => data[`inventory-microsoft-method-${method}`]),
        verificationDevice: String(data['inventory-microsoft-device'] || '').trim()
      };
      const changesSecurity = !original ||
        ['password', 'phone', 'auxiliary', 'totp', 'appPassword'].some(key =>
          String(data['inventory-' + key] || '').trim() !== String(original[key] || '').trim()) ||
        security.loginMode !== (savedSecurity?.loginMode || 'password') ||
        security.recoveryAccess !== (savedSecurity?.recoveryAccess || 'unknown') ||
        security.twoStep !== (savedSecurity?.twoStep || 'unknown') ||
        security.verificationDevice !== (savedSecurity?.verificationDevice || '') ||
        security.verificationMethods.length !== (savedSecurity?.verificationMethods?.length || 0) ||
        security.verificationMethods.some(method => !savedSecurity?.verificationMethods?.includes(method));
      try {
        microsoftSecurity = changesSecurity ? readMicrosoftSecurity({
          email, phone, password: data['inventory-password'], auxiliary: data['inventory-auxiliary'],
          totp: data['inventory-totp']?.trim(), appPassword: data['inventory-appPassword'], source: data['inventory-source']
        }, security) : savedSecurity;
      } catch (issue) {
        const field = issue.cause || 'inventory-microsoft-methods';
        api.setError(field, issue.message);
        document.getElementById(field)?.focus();
        return;
      }
    }
    let proxyFields;
    if (type === 'claude') {
      const link = data['inventory-proxy-url']?.trim() || '';
      const protocol = data['inventory-proxy-protocol'] || '';
      try {
        if (link && !protocol) throw new Error('请先选择代理协议');
        proxyFields = link
          ? parseRegistrationProxy(link, protocol)
          : {
              proxyUrl: '',
              proxyProtocol: protocol,
              proxyHost: data['inventory-proxy-host'] || '',
              proxyPort: data['inventory-proxy-port'] || '',
              proxyUser: data['inventory-proxy-user'] || '',
              proxyPassword: data['inventory-proxy-pass'] || ''
            };
        api.setError('inventory-proxy-url', '');
      } catch (error) {
        api.setError('inventory-proxy-url', error.message);
        return;
      }
    }
    if (original && String(original.version) !== data['inventory-version']) {
      api.notify('资料版本已变化，请重新核对');
      return;
    }
    confirmInventoryChange(
      original ? '确认修改资料' : '确认新增资料',
      `${displayIdentity(identity)} · ${typeLabel(type)}，${sourceMailbox ? '保存账号并登记所选邮箱实际使用' : localData ? '保存到服务器数据库' : '当前为离线演示，内容仅保留在本页内存'}。`,
      () => {
        if (type === 'google' && !original && (api.state.route !== route || !form.isConnected ||
            formFingerprint(api.readForm(form)) !== inputSnapshot)) {
          api.notify('确认期间谷歌邮箱输入已变化，请重新核对');
          return;
        }
        if (microsoft && (api.state.route !== route || !microsoftEntryAllowed(route) || !form.isConnected ||
            formFingerprint(api.readForm(form)) !== inputSnapshot ||
            (original && assetById(id) !== original))) {
          api.notify('确认期间微软邮箱资料已变化，请重新核对');
          return;
        }
        if (personal && (form.isConnected === false || formFingerprint(api.readForm(form)) !== inputSnapshot ||
            (original && assetById(id) !== original) ||
            (sourceMailbox && !personalSourceMailboxes(type).includes(sourceMailbox)))) {
          api.notify('确认期间账号或来源邮箱已变化，请重新核对');
          return;
        }
        if (
          accountEntry &&
          (accountAssetContext !== entryContext ||
            !accountSubmissionRoute() ||
            formFingerprint(api.readForm(form)) !== inputSnapshot)
        ) {
          api.notify('确认期间账号输入或入口已变化，本次未保存，请重新核对');
          return;
        }
        if (type === 'apple' && (form.isConnected === false || formFingerprint(api.readForm(form)) !== inputSnapshot)) {
          api.notify('确认期间苹果 ID 或余额输入已变化，请重新核对');
          return;
        }
        if (original && String(original.version) !== data['inventory-version']) {
          api.notify('确认期间资料已有后续变化，本次未保存，请重新核对');
          return;
        }
        if (
          !original &&
          allAssets().some(
            (asset) =>
              asset.type === type &&
              identityKey(asset) === identityKey(identity)
          )
        ) {
          api.notify('确认期间已出现相同类型资料，本次未新增');
          return;
        }
        const update = {
          ...(!original ? { type, email: microsoft ? email.trim().toLowerCase() : email.trim() } : {}),
          country: data['inventory-country-edit'],
          status: data['inventory-status-edit']
        };
        if (type === 'apple' && Object.hasOwn(data, 'inventory-appStoreRegion')) {
          update.appStoreRegion = data['inventory-appStoreRegion'];
          if (!original && localData) update.appleOpeningBalance = data['inventory-appleOpeningBalance'];
        }
        for (const key of [
          'password',
          'phone',
          'emailType',
          'city',
          'source',
          'registered',
          'device',
          'totp',
          'auxiliary',
          'appPassword',
          'security1',
          'security2',
          'security3',
          'birthday',
          'notes',
          'notes2',
          'parentMailboxId',
          'queryCode',
          'queryExpiry'
        ])
          if ((key !== 'city' || usesRegistrationCity(type)) && data[`inventory-${key}`] !== undefined)
            update[key] = data[`inventory-${key}`];
        if (productAccount && acquisition) update.acquisitionMethod = acquisition;
        if (sourceMailbox) Object.assign(update, { sourceMailboxId: sourceMailbox.id,
          sourceClaimId: sourceMailbox.claimId || '', emailType: sourceMailbox.type });
        if (microsoft) {
          update.mailboxUsage = data['inventory-mailboxUsage'] || '';
          update.auxiliary = (update.auxiliary || '').trim().toLowerCase();
          update.totp = (update.totp || '').trim();
          if (microsoftSecurity) update.microsoftSecurity = microsoftSecurity;
        }
        if (personal) {
          const { type: _, email: accountEmail, ...personalFields } = identity;
          Object.assign(update, personalFields);
          if (!original) update.email = accountEmail;

        }
        if (proxyFields) Object.assign(update, proxyFields);
        if (original) {
          if (original.registered && update.registered === registrationInput(original))
            update.registered = original.registered;
          else if (!update.registered && original.registered)
            update.registered = original.createdAt || original.importedAt || original.registered;
          if (
            localData &&
            (personal || ['google', 'gpt', 'claude', 'microsoft'].includes(type)) &&
            Object.entries(update).every(([key, value]) => key === 'microsoftSecurity'
              ? JSON.stringify(original[key]) === JSON.stringify(value)
              : (original[key] ?? '') === (value ?? ''))
          ) {
            api.notify('资料没有变化，无需保存');
            return;
          }
          const snapshot = {};
          for (const key of Object.keys(update))
            snapshot[key] = localData && !microsoft ? (original[key] ?? null) : original[key];
          const canUndo = !microsoft || !!original.microsoftSecurity;
          Object.assign(original, update);
          log(original, '修改资料', '普通资料已更新');
          if (canUndo) undo.set(original.id, { version: original.version, snapshot });
        } else {
          const createdAt = inventoryNow();
          const asset = normalize({
            ...update,
            registered: update.registered || (localData ? '' : createdAt),
            id: uid(type),
            createdById: currentActor().id,
            createdBy: currentActor().name,
            createdAt,
            importedAt: createdAt,
            used: false,
            health: 'normal',
            version: 1,
            inventoryState: 'available'
          });
          collection(stockType(type) ? 'account' : 'mail').unshift(asset);
          log(asset, '新增资料');
          if (!localData && sourceMailbox) {
            const claim = pendingClaim(sourceMailbox), registrationId = uid('REGISTER');
            registrationRecords.unshift({ id: registrationId, assetId: sourceMailbox.id, accountId: asset.id,
              email: sourceMailbox.email, product: { gemini: 'Gemini', grok: 'Grok', gpt: 'GPT', claude: 'Claude' }[type], state: '成功',
              actorId: currentActor().id, actor: currentActor().name, time: createdAt });
            consume(sourceMailbox, claim, { kind: 'registration', registrationId, accountId: asset.id, label: '账号登记' });
          }
        }
        return () => {
          finishDrawer(form.dataset.inventoryDraft || `inventory-edit:${id || `new:${type}`}`);
          api.render();
          api.notify(localData ? '资料已保存到服务器' : '演示资料已保存');
        };
      },
      '确认保存'
    );
  }

  function localRelayCandidate(asset) {
    normalize(asset);
    return (
      asset.type === 'relay' &&
      !asset.relayDeleted &&
      asset.relayStatus === 'ACTIVE' &&
      asset.inventoryState === 'available' &&
      !usageReview.has(asset.id) &&
      asset.health === 'normal' &&
      asset.status === '正常' &&
      !asset.usageLinks.length &&
      !asset.claimId &&
      !asset.claimBatchId &&
      !reservations.has(asset.id)
    );
  }
  async function reviewRelayExtraction(form, values, quantity, purpose) {
    if (relayExtractionPending) return;
    relayExtractionPending = true;
    const version = localInventoryVersion;
    const fingerprint = formFingerprint(values);
    const current = () =>
      api.state.route === 'workspace/mail-extract' &&
      form.isConnected !== false &&
      version === localInventoryVersion &&
      formFingerprint(api.readForm(form)) === fingerprint;
    const submit = form.querySelector?.('button[type="submit"]');
    if (submit) {
      submit.disabled = true;
      submit.textContent = '正在核对隐藏邮箱';
    }
    try {
      const status = await localData.relay('status');
      if (!current()) return;
      if (!status.codeQueryConfigured) {
        api.setError('inventory-quantity', '请先接入独立 Vendure 收件与查询服务');
        return;
      }
      const bound = new Set(status.aliasIds || []);
      const ids = mailboxes
        .filter((asset) => bound.has(asset.id) && localRelayCandidate(asset))
        .map((asset) => asset.id);
      const chosen = [];
      for (let offset = 0; offset < ids.length && chosen.length < quantity; offset += 100) {
        const aliasIds = ids.slice(offset, offset + 100);
        const { items } = await localData.relay('extraction-eligibility', { aliasIds });
        if (!current()) return;
        const eligible = new Set(
          items.filter((item) => item.eligible === true).map((item) => item.id)
        );
        chosen.push(...aliasIds.filter((id) => eligible.has(id)));
      }
      if (chosen.length < quantity) {
        api.setError(
          'inventory-quantity',
          `核对后可提取 ${chosen.length} 条；未绑定、不可用或查询码失效的邮箱已排除`
        );
        return;
      }
      const selected = chosen.slice(0, quantity);
      confirmInventoryChange(
        '确认提取',
        `苹果隐藏邮箱 ${quantity} 条，用途为“${purpose}”。保存时会再次核对主邮箱绑定和查询码。`,
        () => {
          const fresh = selected.map(assetById);
          if (!current() || fresh.some((asset) => !asset || !localRelayCandidate(asset))) {
            api.notify('确认期间库存或提取条件已变化，请重新核对');
            return;
          }
          const batch = createBatch('mail', fresh, purpose, values['inventory-extract-notes']);
          return () => {
            api.state.drafts.delete('inventory-extract:mail');
            api.go(`workspace/extractions/${batch.id}`);
          };
        },
        '确认提取',
        { relayExtraction: true }
      );
    } catch (error) {
      if (current())
        api.setError('inventory-quantity', error?.message || '无法核对隐藏邮箱，请稍后重试');
    } finally {
      relayExtractionPending = false;
      if (submit) {
        submit.disabled = false;
        submit.textContent = '确认提取';
      }
    }
  }
  function submitExtraction(form) {
    const d = api.readForm(form),
      kind = d['inventory-kind'],
      type = d['inventory-extract-type'];
    const allowedType =
      kind === 'account'
        ? stockType(type)
        : kind === 'mail' && mailboxWorkflowTypes(true).some(([id]) => id === type);
    if (!allowedType) {
      api.setError(
        'inventory-extract-type',
        '请选择本模块可提取资料；资金苹果 ID 仅在苹果 ID 余额页管理'
      );
      return;
    }
    const quantity = Number(d['inventory-quantity']);
    const candidates = collection(kind).filter((asset) => asset.type === type && available(asset));
    let error =
      !Number.isInteger(quantity) || quantity < 1 || quantity > 100
        ? '请输入 1–100 的整数'
        : !(localData && type === 'relay') && quantity > candidates.length
          ? `库存不足，当前可提取 ${candidates.length} 条`
          : '';
    api.setError('inventory-quantity', error);
    if (kind === 'mail' && !mailExtractionPurposes(type).includes(d['inventory-purpose'])) {
      api.setError('inventory-purpose', '请选择当前有效的提取用途，原选项可能已被移除');
      return;
    }
    api.setError('inventory-purpose', '');
    const purpose =
      d['inventory-purpose'] === '其他'
        ? String(d['inventory-purpose-other'] || '').trim()
        : d['inventory-purpose'];
    api.setError('inventory-purpose-other', !purpose ? '请填写具体用途' : '');
    if (error || !purpose) return;
    if (localData && type === 'relay') {
      void reviewRelayExtraction(form, d, quantity, purpose);
      return;
    }
    confirmInventoryChange(
      '确认提取',
      `${typeLabel(type)} ${quantity} 条，用途为“${purpose}”。领取后进入待使用，不会直接算作实际使用。`,
      () => {
        if (kind === 'mail' && !mailExtractionPurposes(type).includes(d['inventory-purpose'])) {
          api.notify('提取用途已变化，请重新选择');
          return;
        }
        const fresh = collection(kind).filter((asset) => asset.type === type && available(asset));
        if (fresh.length < quantity) {
          api.notify('库存已变化，请重新核对');
          return;
        }
        const batch = createBatch(
          kind,
          fresh.slice(0, quantity),
          purpose,
          d['inventory-extract-notes']
        );
        return () => {
          api.state.drafts.delete(`inventory-extract:${kind}`);
          api.go(`workspace/extractions/${batch.id}`);
        };
      }
    );
  }
  async function copyClaims(claims, control) {
    if (!claims.length || claims.some((claim) => !claim || !ownerAllowed(claim.batch))) return;
    const assets = claims.map(({ item }) => assetById(item.assetId));
    if (assets.some((asset) => !asset)) return;
    const relayClaims = localData ? claims.filter(({ item }) => item.type === 'relay') : [];
    if (!relayClaims.length) {
      await api.copyText(assets.map(copyAssetLine).join('\n'));
      return;
    }
    if (relayClaims.some((claim) => !useAllowed(claim))) {
      api.notify('只能复制当前仍待使用的隐藏邮箱查询码');
      return;
    }
    const route = api.state.route;
    if (control) control.disabled = true;
    try {
      const { items } = await localData.relay('extraction-codes', {
        claimIds: relayClaims.map(({ item }) => item.id)
      });
      if (
        api.state.route !== route ||
        control?.isConnected === false ||
        relayClaims.some(({ item }) => {
          const current = claimById(item.id);
          return !current || !useAllowed(current);
        })
      )
        return;
      const codes = new Map(items.map(({ id, email, queryCode }) => [id, { email, queryCode }]));
      const lines = claims.map(({ item }, index) => {
        if (item.type !== 'relay') return copyAssetLine(assets[index]);
        const result = codes.get(item.id);
        if (!result?.queryCode || result.email !== assets[index].email)
          throw new Error('部分查询码无法核对，本次没有复制');
        return `${result.email}\t${result.queryCode}`;
      });
      await api.copyText(lines.join('\n'), '所选资料已复制');
    } catch (error) {
      if (api.state.route === route) api.notify(error?.message || '读取隐藏邮箱查询码失败，请重试');
    } finally {
      if (control) control.disabled = false;
    }
  }
  function submitReturn(form) {
    const d = api.readForm(form),
      ids = Object.entries(d)
        .filter(([name, value]) => name.startsWith('inventory-return-choice-') && value)
        .map(([, value]) => value);
    if (!ids.length) {
      api.notify('请勾选本次需要归还的资料');
      return;
    }
    const claims = ids.map(claimById);
    if (new Set(ids).size !== ids.length || claims.some((claim) => !claim)) {
      api.notify('所选领用记录无效，请重新核对');
      return;
    }
    if (!['未使用', '死号', '解封中'].includes(d['inventory-return-reason'])) {
      api.setError('inventory-return-reason', '请选择有效的归还理由');
      return;
    }
    const blocked = claims.filter(({ batch, item }) =>
      returnBlock(assetById(item.assetId), batch, item)
    );
    if (blocked.length) {
      api.notify('领用或业务状态已变化，请重新核对');
      return;
    }
    confirmInventoryChange(
      '确认归还',
      `${claims.length} 条资料，理由“${d['inventory-return-reason']}”。保留原提取与归还历史。`,
      () => {
        if (claims.some(({ batch, item }) => returnBlock(assetById(item.assetId), batch, item))) {
          api.notify('存在后续业务关联，本次未执行');
          return;
        }
        for (const { batch, item } of claims) {
          const asset = assetById(item.assetId),
            reason = d['inventory-return-reason'];
          item.status = reason === '未使用' ? 'returned' : 'abnormal';
          item.returnedAt = inventoryNow();
          item.reason = reason;
          asset.inventoryState = 'available';
          asset.used = false;
          asset.health = reason === '死号' ? 'dead' : reason === '解封中' ? 'unlocking' : 'normal';
          asset.claimId = '';
          asset.claimBatchId = '';
          log(asset, '归还', `${batch.id} · ${reason}`);
          returnRecords.unshift({
            id: uid('RETURN'),
            batchId: batch.id,
            assetId: asset.id,
            email: asset.email,
            ...(asset.type === 'grok' && { loginMethod: asset.loginMethod, xHandle: asset.xHandle }),
            reason,
            time: inventoryNow(),
            actorId: currentActor().id,
            actor: currentActor().name,
            notes: d['inventory-return-notes']
          });
        }
        return () => {
          api.getSelection('inventory-claims').clear();
          api.getSelection('inventory-module-assets').clear();
          finishDrawer(form.dataset.inventoryDraft);
          api.render();
          api.notify('归还完成，原批次记录已保留');
        };
      }
    );
  }
  function submitUse(form) {
    const d = api.readForm(form),
      claims = d['inventory-use-ids'].split(',').map(claimById).filter(Boolean);
    if (!claims.length || !usePurposesFor(claims).includes(d['inventory-use-purpose'])) {
      api.setError('inventory-use-purpose', '请选择有效的实际用途');
      return;
    }
    if (!d['inventory-use-result'].trim()) {
      api.setError('inventory-use-result', '请记录实际使用结果');
      return;
    }
    if (claims.some((claim) => !useAllowed(claim))) {
      api.notify('领用或业务状态已变化，请重新核对');
      return;
    }
    confirmInventoryChange(
      '确认实际使用',
      `确认 ${claims.length} 条已用于${d['inventory-use-purpose']}。这些资料不再进入通用可提取库存。`,
      () => {
        if (claims.some((claim) => !useAllowed(claim))) {
          api.notify('确认期间领用或业务状态已变化，本次未登记');
          return;
        }
        for (const { item } of claims)
          consume(assetById(item.assetId), item, {
            kind: 'manual-use',
            ...(mailboxType(assetById(item.assetId)?.type) && /^注册 /.test(d['inventory-use-purpose'])
              ? { product: registrationProduct(d['inventory-use-purpose'].slice(3)) } : {}),
            label: `${d['inventory-use-purpose']} · ${d['inventory-use-result']}`
          });
        return () => {
          finishDrawer(form.dataset.inventoryDraft);
          api.getSelection('inventory-claims').clear();
          api.render();
        };
      }
    );
  }
  function submitImport(form, commit = false, restored = null) {
    const d = { ...(restored || api.readForm(form)) },
      type = d['inventory-import-type'];
    const route = api.state.route;
    const microsoft = form.dataset.inventoryDraft === 'inventory-import:microsoft';
    const protectPreview = microsoft || personalAccount(type);
    if (microsoft !== (type === 'microsoft') ||
        (microsoft ? !microsoftEntryAllowed(route) : route === microsoftMailboxRoute)) {
      api.notify('导入类型或入口已变化，请重新打开批量导入');
      return;
    }
    if (type === 'relay') {
      api.setError('inventory-import-type', '隐藏邮箱须选择所属主邮箱后单独导入');
      return;
    }
    const accountEntry =
      accountSubmissionRoute() ||
      d['inventory-import-scope'] === 'account-submit' ||
      String(form.dataset.inventoryDraft || '').startsWith('inventory-import:account-submit:');
    const clearAccountPreview = () => {
      if (accountEntry || microsoft) {
        const target = document.getElementById('inventory-import-results');
        if (target) target.innerHTML = '';
        if (protectPreview) protectedImportPreviews.delete(form);
      }
    };
    const entryContext = accountEntry ? accountImportContext : null;
    if (accountEntry && !validAccountImportContext(form, d, entryContext)) {
      clearAccountPreview();
      api.setError('inventory-import-type', '本批账号类型或入口已变化，请从账号卡片重新打开');
      return;
    }
    if (entryContext && !commit) {
      // A fresh precheck replaces its former row controls; they belong to the old CSV.
      for (const name of Object.keys(d))
        if (name.startsWith('inventory-import-row-type-')) delete d[name];
      clearAccountPreview();
    }
    const fundingApple = fundingAppleRoute();
    const account = !fundingApple && ['gpt', 'claude'].includes(type);
    const choices = microsoft ? [['microsoft', '微软邮箱']] : entryContext
      ? [[entryContext.type, typeLabel(entryContext.type)]]
      : fundingApple
        ? [['apple', '苹果 ID']]
        : account
          ? [
              ['gpt', 'GPT 账号'],
              ['claude', 'Claude 账号']
            ]
          : mailboxWorkflowTypes().filter(([id]) => id !== 'relay');
    const typeId = (value) =>
      choices.find(([id, label]) =>
        [id, label].some(
          (name) =>
            name.replace(/\s/g, '').toLowerCase() === String(value).replace(/\s/g, '').toLowerCase()
        )
      )?.[0] || '';
    const source = d['inventory-import-content'] || '';
    const snapshot = protectPreview ? formFingerprint(d) : '';
    const previous = protectPreview ? protectedImportPreviews.get(form) : null;
    let previewSource = protectPreview ? (previous?.id || '') : JSON.stringify([type, source]);
    let hasPreviousPreview = d['inventory-import-preview-source'] === previewSource &&
      (!protectPreview || previous?.snapshot === snapshot);
    let rows;
    try {
      rows = api.legacy.parseCsv(source, { trimCells: !microsoft && !personalAccount(type) });
    } catch {
      clearAccountPreview();
      api.setError('inventory-import-content', 'CSV 格式不正确，请检查引号');
      return;
    }
    if (!rows.length) {
      clearAccountPreview();
      api.setError('inventory-import-content', '请先填写导入内容');
      return;
    }
    if (rows.length > (entryContext || microsoft ? 501 : 500)) {
      clearAccountPreview();
      api.setError(
        'inventory-import-content',
        localData ? '单次最多导入 500 行' : '单次演示最多导入 500 行'
      );
      return;
    }
    const seen = new Set(allAssets().map((asset) => `${asset.type}:${asset.email.toLowerCase()}`));
    const results = entryContext || microsoft
      ? parseAccountImport(rows, d, entryContext || { type })
      : rows.flatMap((columns, index) => {
          const [
            email = '',
            password = '',
            phone = '',
            country = '',
            city = '',
            registered = '',
            csvType = '',
            device = '',
            proxyUrl = ''
          ] = columns.map((value) => String(value).trim());
          if (
            index === 0 &&
            ['邮箱', '邮箱账号', '账号邮箱', 'email'].includes(email.toLowerCase())
          )
            return [];
          const finalType = typeId(
            hasPreviousPreview && d[`inventory-import-row-type-${index + 1}`] !== undefined
              ? d[`inventory-import-row-type-${index + 1}`]
              : csvType || type
          );
          const key = `${finalType}:${email.toLowerCase()}`;
          let error = !finalType
            ? '请人工确认有效资料类型'
            : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
              ? '邮箱格式错误'
              : seen.has(key)
                ? '相同类型邮箱重复，不覆盖原资料'
                : '';
          if (!error && ['google', 'apple'].includes(finalType) && !password) error = '缺少密码';
          if (
            !error &&
            ['google', 'apple'].includes(finalType) &&
            !phone &&
            !d['inventory-import-no-phone']
          )
            error = '需确认未绑定电话';
          if (!error && columns.length > 9) error = '存在多余列，请按模板填写';
          if (!error && ['apple', 'google'].includes(finalType) && !country) error = '缺少国家';
          if (!error && finalType === 'google' && device.length > 200) error = '登录设备最多 200 个字符';
          if (!error && finalType === 'claude' && !device) error = '缺少登录设备';
          if (!error && finalType === 'claude' && !proxyUrl) error = '缺少注册代理链接';
          if (!error && phone && /^[a-z][a-z0-9+.-]*:/i.test(phone) && !phoneCodeUrl(phone)) error = '验证码链接仅支持有效的 HTTP(S) 地址';
          if (!error && finalType === 'claude') {
            try { parseRegistrationProxy(proxyUrl); } catch (issue) { error = issue.message; }
          }
          if (!error && usesAccountLocation(finalType))
            error = accountLocationError(finalType, country, city);
          if (!error && registered && !validRegisteredDate(registered))
            error = '注册时间无效或晚于当前时间';
          seen.add(key);
          return [
            {
              id: String(index + 1),
              line: index + 1,
              email,
              password,
              phone,
              country,
              city: usesRegistrationCity(finalType) ? city : '',
              registered,
              type: finalType,
              fields: { device, ...(finalType === 'claude' ? parseRegistrationProxySafe(proxyUrl) : {}) },
              error
            }
          ];
        });
    const registeredAddresses = new Set();
    for (const row of results) {
      const source = row.fields?.source || d['inventory-import-source'];
      const address = registrationAddress(row.email);
      if (!address || !stockRegistration({ type: row.type, source })) continue;
      const issue = registrationInputProblem(row.type, address, source);
      if (issue) row.error = issue;
      else if (!row.error && registeredAddresses.has(address)) row.error = '本批次已有同邮箱的 AI 账号';
      registeredAddresses.add(address);
    }
    if (protectPreview) {
      if (!hasPreviousPreview) previewSource = uid('PREVIEW');
      protectedImportPreviews.set(form, { id: previewSource, snapshot });
    }
    if (entryContext) {
      if (!protectPreview) {
        previewSource = accountImportFingerprint(d, entryContext, results);
        hasPreviousPreview = d['inventory-import-preview-source'] === previewSource;
      }
      const allowedLines = new Set(results.map((row) => `inventory-import-row-type-${row.line}`));
      if (
        commit &&
        Object.keys(d).some(
          (name) => name.startsWith('inventory-import-row-type-') && !allowedLines.has(name)
        )
      ) {
        clearAccountPreview();
        api.setError('inventory-import-content', '预览行号已变化，请重新检查后确认');
        return;
      }
    }
    if (!results.length) {
      clearAccountPreview();
      api.setError('inventory-import-content', '表头下没有可导入的资料');
      return;
    }
    const errors = results.filter((row) => row.error);
    document.getElementById('inventory-import-results').innerHTML =
      table(
        [
          { id: 'line', label: '行号' },
          { id: 'email', label: '邮箱 / 账号', render: row => esc(displayIdentity(row) || '—') },
          ...(!microsoft ? [{
            id: 'suggestion',
            label: '地址建议',
            render: (row) =>
              esc(account ? '产品与邮箱类型由人工确认' : mailboxSuggestion(row.email))
          }] : []),
          {
            id: 'type',
            label: '最终资料类型',
            render: (row) =>
              protectPreview ? esc(typeLabel(row.type)) : select(
                `inventory-import-row-type-${row.line}`,
                [['', '请选择类型'], ...choices],
                row.type
              ).replace(
                '<select ',
                `<select form="inventory-import-form" aria-label="第 ${row.line} 行最终资料类型" `
              )
          },
          ...(microsoft ? [
            { id: 'login', label: '登录方式', render: (row) => esc(choiceLabel(microsoftLoginModes, row.fields?.microsoftSecurity?.loginMode)) },
            { id: 'auxiliary', label: '辅助邮箱' },
            { id: 'recovery', label: '取码方式', render: (row) => esc(microsoftRecoveryLabel(row.fields || {})) },
            { id: 'verification', label: '验证方式', render: (row) => esc(microsoftVerificationLabel(row.fields || {})) },
            { id: 'source', label: '来源渠道' }
          ] : entryContext
            ? accountCsvFields
                .filter(
                  ([key]) =>
                    !['email', 'type', 'registered', 'password'].includes(key) &&
                    results.some((row) => row.fields?.[key])
                )
                .map(([key, label]) => ({
                  id: key,
                  label,
                  long: [
                    'totp',
                    'proxyUrl',
                    'proxyPassword',
                    'appPassword',
                    'security1',
                    'security2',
                    'security3',
                    'notes',
                    'notes2'
                  ].includes(key),
                  render: (row) =>
                    esc(
                      key === 'emailType'
                        ? accountEmailType(row.fields || {})
                        : personalAccount(type) && key === 'loginMethod' ? choiceLabel(grokLoginOptions, row.fields?.[key])
                          : personalAccount(type) && key === 'xLinkState' ? choiceLabel(xLinkOptions, row.fields?.[key])
                          : personalAccount(type) && key === 'totp' ? (row.fields?.[key] ? '已填写' : '—')
                          : row.fields?.[key] || '—'
                    )
                }))
            : account ? [{ id: 'country', label: '注册国家' }, ...(usesRegistrationCity(type) ? [{ id: 'city', label: '注册城市' }] : [])] : []),
          {
            id: 'registered',
            label: '注册时间',
            render: (row) => esc((row.registered || '保存时取录入时间').replace('T', ' '))
          },
          ...(!microsoft ? [{
            id: 'age',
            label: '养号判断',
            render: (row) => (row.type === 'claude' ? esc(row.registered ? ageLabel(row) : '从录入时开始') : '不适用')
          }] : []),
          {
            id: 'result',
            label: '检查结果',
            render: (row) => (row.error ? tag(row.error, 'danger') : tag('可导入', 'success'))
          }
        ],
        results,
        '',
        '导入预览'
      ) +
      `<input type="hidden" form="inventory-import-form" name="inventory-import-preview-source" value="${esc(previewSource)}" /><div class="form-footer"><span class="footnote">${microsoft ? '微软验证资料按表头保存。' : entryContext ? '本批产品类型固定，扩展字段按表头保存。' : '每行类型可直接修正。'}空白注册时间取录入时间。</span>${button('确认导入', 'inventory-import-confirm', 'primary', '', errors.length ? 'disabled' : '')}</div>`;
    saveDrafts();
    if (errors.length) {
      api.setError(
        'inventory-import-content',
        `${errors.length} 行需修正。本次不会部分导入，也不会覆盖原资料。`
      );
      return;
    }
    api.setError('inventory-import-content', '');
    if (!commit) return;
    if (!hasPreviousPreview) {
      api.notify('导入内容或默认类型已变化，请核对新的逐行预览后再确认');
      return;
    }
    confirmInventoryChange(
      '确认批量导入',
      `确认导入 ${results.length} 条资料。已填写的注册时间按原值保存，空白取录入时间。`,
      () => {
        if (protectPreview && (!form.isConnected || (microsoft && (api.state.route !== route || !microsoftEntryAllowed(route))) ||
            formFingerprint(api.readForm(form)) !== snapshot ||
            protectedImportPreviews.get(form)?.id !== previewSource)) {
          api.notify('确认期间导入资料或来源已变化，请重新预检');
          return;
        }
        if (entryContext) {
          const current = api.readForm(form);
          if (
            accountImportContext !== entryContext ||
            !validAccountImportContext(form, current, entryContext) ||
            (!protectPreview && accountImportFingerprint(current, entryContext, results) !== previewSource)
          ) {
            api.notify('确认期间导入内容、来源、无电话确认或账号类型已变化，本次未导入');
            return;
          }
        }
        if (
          results.some((row) =>
            allAssets().some(
              (asset) =>
                asset.type === row.type && identityKey(asset) === identityKey(row)
            )
          )
        ) {
          api.notify('库存已变化，存在相同类型资料，请重新预检');
          return;
        }
        const importId = uid('IMPORT'),
          createdAt = inventoryNow();
        for (const row of results) {
          const asset = normalize({
            ...(row.fields || {}),
            id: uid(row.type),
            type: row.type,
            email: row.email,
            password: row.password,
            phone: row.phone,
            country: row.country,
            ...(row.type !== 'gpt' && { city: row.city }),
            status: row.fields?.status || '正常',
            source: row.fields?.source || d['inventory-import-source'],
            registered: row.registered || (localData ? '' : createdAt),
            createdById: currentActor().id,
            createdBy: currentActor().name,
            createdAt,
            importedAt: createdAt,
            importId,
            health: 'normal',
            inventoryState: 'available',
            used: false
          });
          collection(stockType(row.type) ? 'account' : 'mail').unshift(asset);
          log(asset, '导入资料', importId);
        }
        const importedTypes = [...new Set(results.map((row) => row.type))];
        importRecords.unshift({
          id: importId,
          type: importedTypes.length === 1 ? importedTypes[0] : 'mixed',
          types: importedTypes,
          time: createdAt,
          actorId: currentActor().id,
          actor: currentActor().name,
          total: results.length,
          success: results.length,
          failed: 0,
          status: '已导入',
          results: results.map(({ id: rowId, line, email, type: rowType, registered }) => ({
            id: rowId,
            line,
            email: email || results.find(row => row.id === rowId)?.xHandle || '',
            type: rowType,
            registered: registered || (localData ? '' : createdAt),
            createdAt,
            result: '已导入'
          }))
        });
        return () => {
          finishDrawer(form.dataset.inventoryDraft || 'inventory-import');
          api.render();
          api.notify('导入完成，可在导入记录查询原批次');
        };
      }
    );
  }

  function onClick(action, node) {
    initialize();
    if (!action.startsWith('inventory-')) return false;
    if (action === 'inventory-reload') {
      if (localData && localInventoryState === 'error') {
        void api.withActionFeedback(node, () => readLocalInventory(),
          { pending: '正在读取库存…', success: '库存资料已重新读取', failure: '库存读取失败，请重试' });
        api.render();
      }
      return true;
    }
    if (localData && (localInventoryState !== 'ready' || inventorySavePending)) {
      api.notify('库存尚未就绪或仍在保存，请稍候重试');
      return true;
    }
    const id = node.dataset.id;
    if (action === 'inventory-go') api.go(node.dataset.route);
    else if (action === 'inventory-close') api.closeDrawer();
    else if (action === 'inventory-center') {
      api.closeDrawer();
      api.go('workspace/extractions');
    } else if (action === 'inventory-tab') {
      view().tab = node.dataset.tab;
      api.state.page = 1;
      api.getSelection('inventory-module-assets').clear();
      api.render();
    } else if (action === 'inventory-center-tab') {
      view().centerTab = node.dataset.tab;
      api.state.page = 1;
      api.render();
    } else if (action === 'inventory-batch') {
      api.closeDrawer();
      api.go(`workspace/extractions/${id}`);
    } else if (action === 'inventory-batch-return') {
      const batch = batches.find((entry) => entry.id === id);
      if (batch)
        void reviewReturn(
          batch.items.map((item) => ({ batch, item })),
          [],
          false
        );
    } else if (action === 'inventory-mailbox-platform') {
      openMailboxPlatform(id);
    } else if (action === 'inventory-platform-review') {
      saveDrafts();
      const key = `inventory-mailbox-platform:${id}`;
      const saved = draft(key);
      delete saved['inventory-platform-version'];
      api.state.drafts.set(key, saved);
      openMailboxPlatform(id);
    } else if (action === 'inventory-usage-correction') {
      openUsageCorrection(id, Number(node.dataset.index));
    } else if (action === 'inventory-usage-review') {
      openUsageReview();
    } else if (action === 'inventory-usage-confirm') {
      void persistInventory('inventory_reconcile_usage', () => () => {
        api.closeDrawer();
        api.render();
        api.notify('已同步有明确依据的库存使用记录');
      });
    } else if (action === 'inventory-return-all' || action === 'inventory-return-clear') {
      const form = document.getElementById('inventory-return-form');
      for (const control of form?.querySelectorAll('input[data-return-claim]:not(:disabled)') || [])
        control.checked = action === 'inventory-return-all';
      updateReturnSelection(form);
    } else if (action === 'inventory-copy-microsoft-template' && microsoftEntryAllowed())
      void api.copyText(accountCsvTemplate('microsoft'));
    else if (action === 'inventory-import-confirm')
      submitImport(document.getElementById('inventory-import-form'), true);
    else if (action === 'inventory-personal-registration' && personalAccount(node.dataset.type))
      assetEditor('', node.dataset.type, id);
    else if (action === 'inventory-add') assetEditor();
    else if (action === 'inventory-add-type') assetEditor('', node.dataset.type);
    else if (action === 'inventory-relay-entry-copy') {
      const asset = assetById(id);
      if (asset?.type === 'relay') void api.copyText(asset.email);
    }
    else if (action === 'inventory-edit') assetEditor(id);
    else if (action === 'inventory-detail') assetDetail(id);
    else if (action === 'inventory-more') assetMore(id, node);
    else if (action === 'inventory-account-lifecycle') void openAccountLifecycle(id, node.dataset.operation);
    else if (action === 'inventory-lifecycle-review') void openAccountLifecycle(id, node.dataset.operation, true);
    else if (action === 'inventory-lifecycle-order') api.go(`orders/detail/${encodeURIComponent(id)}`);
    else if (action === 'inventory-return-asset') {
      const asset = assetById(id),
        claim = pendingClaim(asset);
      if (claim) void reviewReturn([claim]);
      else api.notify('没有有效领用记录');
    } else if (action === 'inventory-return-selected')
      void reviewReturn(
        [...api.getSelection('inventory-module-assets')]
          .map(assetById)
          .map(pendingClaim)
          .filter(Boolean)
      );
    else if (action === 'inventory-item-return') {
      const claim = claimById(id);
      if (claim) void reviewReturn([claim]);
    } else if (action === 'inventory-claim-return') void reviewReturn(selectedClaims());
    else if (action === 'inventory-claim-use') confirmUse(selectedClaims());
    else if (action === 'inventory-item-copy') {
      const claim = claimById(id);
      if (claim) void copyClaims([claim], node);
    } else if (action === 'inventory-claim-copy') void copyClaims(selectedClaims(), node);
    else if (action === 'inventory-copy-selected')
      void api.copyText(
        [...api.getSelection('inventory-module-assets')]
          .map(assetById)
          .filter(Boolean)
          .map(copyAssetLine)
          .join('\n')
      );
    else if (action === 'inventory-health') {
      const asset = assetById(id),
        health = node.dataset.health;
      confirmInventoryChange(
        '确认账号状态变化',
        `${displayIdentity(asset)}：${health === 'dead' ? '移入死号' : health === 'unlocking' ? '移入解封中' : '恢复正常资料视图'}。已使用关联及历史保持不变。`,
        () => {
          asset.health = health;
          asset.healthChangedAt = inventoryNow();
          log(asset, '健康状态变化', health);
          return () => {
            finishDrawer();
            api.render();
          };
        }
      );
    } else if (action === 'inventory-undo') {
      const asset = assetById(id),
        snapshot = undo.get(id);
      if (!snapshot || snapshot.version !== asset.version)
        api.notify('资料已有后续变化，不能覆盖恢复');
      else
        confirmInventoryChange(
          '撤回最近资料修改',
          '只恢复最近修改前的普通资料值，不删除操作历史。',
          () => {
            if (undo.get(id) !== snapshot || snapshot.version !== asset.version) {
              api.notify('确认期间资料已有后续变化，不能覆盖恢复');
              return;
            }
            Object.assign(asset, snapshot.snapshot);
            log(asset, '撤回修改');
            undo.delete(id);
            return () => {
              finishDrawer();
              api.render();
            };
          }
        );
    } else if (action === 'inventory-delete') {
      const asset = assetById(id);
      if (!asset) return true;
      if (stockRegistration(asset) && registrationAddress(asset.email)) {
        api.notify('已登记的注册邮箱和原账号必须保留');
        return true;
      }
      if (asset.type === 'relay') {
        api.notify('隐藏邮箱需在专用管理中核对主邮箱、邮件与历史引用后移除');
        api.modules.appleRelay?.openAliasDetail(id);
        return true;
      }
      const deletionBlocked = () =>
        assetById(id) !== asset ||
        asset.inventoryState !== 'available' ||
        asset.usageLinks.length ||
        batches.some((batch) => batch.items.some((item) => item.assetId === id)) ||
        (asset.type === 'apple' &&
          (api.modules.appleBalance?.entries(id).length ||
            api.money.compare(api.modules.appleBalance?.get(id)?.balance || '0', '0') !== 0));
      if (deletionBlocked())
        api.notify('资料存在使用、提取或余额台账，禁止永久删除；可冻结资料并保留历史');
      else
        confirmInventoryChange(
          localData ? '永久删除 1 条库存资料' : '永久删除 1 条演示资料',
          localData
            ? `将永久移除 ${asset.email}，请核对所选资料。`
            : `将移除 ${asset.email}，此操作仅影响原型内存；实际系统仍需独立的影响核验。`,
          () => {
            if (deletionBlocked()) {
              api.notify('确认期间资料或余额台账已变化，禁止永久删除');
              return;
            }
            const data = isAccount(asset) ? accounts : mailboxes;
            data.splice(data.indexOf(asset), 1);
            return () => {
              finishDrawer();
              api.render();
            };
          }
        );
    } else if (action === 'inventory-claude-history') openClaudeHistoryIntake();
    else if (action === 'inventory-claude-history-preview')
      void previewClaudeHistory(document.getElementById(claudeHistoryKey + '-form'));
    else if (action === 'inventory-import') importEditor(node.dataset.type);
    else if (action === 'inventory-import-example') {
      const form = document.getElementById('inventory-import-form');
      const context = accountImportContext;
      if (!form || !validAccountImportContext(form, api.readForm(form), context)) {
        api.notify('请从账号提交卡片重新打开导入');
        return true;
      }
      document.getElementById('inventory-import-content').value = accountCsvTemplate(context.type);
      document.getElementById('inventory-import-results').innerHTML = '';
      api.setError('inventory-import-content', '');
      saveDrafts();
    } else if (action === 'inventory-entry-imports') {
      openEntryImports();
    } else if (action === 'inventory-import-detail') {
      const record = importRecords.find((entry) => entry.id === id);
      if (!record && api.modules.appleRelay) {
        api.modules.appleRelay.openImportDetail(id);
        return true;
      }
      if (record)
        showDrawer(
          '导入批次详情',
          '',
          `<div class="property-list"><div class="property-row"><span>导入批次</span><strong>${esc(record.id)}</strong></div><div class="property-row"><span>操作人</span><strong>${esc(record.actor)}</strong></div><div class="property-row"><span>导入时间</span><strong>${esc(record.time)}</strong></div></div>` +
            (record.results.length
              ? table(
                  [
                    { id: 'line', label: '原文件行号' },
                    { id: 'email', label: '邮箱 / 账号' },
                    { id: 'type', label: '最终资料类型', render: (row) => typeLabel(row.type) },
                    {
                      id: 'registered',
                      label: '注册时间',
                      render: (row) => esc(row.registered || '未提供')
                    },
                    { id: 'createdAt', label: '录入时间' },
                    { id: 'result', label: '导入结果' }
                  ],
                  record.results,
                  '',
                  '导入明细'
                )
              : empty('历史导入摘要', `${record.success} 条成功。演示历史不伪造逐行原始文件。`)),
          button('关闭', 'inventory-close')
        );
    } else if (action === 'inventory-purpose-settings') {
      openMailPurposeSettings();
    } else if (action === 'inventory-purpose-settings-reload') {
      const form = document.getElementById('inventory-purpose-settings-form');
      if (!form || api.state.route !== 'workspace/mail-extract') return true;
      const snapshot = JSON.stringify(api.readForm(form)), actorId = currentActor().id;
      api.confirmAction('重新读取用途设置', '将用最新清单替换当前用途设置草稿，邮箱提取表单内容继续保留。', async () => {
        const current = () => api.state.route === 'workspace/mail-extract' && currentActor().id === actorId &&
          document.getElementById(form.id) === form && JSON.stringify(api.readForm(form)) === snapshot;
        if (!current()) return;
        if (localData && !await readLocalInventory({ keepContent: true })) {
          api.notify('读取用途设置失败，当前输入已保留，请重试');
          return;
        }
        if (current()) openMailPurposeSettings(true);
      });
    } else if (action === 'inventory-settings' || action === 'inventory-location-settings') {
      const locationOnly = action === 'inventory-location-settings';
      const type = locationOnly ? node.dataset.type
        : fundingAppleRoute() ? 'apple' : api.state.route.split('/')[1];
      if (locationOnly && !usesAccountLocation(type)) return true;
      const from = node.dataset.from;
      if (locationOnly && (from === 'asset' || from === 'import')) {
        saveDrafts();
        locationSettingsReturn = { route: api.state.route, type, from, id: id || '' };
      }
      const config = settingsFor(type),
        key = `inventory-${locationOnly ? 'location-' : ''}settings:${type}`,
        saved = api.state.drafts.get(key) || {};
      let cities = '';
      if (usesRegistrationCity(type)) {
        const countries = settingsCountries(saved, config);
        cities = `<div id="inventory-settings-city-groups" class="option-settings-groups" data-countries="${esc(JSON.stringify(countries))}">${accountCityEditors(type, countries, saved)}</div>`;
      }
      showDrawer(
        locationOnly ? `${typeLabel(type)}国家地区设置` : '本表设置',
        '这些选项只作用于本资料表。',
        `<form id="inventory-settings-form" data-inventory-draft="${key}" novalidate><input type="hidden" name="inventory-settings-type" value="${type}" /><div class="option-settings-groups">${api.optionListEditor({ id: 'inventory-settings-countries', label: '国家地区', itemLabel: '国家名称', values: config.countries, minItems: 1, draft: saved })}${locationOnly ? '<input type="hidden" name="inventory-location-only" value="1" />' : api.optionListEditor({ id: 'inventory-settings-sources', label: '来源渠道', itemLabel: '来源名称', values: config.sources, minItems: 1, draft: saved })}${!locationOnly && type === 'claude' ? field('养号阈值', 'inventory-settings-hours', input('inventory-settings-hours', saved['inventory-settings-hours'] ?? config.hours, 'type="number" min="1" max="8760"'), false, '从注册时间起计算。默认 72 小时，达到门槛且账号正常时才可提取。') : ''}${cities}</div></form>`,
        button('取消', 'inventory-close') +
          '<button class="button primary" form="inventory-settings-form" type="submit">确认设置</button>',
        key
      );
    } else if (action === 'inventory-register') openRegistration(id);
    else if (action === 'inventory-mail-read') {
      const asset = assetById(id);
      if (asset?.type === 'relay') {
        if (api.modules.appleRelay) api.modules.appleRelay.openMails(id);
        else api.notify('隐藏邮箱管理尚未就绪，请刷新页面后重试');
        return true;
      }
      showDrawer(
        '邮件查询',
        '仅展示受管邮箱取信结果，不读取真实邮箱。',
        `<div class="guide-list"><div class="guide-item"><h3>演示验证邮件</h3><p>发件人：verify@example.test</p><p>接收时间：2026-11-03 10:20</p><p>验证码：123456（演示无效）</p></div></div><div class="toolbar">${button('模拟查询失败', 'inventory-mail-fail')}${button('重试查询', 'inventory-mail-retry')}</div>`,
        button('关闭', 'inventory-close')
      );
    } else if (action === 'inventory-mail-fail')
      showDrawer(
        '邮件查询失败',
        '取信失败时保留查询条件，支持重试。',
        empty('暂时无法读取演示邮箱', '重试不会更改邮箱库存或查询码。'),
        button('重试', 'inventory-mail-retry') + button('关闭', 'inventory-close')
      );
    else if (action === 'inventory-mail-retry')
      showDrawer(
        '邮件查询',
        '已保留原查询条件，当前显示重试后的演示结果。',
        `<div class="guide-item"><h3>演示验证邮件</h3><p>验证码：123456（演示无效）</p></div>`,
        button('关闭', 'inventory-close')
      );
    else if (action === 'inventory-copy-query') {
      const asset = assetById(id);
      if (asset) void api.copyText(asset.queryCode || '');
    } else if (action === 'inventory-parent-detail') {
      if (api.modules.appleRelay) api.modules.appleRelay.openParentDetail(id);
      else api.notify('隐藏邮箱管理尚未就绪，请刷新页面后重试');
    }
    return true;
  }

  function onSubmit(form) {
    if (!form.id.startsWith('inventory-')) return false;
    if (localData && (localInventoryState !== 'ready' || inventorySavePending)) {
      api.notify('库存尚未就绪或仍在保存，请稍候重试');
      return true;
    }
    saveDrafts();
    if (form.id === 'inventory-extract-form') submitExtraction(form);
    else if (form.id === 'inventory-account-lifecycle-form') submitAccountLifecycle(form);
    else if (form.id === 'inventory-usage-correction-form') submitUsageCorrection(form);
    else if (form.id === 'inventory-return-form') submitReturn(form);
    else if (form.id === 'inventory-use-form') submitUse(form);
    else if (form.id === 'inventory-mailbox-platform-form') submitMailboxPlatform(form);
    else if (form.id === 'inventory-asset-form') saveAsset(form);
    else if (form.id === claudeHistoryKey + '-form') submitClaudeHistory(form);
    else if (form.id === 'inventory-import-form') submitImport(form);
    else if (form.id === 'inventory-quick-form') {
      void reviewQuickReturn(form);
    } else if (form.id === 'inventory-purpose-settings-form') {
      const key = 'inventory-purpose-settings:mail';
      if (api.state.route !== 'workspace/mail-extract' || form.dataset.inventoryDraft !== key) {
        api.notify('请从邮箱提取页面重新打开用途设置');
        return true;
      }
      if (api.optionListPending(form)) {
        api.notify('请先添加或保存正在输入的用途，也可以取消编辑后再保存设置');
        return true;
      }
      const data = api.readForm(form);
      if (localData && Number(data['inventory-purpose-settings-version']) !== localInventoryVersion) {
        api.notify('用途设置或库存已变化，输入已保留，请重新读取后再保存');
        return true;
      }
      let purposes;
      try {
        purposes = api.readOptionList(data['inventory-mail-purposes']);
      } catch {
        api.notify('用途列表格式不正确，请重新核对');
        return true;
      }
      if (!purposes.length || purposes.length > 100 || purposes.some(value => value.length > 100 || /[\x00-\x1f\x7f]/.test(value)) ||
          new Set(purposes.map(value => value.toLowerCase())).size !== purposes.length) {
        api.notify('请保留 1–100 个不重复的用途，每项不超过 100 个字且不含控制字符');
        return true;
      }
      confirmInventoryChange('确认本表设置', '更新邮箱提取用途，历史批次和账号提取用途保持原值。', () => {
        tableSettings.set(mailExtractionSettingsKey, { purposes });
        return () => {
          finishDrawer(key);
          api.render();
          if (!localData) api.notify('邮箱提取用途已保存');
        };
      });
    } else if (form.id === 'inventory-settings-form') {
      const data = api.readForm(form),
        type = data['inventory-settings-type'];
      const locationOnly = data['inventory-location-only'] === '1';
      const expectedKey = `inventory-${locationOnly ? 'location-' : ''}settings:${type}`;
      if (form.dataset.inventoryDraft !== expectedKey || (locationOnly && !usesAccountLocation(type))) {
        api.notify('设置入口或资料类型已变化，请从对应资料表重新打开');
        return true;
      }
      if (api.optionListPending(form)) {
        api.notify('请先添加或保存正在输入的项目，也可以取消该项编辑后再确认设置');
        return true;
      }
      const current = settingsFor(type);
      let countries, sources, cities;
      try {
        countries = settingsCountries(data, current);
        sources = locationOnly ? current.sources : [...new Set(api.readOptionList(data['inventory-settings-sources']))];
        if (usesRegistrationCity(type)) {
          cities = countries.map((country) => {
            const raw = data[accountCityEditorId(country)];
            const values = raw === undefined ? cityOptions(type, country) : api.readOptionList(raw);
            return [country, [...new Set(values)]];
          });
        }
      } catch {
        api.notify('配置项目格式不正确，请重新核对列表');
        return true;
      }
      const hours = type === 'claude' && !locationOnly
        ? Number(data['inventory-settings-hours'])
        : current.hours ?? 72;
      if (
        !countries.length ||
        !sources.length ||
        !Number.isInteger(hours) ||
        hours < 1 ||
        hours > 8760
      ) {
        api.notify('请至少保留一个国家和来源，养号时间需为 1–8760 的整数小时');
        return true;
      }
      confirmInventoryChange(
        '确认本表设置',
        '仅影响此资料表的后续选择和养号计算，不改历史记录。',
        () => {
          tableSettings.set(type, { countries, sources, hours, ...(cities ? { cities } : {}) });
          return () => {
            finishDrawer(form.dataset.inventoryDraft);
            api.render();
          };
        }
      );
    } else if (form.id === 'inventory-registration-form') {
      const data = api.readForm(form),
        asset = assetById(data['inventory-registration-asset']);
      if (!asset || asset.inventoryState === 'used') {
        api.notify('邮箱已实际使用');
        return true;
      }
      const activeClaim = pendingClaim(asset);
      if (
        localData &&
        asset.type === 'relay' &&
        (!activeClaim || !ownerAllowed(activeClaim.batch))
      ) {
        api.notify('原隐藏邮箱领用已变化，请重新打开当前批次');
        return true;
      }
      const unresolved = registrationRecords.find(
        (entry) => entry.id === data['inventory-registration-id']
      );
      const product = data['inventory-registration-product'];
      const products = relayRegistrationPlatforms;
      if (!products.some(([key]) => key === product) && !(unresolved && registrationProduct(unresolved.product) === product &&
        data['inventory-registration-result'] === '失败且未使用')) {
        api.setError('inventory-registration-product', '请选择有效的注册平台');
        return true;
      }
      if (
        unresolved &&
        registrationProduct(unresolved.product) !== product
      ) {
        api.setError(
          'inventory-registration-product',
          '待核对记录必须保持原产品，不能改作另一产品注册'
        );
        return true;
      }
      const registrationVersion = asset.version;
      confirmInventoryChange(
        '确认登记注册结果',
        `${asset.email} · ${data['inventory-registration-product'].toUpperCase()} · ${data['inventory-registration-result']}。不执行真实注册。`,
        () => {
          if (
            asset.version !== registrationVersion ||
            asset.inventoryState === 'used' ||
            asset.health !== 'normal' ||
            pendingClaim(asset)?.item.taskId
          ) {
            api.notify('确认期间邮箱或关联任务已变化，请重新核对');
            return;
          }
          let found = pendingClaim(asset);
          if (localData && asset.type === 'relay' && (!found || !ownerAllowed(found.batch))) {
            api.notify('原隐藏邮箱领用已变化，请重新打开当前批次');
            return;
          }
          if (!found) {
            const batch = createBatch(
              'mail',
              [asset],
              `注册 ${data['inventory-registration-product'].toUpperCase()}`,
              '从邮箱管理登记注册'
            );
            found = { batch, item: batch.items[0] };
          }
          const previousRecord = registrationRecords.find(
            (entry) => entry.id === data['inventory-registration-id']
          );
          const record = previousRecord || {
            id: uid('REGISTER'),
            assetId: asset.id,
            email: asset.email,
            product: data['inventory-registration-product'].toUpperCase(),
            state: data['inventory-registration-result'],
            createdById: currentActor().id,
            createdBy: currentActor().name,
            createdAt: inventoryNow(),
            time: inventoryNow(),
            accountId: ''
          };
          record.state = data['inventory-registration-result'];
          record.actorId = currentActor().id;
          record.actor = currentActor().name;
          record.time = inventoryNow();
          if (record.state === '成功') {
            found.item.registrationId = '';
            consume(asset, found.item, {
              kind: 'registration',
              registrationId: record.id,
              product: data['inventory-registration-product'],
              label: `已登记 ${record.product} 外部注册成功；账号资料需独立录入`
            });
          } else if (record.state === '待核对') {
            found.item.registrationId = record.id;
            log(asset, '注册结果待核对', record.id);
          } else {
            found.item.registrationId = '';
            log(asset, '登记注册失败且未使用', record.id);
          }
          if (!previousRecord) registrationRecords.unshift(record);
          return () => {
            finishDrawer(form.dataset.inventoryDraft);
            api.render();
            api.notify(
              record.state === '成功'
                ? '注册结果已记录，邮箱已使用；账号请在账号管理单独录入'
                : localData
                  ? '注册结果已记录'
                  : '演示注册结果已记录'
            );
          };
        }
      );
    }
    return true;
  }
  function onChange(node) {
    if (node.id === 'inventory-platform-product') {
      api.setError(node.id, '');
      saveDrafts();
      return true;
    }
    if (node.id === 'inventory-acquisitionMethod') {
      const form = node.form;
      const purchased = node.value === 'purchased';
      const previous = assetById(form.elements['inventory-asset-id'].value);
      const type = form.elements['inventory-asset-type'].value;
      const source = form.elements['inventory-sourceMailboxId'];
      if (source) {
        if (purchased) source.value = '';
        source.disabled = purchased;
      }
      for (const [name, key] of [['country-edit', 'country'], ['city', 'city'], ['device', 'device'], ['proxy-url', 'proxyUrl']]) {
        const control = form.elements['inventory-' + name];
        const label = control?.closest('.field')?.querySelector('label[for="' + control.id + '"]');
        const applies = key === 'country' ? usesAccountLocation(type) : type === 'claude';
        const required = applies && !purchased && (!previous || Boolean(previous[key]));
        const star = label?.querySelector('.required');
        if (star) star.hidden = !required;
        else if (label && required) label.insertAdjacentHTML('beforeend', '<span class="required">*</span>');
      }
      if (purchased && !previous) {
        const registered = form.elements['inventory-registered'];
        if (registered && registered.value === registered.defaultValue) registered.value = '';
      }
      saveDrafts();
      return true;
    }
    if (node.id === 'inventory-sourceMailboxId') {
      const mailbox = assetById(node.value);
      const email = document.getElementById('inventory-email');
      const confirmed = document.getElementById('inventory-source-confirmed');
      if (mailbox && email && !email.value.trim()) email.value = mailbox.email;
      if (confirmed) confirmed.checked = false;
      saveDrafts();
      return true;
    }
    if (!node.id.startsWith('inventory-')) return false;
    if (node.id.startsWith('inventory-return-choice-')) {
      updateReturnSelection(node.form);
    } else if (node.id === 'inventory-asset-type') {
      const form = node.form || document.getElementById('inventory-asset-form');
      const values = api.readForm(form);
      if (!values['inventory-asset-id']) {
        if (accountSubmissionRoute()) {
          const context = accountAssetContext;
          if (
            !accountEntryType(node.value) ||
            !context ||
            form.dataset.inventoryDraft !== context.key ||
            values['inventory-entry-scope'] !== 'account-submit' ||
            values['inventory-entry-type'] !== context.type
          ) {
            api.notify('账号提交不接受此资料类型或已失效的草稿');
            return true;
          }
          api.state.drafts.set(context.key, {
            ...api.readDraft(form),
            'inventory-asset-type': context.type
          });
          const nextType = node.value;
          node.value = context.type;
          assetEditor('', nextType);
          saveDrafts();
          return true;
        } else {
          const previousKey = form.dataset.inventoryDraft;
          const previousType = previousKey?.split(':').at(-1);
          if (previousKey && previousType) {
            api.state.drafts.set(previousKey, { ...api.readDraft(form), 'inventory-asset-type': previousType });
            // openDrawer preserves the departing form, so restore its own type first.
            const nextType = node.value;
            node.value = previousType;
            assetEditor('', nextType);
            saveDrafts();
            return true;
          }
        }
        assetEditor('', node.value);
      }
    } else if (node.id.startsWith('inventory-import-row-type-')) {
      submitImport(node.form || document.getElementById('inventory-import-form'));
    } else if (node.id === 'inventory-country') {
      view().country = node.value;
      api.state.page = 1;
      api.render();
    } else if (node.id === 'inventory-purpose' || node.id === 'inventory-extract-type') {
      saveDrafts();
      api.render();
    } else if (node.id === 'inventory-usage-filter') {
      view().usage = node.value;
      api.state.page = 1;
      api.render();
      document.getElementById(node.id)?.focus({ preventScroll: true });
      return true;
    } else if (node.id === 'inventory-status') {
      view().status = node.value;
      api.state.page = 1;
      api.render();
    } else if (node.id === 'inventory-country-edit') {
      const city = document.getElementById('inventory-city');
      if (city) {
        const form = node.form || document.getElementById('inventory-asset-form');
        const values = form && api.readForm(form);
        const id = values?.['inventory-asset-id'];
        const type = values?.['inventory-asset-type'];
        if (usesRegistrationCity(type))
          city.innerHTML = options(accountCityChoices(type, node.value, id ? assetById(id) : null), '');
        api.setError('inventory-city', '');
      }
    } else if (node.id === 'inventory-proxy-protocol') {
      const link = document.getElementById('inventory-proxy-url');
      if (link?.value) previewRegistrationProxy(link);
    } else if (node.id === 'inventory-import-file') {
      const file = node.files?.[0];
      const form = node.form || document.getElementById('inventory-import-form');
      const originalContent = document.getElementById('inventory-import-content')?.value;
      const readVersion = ++importFileReadVersion;
      if (file && file.size > 1024 * 1024)
        api.notify(localData ? '文件请小于 1MB' : '演示文件请小于 1MB');
      else if (file)
        void file
          .text()
          .then((text) => {
            const target = document.getElementById('inventory-import-content');
            if (
              readVersion !== importFileReadVersion ||
              document.getElementById('inventory-import-form') !== form ||
              !target ||
              target.value !== originalContent
            )
              return;
            target.value = text;
            saveDrafts();
          })
          .catch(() => {
            if (
              readVersion === importFileReadVersion &&
              document.getElementById('inventory-import-form') === form
            )
              api.setError('inventory-import-content', 'CSV 文件读取失败，请重新选择文件');
          });
    }
    saveDrafts();
    return true;
  }
  function previewRegistrationProxy(node) {
    const protocolControl = document.getElementById('inventory-proxy-protocol');
    const scheme = /^([a-z][a-z\d+.-]*):\/\//i.exec(node.value.trim())?.[1].toLowerCase();
    const protocol = scheme || protocolControl?.value || 'socks5';
    try {
      const values = node.value.trim() ? parseRegistrationProxy(node.value, protocol) : {};
      if (values.proxyProtocol && protocolControl) protocolControl.value = values.proxyProtocol;
      for (const [name, id] of [
        ['proxyHost', 'host'],
        ['proxyPort', 'port'],
        ['proxyUser', 'user'],
        ['proxyPassword', 'pass']
      ]) {
        const control = document.getElementById(`inventory-proxy-${id}`);
        if (control) control.value = values[name] || '';
      }
      api.setError(node.id, '');
    } catch (error) {
      api.setError(node.id, error.message);
    }
  }
  function onInput(node) {
    if (!node.id.startsWith('inventory-')) return false;
    if (node.id === 'inventory-list-query' || node.id === 'inventory-center-query') {
      const cursor = node.selectionStart;
      view().query = node.value;
      api.state.page = 1;
      api.render();
      const next = document.getElementById(node.id);
      next?.focus();
      next?.setSelectionRange(cursor, cursor);
    } else if (node.id === 'inventory-email') {
      const suggestion = document.getElementById('inventory-type-suggestion');
      if (suggestion) suggestion.textContent = mailboxSuggestion(node.value);
    } else if (node.id === 'inventory-phone') {
      const link = document.getElementById('inventory-phone-code-link');
      if (link) { const url = phoneCodeUrl(node.value); link.hidden = !url; link.href = url || '#'; }
    } else if (node.id === 'inventory-proxy-url') {
      previewRegistrationProxy(node);
    } else if (node.id === claudeHistoryContentId) {
      preparedClaudeHistory = null;
      claudeHistorySubmitButton().disabled = true;
      node.form.querySelector('#' + claudeHistoryKey + '-review').textContent = '';
    }
    saveDrafts();
    return true;
  }

  api.modules.inventory = {
    phoneValue,
    usageDetails,
    personalRegistrationButtons,
    accountLifecycleReady: () => accountLifecycleLoaded,
    accountSummary: id => accountSummaries.get(id),
    accountSummaryForEmail(email, product) {
      const type = accountTypeForProduct(product);
      const matched = readInventoryIndex().byIdentity.get(type)?.get(String(email || '').trim().toLowerCase());
      return matched ? accountSummaries.get(matched.id) : null;
    },
    usageReviewButton,
    usageReviewFor: (id) => usageReview.get(id),
    refreshOverview() {
      initialize();
      return localData ? readLocalInventory({ keepContent: localInventoryState === 'ready' }) : Promise.resolve(false);
    },
    overviewSummary() {
      if (!localData || localInventoryState !== 'ready') return null;
      const stocks = {};
      for (const type of ['google', 'relay', 'microsoft', ...stockTypes.map(([id]) => id)]) {
        const assets = (stockType(type) ? accounts : mailboxes)
          .filter(asset => asset.type === type && !asset.relayDeleted).map(normalize);
        const issues = { dead: 0, unlocking: 0, disabled: 0, frozen: 0, restricted: 0, review: 0 };
        for (const asset of assets) {
          if (asset.health === 'dead' || asset.health === 'unlocking') issues[asset.health]++;
          else if (type === 'relay' && asset.relayStatus === 'DISABLED') issues.disabled++;
          else if (asset.status === '冻结') issues.frozen++;
          else if (asset.status === '封控中') issues.restricted++;
          else if (asset.health !== 'normal' || asset.status !== '正常' || usageReview.has(asset.id)) issues.review++;
        }
        stocks[type] = {
          registered: assets.length,
          available: ['relay', 'microsoft'].includes(type) ? null : assets.filter(available).length,
          claimed: type === 'microsoft' ? null : assets.filter(asset => asset.inventoryState === 'claimed').length,
          issues
        };
      }
      return { stocks, pending: batches.reduce((count, batch) => count + batchCounts(batch).pending, 0) };
    },
    registrationTime,
    getAppleRelayState() {
      return structuredClone(appleRelayState);
    },
    getLocalInventoryState() {
      return localInventoryState;
    },
    saveAppleRelay(mutate, action) {
      return persistInventory(action, () => {
        if (mutate(appleRelayState) === false) return;
        return () => {};
      });
    },
    mailboxPlatformLabel,
    mailboxRegistrationAccount,
    mailboxRegistrationAccountCell,
    healthChangeTime,
    mailboxClaim,
    mailboxPlatformButton,
    registrationRecordsFor(assetId) {
      return registrationRecords
        .filter((record) => record.assetId === assetId)
        .map((record) => ({ ...record }));
    },
    hasMailboxHistory(assetId) {
      const asset = mailboxes.find((row) => row.id === assetId);
      return Boolean(
        asset?.importId ||
        asset?.usageLinks?.length ||
        batches.some((batch) => batch.items.some((item) => item.assetId === assetId)) ||
        registrationRecords.some((record) => record.assetId === assetId)
      );
    },
    getAppleIds() {
      initialize();
      return mailboxes.filter((asset) => asset.type === 'apple').map(normalize);
    },
    editAppleId(id = '') {
      initialize();
      assetEditor(id, 'apple');
    },
    showAppleId(id) {
      initialize();
      assetDetail(id);
    },
    importAppleIds() {
      initialize();
      importEditor('apple');
    },
    listAvailableAccounts(product = 'GPT') {
      initialize();
      const type = accountTypeForProduct(product);
      return accounts
        .filter((asset) => asset.type === type && available(asset))
        .map((asset) => ({ ...asset }));
    },
    listDeliverableAccounts(product = 'GPT') {
      initialize();
      const type = accountTypeForProduct(product);
      return accounts.filter((asset) => asset.type === type && availableForDelivery(asset));
    },
    canCommitAccountSale(accountId, { orderId, expectedVersion } = {}) {
      initialize();
      const account = accounts.find((asset) => asset.id === accountId);
      if (!account || !orderId)
        return { ok: false, error: '可用账号或订单编号缺失', message: '可用账号或订单编号缺失' };
      if (account.usageLinks.some((link) => link.kind === 'order-sale' && link.orderId === orderId))
        return { ok: true, account, reused: true };
      if (
        !availableForDelivery(account) ||
        (expectedVersion !== undefined && account.version !== Number(expectedVersion))
      )
        return {
          ok: false,
          error: '账号已使用、已占用或资料已变化，请重新搜索',
          message: '账号已使用、已占用或资料已变化，请重新搜索'
        };
      return { ok: true, account, version: account.version };
    },
    prepareAccountSale(accountId, { orderId, expectedVersion } = {}) {
      if (!localData || localInventoryState !== 'ready' || inventorySavePending)
        return { ok: false, message: '本机库存尚未就绪或仍在保存，请稍候重试' };
      const check = api.modules.inventory.canCommitAccountSale(accountId, {
        orderId,
        expectedVersion
      });
      if (!check.ok) return check;
      const action = 'inventory_order_sale';
      const version = localInventoryVersion;
      const before = inventoryDocument();
      if (check.reused) return { ok: true, version, data: before, action, reused: true };
      try {
        const result = consume(check.account, pendingClaim(check.account)?.item, {
          kind: 'order-sale',
          orderId,
          label: `成品交付订单 ${orderId}`
        });
        return result.ok ? { ok: true, version, data: inventoryDocument(), action } : result;
      } finally {
        applyInventoryDocument(before);
      }
    },
    applyCommittedInventory,
    refreshLocalInventory(options) {
      return localData ? readLocalInventory(options) : undefined;
    },
    commitAccountSale(accountId, { orderId, expectedVersion } = {}) {
      if (localData) return { ok: false, message: '本机订单与库存必须一起保存' };
      const check = api.modules.inventory.canCommitAccountSale(accountId, {
        orderId,
        expectedVersion
      });
      if (!check.ok || check.reused) return check;
      return consume(check.account, pendingClaim(check.account)?.item, {
        kind: 'order-sale',
        orderId,
        label: `成品交付订单 ${orderId}`
      });
    },
    reserveAccount(accountId, { taskId, purpose = '比特充值', actorId } = {}) {
      if (localData) return { ok: false, message: '本机库存未接入充值任务占用' };
      initialize();
      const account = accounts.find((asset) => asset.id === accountId);
      if (!account || !taskId) return { ok: false, message: '账号或任务编号缺失' };
      const existing = reservations.get(accountId);
      if (existing?.taskId === taskId) return { ok: true, account, claimId: existing.claimId };
      if (!available(account)) return { ok: false, message: '账号已领用、实际使用或暂不可用' };
      const actor = { ...currentActor(), id: actorId || currentActor().id };
      const batch = createBatch('account', [account], purpose, '充值任务占用', actor),
        item = batch.items[0];
      item.taskId = taskId;
      reservations.set(accountId, { taskId, claimId: item.id, outcome: 'reserved' });
      return { ok: true, account, claimId: item.id };
    },
    markAccountUsed(accountId, { taskId, orderId } = {}) {
      if (localData) return { ok: false, message: '本机库存未接入充值任务占用' };
      initialize();
      const account = accounts.find((asset) => asset.id === accountId),
        reservation = reservations.get(accountId);
      if (!account || !reservation || reservation.taskId !== taskId)
        return { ok: false, message: '任务与账号占用不匹配' };
      if (reservation.outcome === 'used') return { ok: true };
      const claim = claimById(reservation.claimId);
      const result = consume(account, claim?.item, {
        kind: 'recharge',
        taskId,
        orderId,
        label: '比特充值付款结果已确认'
      });
      if (result.ok) reservation.outcome = 'used';
      return result;
    },
    markAccountPaymentUnknown(accountId, { taskId } = {}) {
      if (localData) return { ok: false, message: '本机库存未接入充值任务占用' };
      initialize();
      const reservation = reservations.get(accountId);
      if (!reservation || reservation.taskId !== taskId || reservation.outcome === 'used')
        return { ok: false, message: '任务占用不匹配' };
      reservation.outcome = 'unknown';
      return { ok: true };
    },
    releaseAccount(accountId, { taskId, reason } = {}) {
      if (localData) return { ok: false, message: '本机库存未接入充值任务占用' };
      initialize();
      const asset = accounts.find((account) => account.id === accountId),
        reservation = reservations.get(accountId);
      if (!asset || !reservation || reservation.taskId !== taskId)
        return { ok: false, message: '任务占用不匹配' };
      if (
        !['confirmed-not-submitted', 'confirmed-failed-unpaid'].includes(reason) ||
        ['unknown', 'used'].includes(reservation.outcome) ||
        asset.inventoryState === 'used'
      )
        return {
          ok: false,
          message: '付款未知或已使用的账号不能释放；需明确未受理或失败未付款证据'
        };
      const found = claimById(reservation.claimId);
      if (found) {
        found.item.status = 'returned';
        found.item.reason = '任务确认未付款';
        found.item.returnedAt = inventoryNow();
      }
      reservations.delete(accountId);
      asset.inventoryState = 'available';
      asset.used = false;
      asset.claimId = '';
      asset.claimBatchId = '';
      log(asset, '释放未付款任务占用', taskId);
      return { ok: true };
    },
    availableAccounts(product = 'gpt') {
      initialize();
      return accounts.filter((asset) => asset.type === product && available(asset));
    },
    getAsset(id) {
      initialize();
      return assetById(id);
    },
    getBatches() {
      initialize();
      return batches.map((batch) => ({ ...batch, counts: batchCounts(batch) }));
    }
  };
  if (localData) initialize();
  const drawer = document.querySelector('#drawer');
  drawer?.addEventListener?.('close', () => {
    if (drawer.open || !locationSettingsReturn) return;
    const back = locationSettingsReturn;
    locationSettingsReturn = null;
    if (back.route !== api.state.route) return;
    if (back.from === 'asset') assetEditor(back.id, back.type);
    else importEditor(back.type);
  });

  window.IDDesignModules.push({
    id: 'inventory',
    matches(route) {
      return /^(mailboxes\/(google|microsoft)|accounts\/(gpt|claude|gemini|grok)|workspace\/(mail-submit|account-submit|mail-extract|account-extract|extractions(?:\/[^/]+)?))$/.test(
        route
      );
    },
    render() {
      initialize();
      const route = api.state.route;
      if (localData && localInventoryState !== 'ready') {
        const failed = localInventoryState === 'error';
        return (
          header('库存', '本机库存') +
          `<section class="panel">${empty(failed ? '本机库存读取失败' : '正在读取本机库存', failed ? '确认本机服务正常后重新读取。' : '请稍候。')}${failed ? `<div class="toolbar">${button('重新读取', 'inventory-reload', 'primary')}</div>` : ''}</section>`
        );
      }
      if (route.startsWith('mailboxes/') || route.startsWith('accounts/')) return inventoryPage();
      if (/^workspace\/(mail|account)-(submit|extract)$/.test(route))
        return extractionPage();
      if (route.startsWith('workspace/extractions/'))
        return batchPage(batches.find((batch) => batch.id === route.split('/')[2]));
      return centerPage();
    },
    onClick,
    onSubmit,
    onChange,
    onInput,
    preserveDraft: saveDrafts,
    afterRender() {
      const form = document.querySelector('form[data-inventory-draft]');
      const saved = form && api.state.drafts.get(form.dataset.inventoryDraft);
      if (saved)
        for (const [name, value] of Object.entries(saved)) {
          const control = form.elements.namedItem(name);
          if (control && control.type !== 'file' && control.type !== 'checkbox')
            control.value = value;
        }
    }
  });
})();
