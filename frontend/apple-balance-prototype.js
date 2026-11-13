/* Apple ID balance and order-linked return ledger. */
(() => {
  'use strict';
  const A = window.IDDesignAPI;
  if (!A) throw new Error('苹果 ID 余额需要共享设计运行时');
  const M = A.money;
  const E = A.esc;
  const S = A.state;
  const wallets = new Map();
  const savedWalletIds = new Set();
  const allocations = new Map();
  const movements = [];
  const refunds = new Map();
  const localData = window.IDLocalData;
  const domain = 'appleBalance';
  let localVersion = 0;
  let loadState = 'idle';
  let hasLoaded = false;
  let loading;
  let regionRead;
  let saving = false;
  const $ = (selector, root = document) => root.querySelector(selector);
  const actor = () =>
    localData ? localData.actor?.()?.name || '本机操作员' : S.actor?.name || '林管理员';
  const newId = (prefix) => (localData ? `${prefix}-${crypto.randomUUID()}` : A.newId(prefix));
  const now = () =>
    localData
      ? new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ')
      : A.nowText();
  const fail = (error) => ({ ok: false, error, message: error });
  const canonical = (amount) => M.formatUnits(M.units(String(amount)), 4);
  const valid = (amount) => /^\d{1,16}(?:\.\d{1,4})?$/.test(String(amount));
  const exceedsBalanceLimit = (amount) => M.compare(amount, '9999999999999999.9999') > 0;
  const shown = (amount) => canonical(amount).replace(/(\.\d{2})0+$/, '$1');
  const copy = (value) => (value ? JSON.parse(JSON.stringify(value)) : value);
  const net = (allocation) => M.subtract(allocation.amount, allocation.returned);
  const managementRoute = 'subscriptions/apple-ids';
  const isBalanceRoute = () => ['accounts/apple-balances', 'mailboxes/apple', managementRoute].includes(S.route);
  const ready = () => !localData || loadState === 'ready';
  const pendingTotal = (orderId, exceptId) =>
    [...refunds.values()].reduce(
      (sum, item) =>
        item.id !== exceptId && item.orderId === orderId && item.status === 'pending'
          ? M.add(sum, item.amount)
          : sum,
      '0.0000'
    );

  function balanceDocument() {
    return copy({
      wallets: [...wallets.values()].filter(wallet => wallet.version > 1 || savedWalletIds.has(wallet.id)),
      allocations: [...allocations.values()],
      movements,
      refunds: [...refunds.values()]
    });
  }
  function replaceDocument(data) {
    savedWalletIds.clear();
    for (const wallet of data?.wallets || []) savedWalletIds.add(wallet.id);
    for (const [target, records, key] of [
      [wallets, data?.wallets, 'id'],
      [allocations, data?.allocations, 'orderId'],
      [refunds, data?.refunds, 'id']
    ]) {
      target.clear();
      for (const record of records || []) target.set(record[key], record);
    }
    movements.splice(0, movements.length, ...(data?.movements || []));
  }
  function applyCommittedBalance({ version, data }) {
    if (version >= localVersion) {
      localVersion = version;
      replaceDocument(data);
    }
    loadState = 'ready';
    hasLoaded = true;
  }
  function bindBalanceRead() {
    const region = $('#main [data-apple-balance-region]');
    if (!region || regionRead?.region === region) return;
    regionRead?.finish();
    regionRead = A.beginRegionRead(region, region.querySelector('[data-apple-balance-progress]'), {
      refreshButton: region.querySelector('[data-action="apple-reload"]')
    });
  }
  function refreshLocalBalance() {
    if (!localData) return Promise.resolve(true);
    if (loading) return loading;
    loadState = 'loading';
    loading = (async () => {
      try {
        applyCommittedBalance(await localData.load(domain));
        return true;
      } catch {
        loadState = 'error';
        return false;
      } finally {
        regionRead?.finish();
        regionRead = undefined;
        loading = undefined;
        updateLinkedAccounts();
        if (isBalanceRoute()) {
          const feedback = $('#main [data-apple-balance-error]');
          if (loadState === 'error' && feedback) feedback.hidden = false;
          else A.render();
        }
      }
    })();
    if (isBalanceRoute()) bindBalanceRead();
    return loading;
  }
  function ensureReady() {
    return ready() ? Promise.resolve(true) : refreshLocalBalance();
  }
  function stage(action, mutate) {
    if (!localData || !ready() || saving) return fail('苹果 ID 余额尚未就绪或仍在保存，请重新核对');
    const before = balanceDocument();
    try {
      const result = mutate();
      if (!result.ok) return result;
      const data = balanceDocument();
      const changed = JSON.stringify(data) !== JSON.stringify(before);
      const version = localVersion;
      return {
        ...result,
        changed,
        data,
        version,
        action,
        entry: changed ? { domain, version, data, action } : null,
        apply: applyCommittedBalance,
        reload: refreshLocalBalance
      };
    } finally {
      replaceDocument(before);
    }
  }
  async function saveLocal(action, mutate) {
    const prepared = stage(action, mutate);
    if (!prepared.ok || !prepared.changed) return prepared;
    saving = true;
    try {
      applyCommittedBalance(
        await localData.save(domain, prepared.version, prepared.data, { action })
      );
      return prepared;
    } catch (error) {
      const read = await refreshLocalBalance();
      if (!read) return fail('无法核对保存结果，请重新读取余额与流水');
      if (action === 'apple_topup') {
        const sent = prepared.data.movements.at(-1);
        const saved = movements.find(row => row.id === sent.id && row.appleIdId === sent.appleIdId &&
          row.kind === 'topup' && row.amount === sent.amount && row.reason === sent.reason);
        if (saved) return prepared;
      }
      return fail(
        error?.status === 409 && localVersion !== prepared.version
          ? '余额或回款记录已在其他页面更新，请重新打开并核对'
          : error?.status === 409
            ? error.message
            : '请检查余额流水后再重试，避免重复登记'
      );
    } finally {
      saving = false;
    }
  }

  function syncWallets() {
    for (const asset of A.modules.inventory.getAppleIds()) {
      if (!wallets.has(asset.id)) {
        const initial = !localData && asset.id === 'apple-funding-demo-1' ? '250.0000' : '0.0000';
        wallets.set(asset.id, { id: asset.id, balance: initial, currency: 'USD', version: 1 });
        if (M.compare(initial, '0') > 0)
          movements.push({
            id: newId('APPLE-OPEN'),
            appleIdId: asset.id,
            kind: 'opening',
            label: '演示期初余额',
            amount: initial,
            before: '0.0000',
            after: initial,
            versionAfter: 1,
            reason: '虚构演示资料，不对应历史订单或真实余额',
            orderId: '',
            orderNo: '',
            actor: '演示初始化',
            at: A.nowText()
          });
      }
    }
  }
  function rawWallet(id) {
    syncWallets();
    return wallets.get(id);
  }
  function get(id) {
    const wallet = rawWallet(id);
    const asset = A.modules.inventory.getAppleIds().find((row) => row.id === id);
    return wallet && asset
      ? {
          ...wallet,
          email: asset.email,
          status: asset.status,
          health: asset.health,
          country: asset.country, appStoreRegion: asset.appStoreRegion, deleted: asset.deleted
        }
      : null;
  }
  function list() {
    syncWallets();
    return A.modules.inventory.getAppleIds().map((asset) => ({
      ...wallets.get(asset.id),
      email: asset.email,
      status: asset.status,
      health: asset.health,
      country: asset.country, appStoreRegion: asset.appStoreRegion, deleted: asset.deleted
    }));
  }
  function pushMovement(id, signedAmount, detail) {
    const wallet = wallets.get(id);
    const before = wallet.balance;
    wallet.balance = M.add(before, signedAmount);
    wallet.version++;
    const movement = {
      id: newId('APPLE-MOVE'),
      appleIdId: id,
      amount: canonical(signedAmount),
      before,
      after: wallet.balance,
      versionAfter: wallet.version,
      actor: actor(),
      at: now(),
      ...detail
    };
    movements.push(movement);
    return movement;
  }
  function previewOrder(order, options = {}) {
    if (!ready()) return fail('苹果 ID 余额尚未读取，请重试');
    syncWallets();
    const id = String(order.id || '');
    const prior = allocations.get(id);
    const desired = order.payment === '苹果内购' && Boolean(order.paidConfirmed);
    const changes = [];
    let next = prior ? { ...prior } : null;
    const reason = String(options.reason || '').trim();
    const reversalAllowed = options.allowReversal === true && Boolean(reason);
    if (prior && order.payment === '苹果内购' && !order.paidConfirmed)
      return fail('本单已扣减苹果 ID 余额，取消代付确认不能抹掉扣款；请先核对更正。');
    if (desired) {
      const targetId = String(order.appleIdId || '');
      const target = get(targetId);
      if (!target) return fail('请选择可用的苹果 ID 余额账户');
      if (order.paidCurrency !== 'USD')
        return fail('苹果 ID 余额按 USD · 美元登记，请使用美元代付金额');
      if (!valid(order.paidAmount) || M.compare(order.paidAmount, '0') <= 0)
        return fail('请填写大于零的苹果内购代付金额');
      const amount = canonical(order.paidAmount);
      if (prior && prior.appleIdId !== targetId) {
        if (!reversalAllowed) return fail('更换付款 Apple ID 前，请核对原 ID 应加回的金额，确认加回余额并填写原因');
        if (M.compare(M.add(prior.returned, pendingTotal(id)), '0') > 0)
          return fail('原扣款已有待回款或实际回款，不能更换苹果 ID');
        changes.push({
          appleIdId: prior.appleIdId,
          amount: net(prior),
          kind: 'order-reversal',
          label: '更换支付资料冲正'
        });
        changes.push({
          appleIdId: targetId,
          amount: M.subtract('0', amount),
          kind: 'order-charge',
          label: '订单订阅扣减'
        });
        next = {
          appleIdId: targetId,
          amount,
          returned: '0.0000',
          openingIncluded: false,
          version: prior.version + 1
        };
      } else {
        const priorAmount = prior?.amount || '0.0000';
        const difference = M.subtract(amount, priorAmount);
        if (M.compare(difference, '0') < 0 && !reversalAllowed)
          return fail('减少代付金额前，请核对原 Apple ID 应加回的金额，确认加回余额并填写原因');
        if (prior && M.compare(amount, M.add(prior.returned, pendingTotal(id))) < 0)
          return fail('更正后的代付金额不能低于已回款和待回款合计');
        if (M.compare(difference, '0') !== 0)
          changes.push({
            appleIdId: targetId,
            amount: M.subtract('0', difference),
            kind: M.compare(difference, '0') > 0 ? 'order-charge' : 'order-reversal',
            label: M.compare(difference, '0') > 0 ? '订单订阅扣减' : '订单更正冲正'
          });
        next = {
          appleIdId: targetId,
          amount,
          returned: prior?.returned || '0.0000',
          openingIncluded: prior?.openingIncluded || false,
          version: (prior?.version || 0) + (changes.length ? 1 : 0)
        };
      }
      next.orderId = id;
      next.orderNo = order.orderNo || id;
      next.email = order.email || '';
    } else if (prior) {
      if (!reversalAllowed)
        return fail('更换付款方式前，请核对原 Apple ID 应加回的金额，确认加回余额并填写原因。撤单会保留原扣款。');
      if (localData && M.compare(M.add(prior.returned, pendingTotal(id)), '0') > 0)
        return fail('原扣款已有待回款或实际回款，不能更换支付方式');
      const remaining = net(prior);
      if (M.compare(remaining, '0') > 0)
        changes.push({
          appleIdId: prior.appleIdId,
          amount: remaining,
          kind: 'order-reversal',
          label: '支付方式更正冲正'
        });
      next = null;
    }
    const updated = new Map();
    for (const change of changes) {
      const wallet = wallets.get(change.appleIdId);
      if (!wallet) return fail('原苹果 ID 余额账户缺失，请保留记录并核对');
      const asset = get(wallet.id);
      if (
        M.compare(change.amount, '0') < 0 &&
        (asset?.status !== '正常' || asset.health !== 'normal')
      )
        return fail('该苹果 ID 已停用或异常，不能登记新的订阅扣款');
      const balance = M.add(updated.get(wallet.id) || wallet.balance, change.amount);
      if (M.compare(balance, '0') < 0)
        return fail(
          `苹果 ID 余额不足，${asset?.email || wallet.id} 当前为 ${shown(wallet.balance)} USD · 美元`
        );
      if (exceedsBalanceLimit(balance)) return fail('变动后余额超出可登记范围');
      updated.set(wallet.id, balance);
    }
    const selected = desired ? get(order.appleIdId) : prior ? get(prior.appleIdId) : null;
    const affected = [...new Set(changes.map((change) => change.appleIdId))];
    const key = JSON.stringify({
      id,
      payment: order.payment,
      paidConfirmed: Boolean(order.paidConfirmed),
      target: order.appleIdId || '',
      amount: order.paidAmount || '',
      prior: prior || null,
      versions: affected.map((walletId) => [walletId, wallets.get(walletId).version]),
      changes
    });
    return {
      ok: true,
      key,
      version: selected?.version || 0,
      appleIdId: selected?.id || '',
      balanceBefore: selected?.balance || '0.0000',
      balanceAfter: selected ? updated.get(selected.id) || selected.balance : '0.0000',
      delta: selected
        ? M.subtract(updated.get(selected.id) || selected.balance, selected.balance)
        : '0.0000',
      changes,
      next
    };
  }
  function commitOrder(order, options = {}) {
    if (!order.id) return fail('订单必须先分配稳定编号再登记余额');
    const plan = previewOrder(order, options);
    if (!plan.ok) return plan;
    if (options.expectedPreview && options.expectedPreview.key !== plan.key)
      return fail('确认期间苹果 ID 余额或订单台账已变化，请重新核对');
    for (const change of plan.changes)
      pushMovement(change.appleIdId, change.amount, {
        kind: change.kind,
        label: change.label,
        reason: String(options.reason || '订单代付已确认'),
        orderId: order.id,
        orderNo: order.orderNo || order.id,
        email: order.email || ''
      });
    if (plan.next) allocations.set(order.id, plan.next);
    else allocations.delete(order.id);
    return { ...plan, reused: plan.changes.length === 0 };
  }
  function registerOpeningOrder(order) {
    if (localData) return fail('本机账本需登记实际余额和付款流水');
    const wallet = get(order.appleIdId);
    if (
      !order.id ||
      order.payment !== '苹果内购' ||
      !order.paidConfirmed ||
      order.paidCurrency !== 'USD' ||
      !wallet ||
      !valid(order.paidAmount) ||
      M.compare(order.paidAmount, '0') <= 0
    )
      return fail('期初关联仅接受已确认、美元计价且明确指定苹果 ID 的历史订阅');
    const prior = allocations.get(order.id);
    const amount = canonical(order.paidAmount);
    if (prior)
      return prior.appleIdId === order.appleIdId && prior.amount === amount
        ? { ok: true, reused: true }
        : fail('本单已有余额台账，不能以期初关联覆盖后续记录');
    const allocation = {
      appleIdId: order.appleIdId,
      orderId: order.id,
      orderNo: order.orderNo || order.id,
      email: order.email || '',
      amount,
      returned: '0.0000',
      version: 1,
      openingIncluded: true
    };
    allocations.set(order.id, allocation);
    pushMovement(order.appleIdId, '0', {
      kind: 'opening-order',
      label: '期初已扣订阅对账',
      reason: `演示期初余额已包含此历史订阅 ${shown(amount)} USD，不重复扣款；退回需另行核实 Apple 到账。`,
      orderId: order.id,
      orderNo: allocation.orderNo,
      email: allocation.email,
      registeredAmount: amount
    });
    return { ok: true, balance: wallets.get(order.appleIdId).balance };
  }
  function refundToApple(orderId, amount, options = {}) {
    const allocation = allocations.get(orderId);
    if (!allocation) return fail('本单没有余额扣款记录，不能凭历史订单增加苹果 ID 余额');
    if (!valid(amount) || M.compare(amount, '0') <= 0 || M.compare(amount, net(allocation)) > 0)
      return fail('Apple 退回金额必须大于零，且不得超过本单剩余净扣款');
    const reason = String(options.reason || '').trim();
    if (!reason) return fail('请填写 Apple 已实际退回余额的依据或备注');
    if (
      options.expectedVersion !== undefined &&
      Number(options.expectedVersion) !== allocation.version
    )
      return fail('原订单余额记录已变化，请重新核对');
    const wallet = get(allocation.appleIdId) ? wallets.get(allocation.appleIdId) : null;
    if (!wallet) return fail('原苹果 ID 资料缺失，请保留原始余额记录并核对');
    if (
      options.expectedWalletVersion !== undefined &&
      Number(options.expectedWalletVersion) !== wallet.version
    )
      return fail('苹果 ID 余额已变化，请重新核对');
    if (exceedsBalanceLimit(M.add(wallet.balance, amount))) return fail('回款后余额超出可登记范围');
    pushMovement(wallet.id, amount, {
      kind: 'apple-refund',
      label: 'Apple 确认退回',
      reason,
      orderId,
      orderNo: allocation.orderNo,
      email: allocation.email,
      ...(options.refundId ? { refundId: options.refundId } : {})
    });
    allocation.returned = M.add(allocation.returned, amount);
    allocation.version++;
    return { ok: true, balance: wallet.balance, remaining: net(allocation) };
  }
  function getOrderLedger(orderId) {
    const allocation = allocations.get(orderId);
    return allocation ? { ...copy(allocation), netAmount: net(allocation) } : null;
  }
  function prepareOrder(order, options) {
    return stage('apple_order_charge', () => {
      const result = commitOrder(order, options);
      if (!result.ok) return result;
      const allocation = getOrderLedger(order.id);
      const walletVersion = get(order.appleIdId)?.version || null;
      return {
        ...result,
        allocation,
        walletVersion,
        ledgerAfter: allocation,
        walletVersionAfter: walletVersion
      };
    });
  }
  function listRefunds(orderId) {
    return [...refunds.values()].filter((item) => !orderId || item.orderId === orderId).map(copy);
  }
  function prepareRefund(order, { refundId, amount }) {
    return stage('apple_refund_schedule', () => {
      const id = String(refundId || '');
      if (!id || !order?.id || order.payment !== '苹果内购' || !valid(amount))
        return fail('请选择苹果内购订单并填写有效回款金额');
      const wallet = get(order.appleIdId);
      if (!wallet) return fail('原付款苹果 ID 资料缺失，请核对原订单');
      const balanceReturn = canonical(amount);
      const prior = refunds.get(id);
      if (prior)
        return prior.orderId === order.id &&
          prior.appleIdId === wallet.id &&
          prior.amount === balanceReturn
          ? { ok: true, refund: copy(prior), reused: true }
          : fail('此退款已关联另一笔回款，请重新核对');
      const positive = M.compare(balanceReturn, '0') > 0;
      const allocation = allocations.get(order.id);
      if (positive && (!allocation || allocation.appleIdId !== wallet.id))
        return fail('本单没有已确认的苹果 ID 扣款，请核对订单');
      if (positive && M.compare(M.add(pendingTotal(order.id), balanceReturn), net(allocation)) > 0)
        return fail('本次回款和已登记待回款的合计超出原订单剩余净扣款');
      const refund = {
        id,
        orderId: order.id,
        orderNo: order.orderNo || order.id,
        appleIdId: wallet.id,
        appleEmail: wallet.email,
        amount: balanceReturn,
        status: positive ? 'pending' : 'none',
        version: 1,
        createdAt: now(),
        actor: actor(),
        corrections: []
      };
      refunds.set(id, refund);
      return { ok: true, refund: copy(refund) };
    });
  }
  function verifyPendingRefund(id, { version, ledgerVersion, walletVersion }) {
    const refund = refunds.get(id);
    if (!refund) return fail('回款记录不存在，请重新核对');
    if (refund.status !== 'pending') return fail('本笔回款已处理，请查看当前记录');
    const allocation = allocations.get(refund.orderId);
    const wallet = get(refund.appleIdId);
    if (
      !allocation ||
      allocation.appleIdId !== refund.appleIdId ||
      !wallet ||
      refund.version !== Number(version) ||
      allocation.version !== Number(ledgerVersion) ||
      wallet.version !== Number(walletVersion)
    )
      return fail('回款记录、订单扣款或余额已变化，请重新打开核对');
    return { ok: true, refund, allocation };
  }
  function correctRefund(id, amount, options) {
    return saveLocal('apple_refund_correct', () => {
      const check = verifyPendingRefund(id, options);
      if (!check.ok) return check;
      const { refund, allocation } = check;
      const reason = String(options.reason || '').trim();
      if (!valid(amount) || !reason) return fail('请填写有效金额与更正原因');
      const next = canonical(amount);
      if (next === refund.amount) return fail('更正金额与原登记金额相同');
      if (M.compare(M.add(pendingTotal(refund.orderId, id), next), net(allocation)) > 0)
        return fail('更正后的回款和其他待回款合计超过本单剩余净扣款');
      refund.corrections.push({ from: refund.amount, to: next, reason, actor: actor(), at: now() });
      refund.amount = next;
      refund.status = M.compare(next, '0') > 0 ? 'pending' : 'none';
      refund.version++;
      return { ok: true, refund: copy(refund) };
    });
  }
  function receiveRefund(id, options) {
    return saveLocal('apple_refund_receive', () => {
      if (options.confirmed !== true) return fail('请确认 Apple 余额已实际到账');
      const check = verifyPendingRefund(id, options);
      if (!check.ok) return check;
      const { refund, allocation } = check;
      if (M.compare(pendingTotal(refund.orderId), net(allocation)) > 0)
        return fail('待回款金额超过原订单剩余净扣款，请先核对');
      const result = refundToApple(refund.orderId, refund.amount, {
        reason: options.reason,
        expectedVersion: options.ledgerVersion,
        expectedWalletVersion: options.walletVersion,
        refundId: id
      });
      if (!result.ok) return result;
      refund.status = 'received';
      refund.receivedAt = now();
      refund.receivedBy = actor();
      refund.receiptNote = String(options.reason).trim();
      refund.version++;
      return { ...result, refund: copy(refund) };
    });
  }
  function entries(id) {
    syncWallets();
    return movements
      .filter((entry) => !id || entry.appleIdId === id)
      .map(copy)
      .reverse();
  }
  function adjust(id, amount, options = {}) {
    const wallet = get(id) ? wallets.get(id) : null;
    if (!wallet) return fail('苹果 ID 余额账户不存在');
    if (!/^-?\d{1,16}(?:\.\d{1,4})?$/.test(String(amount)) || M.compare(amount, '0') === 0)
      return fail('请输入有效的非零余额变动');
    const reason = String(options.reason || '').trim();
    if (!options.topup && !reason) return fail('请填写余额变动原因');
    if (options.topup) {
      if (M.compare(amount, '0') <= 0 || !/^[a-zA-Z0-9-]{1,100}$/.test(options.commandId || ''))
        return fail('请核对充值金额后重新打开操作');
      const existing = movements.find(row => row.id === 'APPLE-TOPUP-' + options.commandId);
      if (existing) return existing.kind === 'topup' && existing.appleIdId === id &&
        M.compare(existing.amount, amount) === 0 && String(existing.reason || '').trim() === reason
        ? { ok: true, entry: copy(existing), balance: wallet.balance }
        : fail('相同充值操作已登记，请重新核对');
    }
    if (options.expectedVersion !== undefined && wallet.version !== Number(options.expectedVersion))
      return fail('余额已经变化，请重新核对');
    const nextBalance = M.add(wallet.balance, amount);
    if (M.compare(nextBalance, '0') < 0) return fail('余额不足，不能记为负数');
    if (exceedsBalanceLimit(nextBalance)) return fail('变动后余额超出可登记范围');
    const entry = pushMovement(id, amount, {
      ...(options.topup && { id: 'APPLE-TOPUP-' + options.commandId }),
      kind: options.topup ? 'topup' : 'manual',
      label: options.topup ? '充值到账' : M.compare(amount, '0') > 0 ? '人工余额入账' : '人工余额更正',
      reason,
      orderId: '',
      orderNo: ''
    });
    return { ok: true, entry: copy(entry), balance: wallet.balance };
  }
  function undoAdjustment(entryId, reason) {
    const entry = movements.find((row) => row.id === entryId);
    if (!entry || !['manual', 'topup'].includes(entry.kind) || entry.undoneBy)
      return fail('仅能撤回尚未撤回的人工余额变动');
    const wallet = get(entry.appleIdId) ? wallets.get(entry.appleIdId) : null;
    if (!wallet) return fail('原苹果 ID 资料缺失，不能自动补偿余额');
    if (wallet.version !== entry.versionAfter)
      return fail('此后已有余额变动，不能覆盖后续记录；请登记新的更正');
    const signed = M.subtract('0', entry.amount);
    if (M.compare(M.add(wallet.balance, signed), '0') < 0) return fail('撤回后余额不足');
    if (!String(reason || '').trim()) return fail('请填写撤回原因');
    const compensation = pushMovement(wallet.id, signed, {
      kind: 'manual-undo',
      label: '人工变动补偿撤回',
      reason,
      orderId: '',
      orderNo: '',
      originalEntryId: entry.id
    });
    entry.undoneBy = compensation.id;
    return { ok: true, balance: wallet.balance };
  }
  function saveAdjustment(id, amount, options) {
    return saveLocal(options.topup ? 'apple_topup' : 'apple_adjust', () => adjust(id, amount, options));
  }
  function saveAdjustmentUndo(id, reason) {
    return saveLocal('apple_adjust_undo', () => undoAdjustment(id, reason));
  }
  function property(name, value) {
    return `<div class="property-row"><span>${E(name)}</span><strong>${E(value || '—')}</strong></div>`;
  }
  function fundingTable(columns, rows, name) {
    if (!rows.length) return A.empty('暂无符合条件的记录', '可调整搜索或筛选条件。');
    return `<table class="apple-funding-table" aria-label="${E(name)}"><thead><tr>${columns.map(column =>
      `<th scope="col"${column.action ? ' class="table-actions"' : ''}>${E(column.label)}</th>`).join('')}</tr></thead><tbody>${rows.map(row =>
      `<tr>${columns.map(column => `<td${column.action ? ' class="table-actions"' : ''}><span class="apple-cell-label" aria-hidden="true">${E(column.label)}</span><div>${
        column.render ? column.render(row) : E(row[column.id] || '—')}</div></td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }
  function openLedger(id) {
    if (!ready()) {
      void ensureReady().then((ok) => {
        if (ok) openLedger(id);
        else A.notify('苹果 ID 余额读取失败，请重试');
      });
      return;
    }
    const wallet = get(id);
    if (!wallet) return;
    const rows = entries(id);
    const columns = [
      { id: 'at', label: '变动时间' },
      { id: 'label', label: '变动类型' },
      {
        id: 'amount',
        label: '变动（USD · 美元）',
        render: (row) => E(`${M.compare(row.amount, '0') > 0 ? '+' : ''}${shown(row.amount)}`)
      },
      { id: 'before', label: '变动前余额', render: (row) => E(shown(row.before)) },
      { id: 'after', label: '变动后余额', render: (row) => E(shown(row.after)) },
      { id: 'orderNo', label: '对应订单' },
      { id: 'actor', label: '登记人' },
      { id: 'reason', label: '原因或依据' },
      {
        id: 'actions',
        label: '操作',
        action: true,
        render: (row) =>
          ['manual', 'topup'].includes(row.kind) && !row.undoneBy
            ? A.textAction('补偿撤回', 'apple-undo', `data-id="${E(row.id)}"`)
            : row.undoneBy
              ? A.tag('已补偿撤回')
              : '—'
      }
    ];
    const hasRefunds = localData
      ? [...refunds.values()].some((refund) => refund.appleIdId === id)
      : [...allocations.values()].some(
          (allocation) => allocation.appleIdId === id && M.compare(net(allocation), '0') > 0
        );
    A.openDrawer(
      '苹果 ID 余额变动',
      localData
        ? '付款确认后登记扣减，回款到账后登记增加余额。'
        : '演示余额随付款、Apple 实际退回和补偿撤回变化。',
      `<div class="property-list">${property('苹果 ID', wallet.email)}${property('当前余额', `${shown(wallet.balance)} USD · 美元`)}</div><div class="toolbar"><div class="toolbar-right">${A.button(localData ? '登记余额变动' : '充值或更正', 'apple-adjust', '', 'plus', `data-id="${E(id)}"`)}${hasRefunds ? A.button(localData ? '查看 Apple 回款' : '确认 Apple 退回', 'apple-return-select', '', 'return', `data-id="${E(id)}"`) : ''}</div></div>${fundingTable(columns, rows, '苹果 ID 余额变动')}`,
      A.button('关闭', 'drawer-close'), '', { kind: 'apple-ledger' }
    );
  }
  function adjustmentEditor(id, topup = false) {
    const wallet = get(id);
    if (!wallet) return;
    const key = `apple-${topup ? 'topup' : 'adjust'}:${id}`,
      d = S.drafts.get(key) || {};
    A.openDrawer(
      topup ? '登记苹果 ID 充值' : '登记余额变动',
      topup ? '请在 Apple 端完成充值并核实到账，再登记本次增加的美元余额。' :
        localData ? '核对账户余额和实际变动后登记。' : '此处记录演示余额变动。',
      `<div class="property-list">${property('苹果 ID', wallet.email)}${property('当前余额', `${shown(wallet.balance)} USD · 美元`)}</div><form id="apple-adjust-form" data-apple-draft="${E(key)}" novalidate><input type="hidden" name="apple-id" value="${E(id)}" /><input type="hidden" name="apple-version" value="${E(d['apple-version'] ?? wallet.version)}" /><div class="form-grid">${topup ?
        `<input type="hidden" name="apple-topup" value="1" /><input type="hidden" name="apple-command" value="${E(d['apple-command'] || newId('TOPUP'))}" />` : A.field(
        '变动方向',
        'apple-direction',
        A.select(
          'apple-direction',
          [
            ['credit', '增加余额'],
            ['debit', '减少余额']
          ],
          d['apple-direction'] || 'credit'
        ),
        true
      )}${A.field('金额（美元）', 'apple-amount', A.input('apple-amount', d['apple-amount'] || '', 'inputmode="decimal"'), true)}${A.field(topup ? '到账依据' : '变动原因', 'apple-reason', `<textarea id="apple-reason" name="apple-reason" rows="3">${E(d['apple-reason'] || '')}</textarea>`, !topup).replace('class="field"', 'class="field form-field-wide"')}</div></form>`,
      A.button('取消', 'drawer-close') +
        '<button class="button primary" type="submit" form="apple-adjust-form">核对变动</button>',
      key
    );
  }
  function openOrderRefund(orderId) {
    if (localData) {
      if (!ready()) {
        void ensureReady().then((ok) => {
          if (ok) openOrderRefund(orderId);
          else A.notify('苹果 ID 回款读取失败，请重试');
        });
        return;
      }
      openRefundList(listRefunds(orderId));
      return;
    }
    const allocation = getOrderLedger(orderId);
    if (!allocation || M.compare(allocation.netAmount, '0') <= 0) {
      A.notify('本单没有可确认退回的苹果 ID 净扣款');
      return;
    }
    const wallet = get(allocation.appleIdId),
      key = `apple-return:${orderId}`,
      d = S.drafts.get(key) || {};
    A.openDrawer(
      '确认 Apple 余额退回',
      '仅在 Apple 已实际退回账户余额后登记；客户退款不会自动增加本余额，也不请求外部退款。',
      `<div class="property-list">${property('苹果 ID', wallet.email)}${property('订单编号', allocation.orderNo)}${property('客户账号', allocation.email)}${property('扣款来源', allocation.openingIncluded ? '演示期初已计的历史订阅' : '本期订单确认扣款')}${property('最多退回', `${shown(allocation.netAmount)} USD · 美元`)}</div><form id="apple-return-form" data-apple-draft="${E(key)}" novalidate><input type="hidden" name="apple-order-id" value="${E(orderId)}" /><input type="hidden" name="apple-ledger-version" value="${E(d['apple-ledger-version'] ?? allocation.version)}" /><input type="hidden" name="apple-wallet-version" value="${E(d['apple-wallet-version'] ?? wallet.version)}" /><div class="form-grid">${A.field('退回金额（美元）', 'apple-return-amount', A.input('apple-return-amount', d['apple-return-amount'] || '', 'inputmode="decimal"'), true)}${A.field('已实际退回', 'apple-return-confirmed', `<label class="checkbox-label"><input type="checkbox" id="apple-return-confirmed" name="apple-return-confirmed" ${d['apple-return-confirmed'] ? 'checked' : ''} />已核对 Apple 余额到账</label>`, true)}${A.field('到账依据或备注', 'apple-return-reason', `<textarea id="apple-return-reason" name="apple-return-reason" rows="3">${E(d['apple-return-reason'] || '')}</textarea>`, true).replace('class="field"', 'class="field form-field-wide"')}</div></form>`,
      A.button('取消', 'drawer-close') +
        '<button class="button primary" type="submit" form="apple-return-form">核对实际退回</button>',
      key
    );
  }
  function openRefundList(rows) {
    A.openDrawer(
      'Apple 回款记录',
      '确认前可更正待回款金额，实际到账按登记金额记入原付款苹果 ID。',
      A.table(
        [
          { id: 'orderNo', label: '订单编号' },
          {
            id: 'appleIdId',
            label: '原付款苹果 ID',
            render: (row) => E(row.appleEmail || get(row.appleIdId)?.email || row.appleIdId)
          },
          {
            id: 'amount',
            label: '回款金额（美元）',
            render: (row) => E(shown(row.amount))
          },
          {
            id: 'status',
            label: '回款状态',
            render: (row) =>
              A.tag(
                { pending: '待回款', received: '已回款', none: '无需回款' }[row.status],
                row.status === 'received' ? 'success' : row.status === 'pending' ? 'warning' : ''
              )
          },
          { id: 'receivedAt', label: '到账时间' },
          {
            id: 'actions',
            label: '操作',
            action: true,
            render: (row) =>
              `<div class="action-links">${row.status === 'pending' ? A.textAction('更正金额', 'apple-pending-edit', `data-id="${E(row.id)}"`) + A.textAction('确认到账', 'apple-pending-receive', `data-id="${E(row.id)}"`) : ''}${row.corrections.length ? A.textAction('更正记录', 'apple-refund-history', `data-id="${E(row.id)}"`) : ''}</div>`
          }
        ],
        window.IDListOrder.sortByRecordTime(rows, row => [row.receivedAt, row.createdAt]),
        '',
        'Apple回款记录'
      ),
      A.button('关闭', 'drawer-close')
    );
  }
  function pendingRefundEditor(id, isCorrection) {
    const refund = refunds.get(id);
    const allocation = refund && getOrderLedger(refund.orderId);
    const wallet = refund && get(refund.appleIdId);
    if (!refund || refund.status !== 'pending' || !allocation || !wallet) {
      A.notify('待回款记录已变化，请重新核对');
      return;
    }
    const key = `apple-pending:${isCorrection ? 'edit' : 'receive'}:${id}`;
    const draft = S.drafts.get(key) || {};
    const title = isCorrection ? '更正 Apple 待回款' : '确认 Apple 回款到账';
    const fields = isCorrection
      ? A.field(
          '更正后金额（美元）',
          'apple-pending-amount',
          A.input(
            'apple-pending-amount',
            draft['apple-pending-amount'] ?? shown(refund.amount),
            'inputmode="decimal"'
          ),
          true
        )
      : A.field(
          '到账确认',
          'apple-pending-confirmed',
          `<label class="checkbox-label"><input type="checkbox" id="apple-pending-confirmed" name="apple-pending-confirmed" ${draft['apple-pending-confirmed'] ? 'checked' : ''} />已核对 Apple 余额到账</label>`,
          true
        );
    A.openDrawer(
      title,
      isCorrection
        ? '保留更正前的金额和原因。填写 0 表示无需回款。'
        : '按已登记金额入账。实际金额有差异时请先更正。',
      `<div class="property-list">${property('订单编号', refund.orderNo)}${property('原付款苹果 ID', wallet.email)}${property('已登记回款', `${shown(refund.amount)} USD · 美元`)}</div><form id="apple-pending-form" data-apple-draft="${E(key)}" novalidate><input type="hidden" name="apple-pending-id" value="${E(id)}" /><input type="hidden" name="apple-pending-action" value="${isCorrection ? 'edit' : 'receive'}" /><input type="hidden" name="apple-pending-version" value="${E(draft['apple-pending-version'] ?? refund.version)}" /><input type="hidden" name="apple-pending-ledger-version" value="${E(draft['apple-pending-ledger-version'] ?? allocation.version)}" /><input type="hidden" name="apple-pending-wallet-version" value="${E(draft['apple-pending-wallet-version'] ?? wallet.version)}" /><div class="form-grid">${fields}${A.field(isCorrection ? '更正原因' : '到账依据', 'apple-pending-reason', `<textarea id="apple-pending-reason" name="apple-pending-reason" rows="3">${E(draft['apple-pending-reason'] || '')}</textarea>`, true).replace('class="field"', 'class="field form-field-wide"')}</div></form>`,
      A.button('取消', 'drawer-close') +
        '<button class="button primary" type="submit" form="apple-pending-form">核对</button>',
      key
    );
  }
  function openRefundHistory(id) {
    const refund = refunds.get(id);
    if (!refund) return;
    A.openDrawer(
      'Apple 回款更正记录',
      '',
      A.table(
        [
          { id: 'at', label: '更正时间' },
          { id: 'from', label: '更正前金额（美元）', render: (row) => E(shown(row.from)) },
          { id: 'to', label: '更正后金额（美元）', render: (row) => E(shown(row.to)) },
          { id: 'actor', label: '登记人' },
          { id: 'reason', label: '更正原因' }
        ],
        window.IDListOrder.sortByRecordTime(refund.corrections, row => row.at),
        '',
        'Apple回款更正记录'
      ),
      A.button('关闭', 'drawer-close')
    );
  }
  const fundingStates = { unused: '未使用', reserved: '待付款占用', used: '已使用', conflict: '待核对' };
  const paymentStates = { recorded: '已核实', review: '待核对', missing: '未登记付款 ID' };
  const subscriptionLabels = { active: '有效期内', upcoming: '即将到期', expired: '已过期',
    opened: '已开通', scheduled: '未开始', ended: '已终止' };
  const appleHealthLabel = asset => ({ dead: '死号', unlocking: '解封中' })[asset?.health] || asset?.status || '待核对';
  const appleHealthTag = asset => A.tag(appleHealthLabel(asset), asset?.health === 'dead' ? 'danger' :
    appleHealthLabel(asset) === '正常' ? 'success' : 'warning');
  const healthAction = id => A.button('变更账号状态', 'inventory-apple-health', '', '', `data-id="${E(id)}"`);
  function fundingSnapshot(includeSubscriptions = false) {
    const commerce = A.modules.commerce?.appleFundingData?.({ includeSubscriptions });
    const rules = window.IDAppleFunding;
    if (!commerce?.ready || !rules) return null;
    const ledger = { allocations: [...allocations.values()], movements };
    return { commerce, rules, index: rules.appleFundingIndex(commerce.orders, ledger),
      wallets: includeSubscriptions ? new Map(list().map(wallet => [wallet.id, wallet])) : null,
      related: includeSubscriptions ? null : rules.appleRelatedOrders(commerce.orders, ledger) };
  }
  function walletUsage(wallet, { commerce, rules, index, related }) {
    const funding = index.byWallet.get(wallet.id);
    const binding = funding?.bindings[0];
    const conflict = funding?.used && (!binding || funding.bindings.length !== 1 ||
      rules.appleBinding(index, binding.order).conflict);
    const links = (related.get(wallet.id) || []).map(link => ({ ...link,
      customer: link.order && !link.historical ? commerce.customer(link.order)?.name || '未登记客户' : '待核对',
      status: link.historical ? '历史余额记录 · 待核对' : link.order.cancelled ?
        (link.order.paidConfirmed || link.order.appleFunding?.bound ? '已付款 · 已撤单' : '未付款 · 已撤单') :
        link.order.paidConfirmed || link.order.appleFunding?.bound ?
          (link.order.subscriptionEnded ? '已付款 · 已终止' : '已付款') : '待付款'
    }));
    const accounts = [...new Map(links.flatMap(link => link.accounts.map(account => [
      JSON.stringify([link.product.startsWith('Claude') ? 'Claude' : link.product, account.trim().toLowerCase()]), account
    ]))).values()];
    return { links, accounts, used: Boolean(funding?.used),
      state: conflict ? 'conflict' : funding?.pending.length ? 'reserved' : funding?.used ? 'used' : 'unused' };
  }
  function recordedAppleEmail(order) {
    return window.IDOrderOpening.validOrderEmail(order.paymentId) ? order.paymentId.trim() : '';
  }
  function paymentAppleId(order, wallet) {
    return wallet?.email || recordedAppleEmail(order) ||
      (order.appleIdId ? '原付款 ID 待核对' : paymentStates.missing);
  }
  function subscriptionOrderTime(row) {
    return [row.end, row.start, window.IDOrderOpening.subscriptionTime(row.order.createdAt)]
      .find(Number.isFinite) ?? -Infinity;
  }
  function laterSubscription(a, b) {
    if (!b) return true;
    const aTime = subscriptionOrderTime(a), bTime = subscriptionOrderTime(b);
    if (aTime !== bTime) return aTime > bTime;
    const aStart = a.start || 0, bStart = b.start || 0;
    return aStart === bStart ? a.order.id > b.order.id : aStart > bStart;
  }
  function subscriptionRows(snapshot = fundingSnapshot(true)) {
    if (!snapshot || (localData && A.modules.inventory.getLocalInventoryState() !== 'ready')) return null;
    const { commerce, rules, index, wallets: byWallet } = snapshot;
    const latest = new Map(), groups = new Map();
    const { subscriptionDuration } = window.IDOrderOpening;
    for (const row of commerce.subscriptions) {
      const { key, order } = row;
      if (!order.cancelled && !['cancelled', '已撤单'].includes(order.status) &&
          laterSubscription(row, latest.get(key))) latest.set(key, row);
      if (order.payment !== '苹果内购') continue;
      const group = groups.get(key) || { current: row, history: [] };
      group.history.push(row);
      // Keep the period the customer is using when a future cycle is already saved.
      const active = row.status === 'active', previousActive = group.current.status === 'active';
      if ((active && !previousActive) || (active === previousActive && laterSubscription(row, group.current))) group.current = row;
      groups.set(key, group);
    }
    return [...groups.values()].map(({ current: row, history }) => {
      const { order, end, key, status } = row;
      const wallet = byWallet.get(order.appleIdId);
      const funding = index.byWallet.get(order.appleIdId);
      const bound = Boolean(wallet && rules.appleBinding(index, order).id === wallet.id);
      const hasPaymentId = Boolean(order.appleIdId || recordedAppleEmail(order));
      const payment = bound ? 'recorded' : hasPaymentId ? 'review' : 'missing';
      const contact = commerce.customer(order);
      const upcoming = status === 'active' && end - commerce.now <= commerce.renewalWarningHours * 3_600_000;
      const estimate = rules.applePrice(commerce.settings, order.product, order.plan, wallet?.appStoreRegion || order.appleStoreRegion);
      const current = row === latest.get(key) && ['active', 'opened', 'expired'].includes(status);
      const hasPeriod = end > row.start;
      const linkedRenewal = bound && (hasPeriod || order.paidConfirmed) && ready() &&
        !funding?.pending.length && appleHealthLabel(wallet) === '正常';
      const externalRenewal = payment === 'missing' && hasPeriod;
      const historySearch = history.flatMap(({ order: prior }) =>
        [prior.orderNo, byWallet.get(prior.appleIdId)?.email, recordedAppleEmail(prior)]);
      return { id: order.id, order, history, historySearch, wallet, payment, status: upcoming ? 'upcoming' : status, end,
        account: row.account || order.orderNo || '订阅账号未登记',
        apple: paymentAppleId(order, wallet),
        name: contact?.name || '',
        contact: ['wechat', 'customerPhone', 'whatsapp', 'telegram', 'qq'].map(field => contact?.[field]).filter(Boolean).join(' · '),
        plan: [order.product, order.plan].filter(Boolean).join(' · '),
        expiry: row.expiry,
        duration: ['active', 'expired'].includes(status) ? subscriptionDuration(end, commerce.now) : '',
        expected: current ? (estimate ? estimate + ' USD' : '待核算') : '',
        canRenew: Boolean(current && row.account && order.customerId && (linkedRenewal || externalRenewal))
      };
    });
  }
  const managementView = () => {
    if (!S.drafts.has(managementRoute)) S.drafts.set(managementRoute, { query: '', state: '', plan: '', sort: 'funding', page: 1, pageSize: window.IDPagination.defaultPageSize });
    return S.drafts.get(managementRoute);
  };
  let managementLoad, managementError = false;
  function refreshManagement() {
    if (!localData) return Promise.resolve(true);
    if (managementLoad) return managementLoad;
    managementError = false;
    managementLoad = Promise.all([refreshLocalBalance(),
      A.modules.inventory?.refreshLocalInventory?.({ keepContent: true }), A.modules.commerce?.refreshAppleFundingData?.()])
      .then(result => {
        managementError = !result.every(Boolean);
        return !managementError;
      }, () => {
        managementError = true;
        return false;
      }).finally(() => {
        managementLoad = null;
        updateLinkedAccounts();
        if (isBalanceRoute()) A.render();
      });
    return managementLoad;
  }
  function renderManagement() {
    const view = managementView(), all = subscriptionRows();
    const title = A.header('订阅管理 · 按苹果 ID',
      '查看用 Apple 内购开通的订阅账号、到期时间和付款 ID。查看全部苹果 ID 库存，请到「账号管理 → 苹果 ID 余额」。',
      A.button('列设置', 'column-settings', '', 'columns', 'data-table-id="苹果 ID 管理"') +
      A.button('刷新', 'apple-management-refresh', '', 'return'));
    const available = Boolean(all && (ready() || hasLoaded));
    const plans = [...new Set((all || []).map(row => row.plan).filter(Boolean))].sort();
    const query = view.query.trim().toLowerCase();
    const inScope = (row, scope) => !scope || (scope === 'missing' ? row.payment === 'missing' : row.status === scope);
    const matching = (all || []).filter(row => inScope(row, view.state) && (!view.plan || row.plan === view.plan) &&
      (!query || [row.name, row.contact, row.account, row.apple, ...row.historySearch]
        .some(value => String(value || '').toLowerCase().includes(query))));
    const rows = view.sort === 'funding'
      ? window.IDListOrder.sortByFundingDeadline(matching, row => row.end,
        row => ['upcoming', 'active'].includes(row.status))
      : window.IDListOrder.sortByRecordTime(matching, row => row.end, view.sort);
    if (available) view.page = Math.min(view.page, Math.max(1, Math.ceil(rows.length / view.pageSize)));
    const start = (view.page - 1) * view.pageSize;
    const choices = [['', '全部内购订阅'], ...Object.entries(subscriptionLabels), ['missing', paymentStates.missing]];
    const columns = [
      { id: 'account', label: '订阅账号', fixed: true, long: true, class: 'apple-management-account' },
      { id: 'apple', label: '付款苹果 ID', fixed: true, long: true, class: 'apple-management-account' },
      { id: 'name', label: '客户姓名', long: true, class: 'apple-management-customer', render: row => E(row.name || '—') },
      { id: 'plan', label: '订阅套餐', long: true, class: 'apple-management-plan', render: row => E(row.plan || '—') },
      { id: 'subscription', label: '订阅状态', class: 'apple-management-status', render: row =>
        A.tag(subscriptionLabels[row.status], { active: 'success', upcoming: 'warning', expired: 'danger' }[row.status] || '') },
      { id: 'expiry', label: '到期时间', render: row => E(row.expiry || '—') },
      { id: 'duration', label: '到期时长', render: row => E(row.duration || '—') },
      { id: 'contact', label: '联系方式', long: true, class: 'apple-management-contact', render: row => E(row.contact || '—') },
      { id: 'health', label: '付款 ID 状态', render: row => row.wallet ? appleHealthTag(row.wallet) : '—' },
      { id: 'state', label: '付款记录', class: 'apple-management-status', render: row => row.payment === 'missing'
        ? '—' : A.tag(paymentStates[row.payment], row.payment === 'recorded' ? 'success' : 'warning') },
      { id: 'balance', label: '余额（USD）', mobileSummary: true,
        render: row => E(row.wallet ? ready() || hasLoaded ? shown(row.wallet.balance) : '未读取' : '—') },
      { id: 'expected', label: '预计金额', class: 'apple-management-amount', render: row => E(row.expected || '—') },
      { id: 'actions', label: '操作', action: true, class: 'apple-management-actions', render: row =>
        `<div class="action-links">${A.textAction('更多操作', 'apple-management-more', `data-id="${E(row.id)}"`, '', 'chevron')}</div>` }
    ];
    const count = state => available ? all.filter(row => inScope(row, state)).length : '—';
    const statusTabs = `<div class="tabs" role="tablist" aria-label="苹果内购订阅状态">${choices.map(([state, label]) => {
      const id = 'apple-management-state-' + (state || 'all');
      return `<button type="button" id="${id}" class="tab" role="tab" aria-selected="${view.state === state}"
        aria-label="${label}" aria-describedby="${id}-count" data-action="apple-management-state" data-id="${state}">${label}<span class="tab-count" id="${id}-count">${count(state)}</span></button>`;
    }).join('')}</div>`;
    const overview = A.summary([
      ['内购订阅', count(''), '条', true], ['即将到期', count('upcoming'), '条'],
      ['已过期', count('expired'), '条'], [paymentStates.missing, count('missing'), '条']
    ]);
    const readFailed = managementError || loadState === 'error';
    let emptyState;
    if (available) emptyState = all.length
      ? { title: '暂无符合条件的记录', description: '可调整搜索或筛选条件。' }
      : { title: '暂无苹果内购订阅', description: '已开通的苹果内购订阅会显示在这里。' };
    else emptyState = readFailed ? { title: '苹果内购订阅读取失败', description: '可点击刷新重试。' }
      : { title: '正在读取苹果内购订阅', description: '' };
    return title + (A.modules.commerce?.subscriptionCenterNav?.('apple-ids', overview) || overview) + (readFailed && available ? '<p class="inline-notice warning" role="status">读取失败，已保留上次成功读取的资料。</p>' : '') +
      `<section class="panel apple-management-list" data-pagination-table>${statusTabs}<div class="toolbar"><div class="toolbar-left"><div class="search-field">
      ${A.icon('search')}<input data-auto-search id="apple-management-search" aria-label="搜索苹果内购订阅" placeholder="搜索订阅账号、付款 ID、客户或订单" value="${E(view.query)}" /></div>
      <select id="apple-management-plan" aria-label="订阅套餐">${A.options([['', '全部套餐'], ...plans], view.plan)}</select>
      <select id="apple-management-sort" aria-label="到期排序">${A.options([['funding', '待续费优先'], ['asc', '到期时间升序'], ['desc', '到期时间降序']], view.sort)}</select>
      </div><div class="toolbar-right" data-page-actions></div></div>
      ${A.table(columns, available ? rows.slice(start, start + view.pageSize) : [], '', '苹果 ID 管理', emptyState)}
      ${available ? window.IDPagination.render({ id: 'apple-management', page: view.page, pageSize: view.pageSize, total: rows.length }) : ''}</section>`;
  }
  const linkedView = id => {
    const key = 'apple-linked:' + id;
    if (!S.drafts.has(key)) S.drafts.set(key, { query: '', page: 1, pageSize: window.IDPagination.defaultPageSize });
    return S.drafts.get(key);
  };
  function updateLinkedAccounts() {
    const panel = document.querySelector?.('#drawer[open] [data-apple-linked-id]');
    if (!panel) return;
    const id = panel.dataset.appleLinkedId, subscription = panel.hasAttribute('data-apple-linked-subscription');
    const snapshot = fundingSnapshot(subscription);
    const wallet = subscription ? null : get(id);
    const row = subscription ? subscriptionRows(snapshot)?.find(item => item.history.some(record => record.order.id === id))
      : snapshot && wallet ? { apple: wallet.email, ...walletUsage(wallet, snapshot) } : null;
    const result = $('[data-apple-linked-results]', panel), status = $('[data-apple-linked-status]', panel);
    const error = managementError || loadState === 'error';
    status.innerHTML = error ? '<p class="inline-notice warning" role="status">关联资料读取失败。已读取的记录保留，可点击刷新重试。</p>' : '';
    if (!row) {
      result.innerHTML = A.empty(error ? '关联账号读取失败' : managementLoad || loading || !ready() ||
        !snapshot ? '正在读取关联账号' : subscription ? '未能找到此订阅' : '未能找到此苹果 ID',
        error ? '请点击刷新重试。' : '');
      return;
    }
    $('[data-apple-linked-identity]', panel).innerHTML = property(subscription ? '付款苹果 ID' : '苹果 ID', row.apple);
    const view = linkedView(id), query = view.query.trim().toLowerCase();
    const history = subscription ? window.IDListOrder.sortByRecordTime(row.history.map(record => ({
      id: record.order.id, order: record.order, orderId: record.order.id, orderNo: record.order.orderNo || record.order.id,
      account: record.account, customer: snapshot.commerce.customer(record.order)?.name || '未登记客户',
      apple: paymentAppleId(record.order, snapshot.wallets.get(record.order.appleIdId)),
      product: record.order.product, plan: record.order.plan, expiry: record.expiry,
      status: subscriptionLabels[record.status]
    })), link => [link.expiry, link.order.start, link.order.createdAt]) : row.links;
    const links = history.filter(link => !query ||
      [link.account, link.customer, link.product, link.plan, link.orderNo, link.apple]
        .some(value => String(value || '').toLowerCase().includes(query)));
    view.page = Math.min(view.page, Math.max(1, Math.ceil(links.length / view.pageSize)));
    const start = (view.page - 1) * view.pageSize;
    const columns = [
      { id: 'account', label: '关联账号', render: link => E(link.account || '未登记账号 · 待核对') },
      { id: 'customer', label: '客户' },
      ...(subscription ? [{ id: 'apple', label: '付款苹果 ID' }] : []),
      { id: 'product', label: '产品 / 套餐', render: link => E([link.product, link.plan].filter(Boolean).join(' · ') || '待核对') },
      { id: 'orderNo', label: '订单编号' },
      { id: 'status', label: '记录状态' },
      { id: 'expiry', label: '到期时间', render: link => E(link.expiry.replace('T', ' ') || '—') },
      { id: 'actions', label: '操作', action: true, render: link => link.order ?
        A.textAction('查看订单', 'apple-management-order', `data-id="${E(link.orderId)}"`) : '原订单缺失' }
    ];
    result.innerHTML = (subscription ? `<div class="property-list">${property('订阅账号', row.account)}${property('关联订单', history.length + ' 条')}</div>`
      : `<div class="property-list">${property('使用状态', fundingStates[row.state])}${property('关联账号',
      row.accounts.length ? row.accounts.length + ' 个' : row.links.length || row.state !== 'unused' ? '待核对' : '暂无关联')}
      ${property('关联记录', row.links.length + ' 条')}</div>`) +
      (row.state === 'conflict' ? '<p class="inline-notice warning" role="status">使用关联待核对，以下保留全部可追溯记录。</p>' : '') +
      (links.length ? fundingTable(columns, links.slice(start, start + view.pageSize), '苹果 ID 关联账号记录') :
        A.empty(query ? '没有匹配的关联记录' : row.state === 'unused' ? '暂无关联账号' : '关联账号资料缺失',
          query ? '可更换账号、客户或订单关键词。' : row.state === 'unused' ? '尚未登记订阅订单或余额使用记录。' : '请通过余额变动核对历史记录。')) +
      window.IDPagination.render({ id: 'apple-linked', page: view.page, pageSize: view.pageSize, total: links.length });
  }
  async function refreshLinkedAccounts(panel) {
    if (!panel?.isConnected || panel.getAttribute('aria-busy') === 'true') return;
    const sourceRoute = S.route, sourceActor = localData?.actor?.()?.id;
    const feedback = A.beginRegionRead(panel, $('[data-apple-linked-progress]', panel), {
      refreshButton: $('[data-action="apple-linked-refresh"]', panel)
    });
    try {
      await refreshManagement();
      if (panel.isConnected && sourceRoute === S.route && sourceActor === localData?.actor?.()?.id) updateLinkedAccounts();
    } finally { feedback.finish(); }
  }
  function openLinkedAccounts(id, subscription) {
    const wallet = subscription ? subscription.wallet : get(id), view = linkedView(id);
    A.openDrawer(subscription ? '订阅关联订单' : '苹果 ID 关联账号',
      subscription ? '查看这个订阅历次开通和续费时登记的付款 ID。' :
        '按原订单与余额使用记录查询。到期、退款或撤单仍保留历史关联；待付款和待核对记录单独标明。',
      `<section class="design-async-region" data-apple-linked-id="${E(id)}"${subscription ? ' data-apple-linked-subscription' : ''}><div class="property-list" data-apple-linked-identity>${property(subscription ? '付款苹果 ID' : '苹果 ID', subscription?.apple || wallet?.email || '读取中')}</div>
      <div class="toolbar"><div class="toolbar-left"><div class="search-field">${A.icon('search')}
      <input data-auto-search id="apple-linked-search" aria-label="搜索关联账号记录" placeholder="${subscription ? '搜索账号、付款 ID 或订单' : '搜索账号、客户或订单'}" value="${E(view.query)}" /></div></div>
      <div class="toolbar-right">${A.button('刷新', 'apple-linked-refresh')}</div></div>
      <div data-apple-linked-progress role="status" hidden></div><div data-apple-linked-status></div><div data-apple-linked-results></div></section>`,
      (wallet ? A.button('余额变动', 'apple-ledger', '', '', `data-id="${E(wallet.id)}"`) : '') + A.button('关闭', 'drawer-close'),
      'apple-linked:' + id, { kind: 'apple-ledger' });
    updateLinkedAccounts();
    if (!A.modules.commerce?.appleFundingData?.()?.ready || !ready()) return refreshLinkedAccounts($('#drawer[open] [data-apple-linked-id]'));
  }
  function render() {
    if (S.route === managementRoute) return renderManagement();
    if (!ready() && !hasLoaded) {
      const error = loadState === 'error';
      return (
        A.header('苹果 ID 余额', '苹果 ID 与余额流水由本机业务系统保存。') +
        `<section class="panel design-async-region" data-apple-balance-region><div data-apple-balance-progress role="status" hidden></div>${error
          ? `${A.empty('苹果 ID 余额读取失败', '请重新读取余额与流水。')}<div class="toolbar">${A.button('重新读取', 'apple-reload')}</div>`
          : '<div class="design-loading-rows" aria-label="余额资料"><div class="design-loading-row"></div><div class="design-loading-row"></div><div class="design-loading-row"></div></div>'}</section>`
      );
    }
    const accounts = list();
    const assets = new Map(A.modules.inventory.getAppleIds().map((asset) => [asset.id, asset]));
    const query = String(S.query || '').toLowerCase();
    const funding = fundingSnapshot();
    const usages = new Map(funding ? accounts.map(wallet => [wallet.id, walletUsage(wallet, funding)]) : []);
    const selected = S.drafts.get('apple-id-view') || 'all';
    const categories = [['all', '全部'], ['unused', '未使用'], ['used', '已使用'], ['dead', '死号'],
      ['unlocking', '解封中'], ['imports', '导入记录']];
    const matches = (row, tab) => tab === 'all' || (tab === 'used' ? usages.get(row.id)?.used :
      tab === 'unused' ? usages.get(row.id)?.state === 'unused' : row.health === tab);
    const tabs = `<div class="tabs" role="tablist" aria-label="苹果 ID 分类">${categories.map(([key, label]) =>
      `<button type="button" class="tab" role="tab" aria-selected="${selected === key}" data-action="apple-id-tab" data-tab="${key}">${label}${
        key !== 'imports' && (funding || !['unused', 'used'].includes(key)) ? ` ${accounts.filter(row => matches(row, key)).length}` : ''}</button>`).join('')}</div>`;
    const refreshFeedback = `<div class="inline-notice warning" data-apple-balance-error role="status" ${loadState === 'error' || managementError ? '' : 'hidden'}>余额或关联资料刷新失败，当前显示上次成功读取的资料。</div>`;
    const rows = accounts
      .filter(row => matches(row, selected))
      .filter(row => `${row.email} ${row.country}`.toLowerCase().includes(query) ||
        usages.get(row.id)?.links.some(link => [link.account, link.orderNo, link.customer].some(value => String(value).toLowerCase().includes(query))))
      .map((row) => ({ ...assets.get(row.id), ...row }));
    const assetValue =
      (key, fallback = '未填写') =>
      (row) =>
        E(assets.get(row.id)?.[key] || fallback);
    const columns = [
      {
        id: 'email',
        label: '苹果 ID',
        class: 'email-cell',
        render: (row) => A.textAction(row.email, 'apple-details', `data-id="${E(row.id)}"`)
      },
      {
        id: 'password',
        label: '邮箱密码',
        render: assetValue('password')
      },
      { id: 'security1', label: '密保 1', render: assetValue('security1'), long: true },
      { id: 'security2', label: '密保 2', render: assetValue('security2'), long: true },
      { id: 'security3', label: '密保 3', render: assetValue('security3'), long: true },
      { id: 'birthday', label: '密保生日', render: assetValue('birthday') },
      { id: 'phone', label: '绑定电话／验证码', render: row => A.modules.inventory?.phoneValue(assets.get(row.id)?.phone) || '—' },
      { id: 'country', label: '注册地区' },
      { id: 'appStoreRegion', label: 'Id地区', render: row => E(window.IDAppleFunding?.appleRegions[row.appStoreRegion] || '待核对') },
      { id: 'usage', label: '使用状态', render: row => E(fundingStates[usages.get(row.id)?.state] || (managementError ? '读取失败' : '读取中')) },
      { id: 'binding', label: '关联账号', mobileSummary: true, render: row => {
        const usage = usages.get(row.id), accounts = usage?.accounts || [];
        const label = !usage ? managementError ? '读取失败，重试' : '读取中' : accounts.length > 1 ?
          accounts.length + ' 个关联账号' : accounts[0] || (usage.state === 'unused' ? '暂无关联' : '待核对关联');
        return A.textAction(label, 'apple-linked-accounts', `data-id="${E(row.id)}"`, 'table-value-ellipsis');
      } },
      { id: 'device', label: '登录设备', render: assetValue('device') },
      { id: 'appPassword', label: '应用专用密码', render: assetValue('appPassword'), long: true },
      {
        id: 'status',
        label: '账号状态',
        render: appleHealthTag
      },
      {
        id: 'balance',
        label: 'ID 余额（USD · 美元）',
        render: (row) =>
          `<div class="action-links"><strong>${E(shown(row.balance))}</strong>${A.textAction('余额变动', 'apple-ledger', `data-id="${E(row.id)}"`)}</div>`
      },
      {
        id: 'source',
        label: '来源渠道',
        render: assetValue('source', '未记录')
      },
      {
        id: 'registered',
        label: '注册时间',
        render: (row) => {
          const asset = assets.get(row.id);
          return E(String((asset && (A.modules.inventory?.registrationTime?.(asset) ?? asset.registered)) || '未提供').replace('T', ' '));
        }
      },
      { id: 'createdBy', label: '录入人', render: assetValue('createdBy', '历史未记录') },
      { id: 'createdAt', label: '录入时间', render: assetValue('createdAt', '历史未记录') },
      {
        id: 'lastOperatedBy',
        label: '最近操作人',
        render: assetValue('lastOperatedBy', '历史未记录')
      },
      {
        id: 'lastOperatedAt',
        label: '最近操作时间',
        render: assetValue('lastOperatedAt', '历史未记录')
      },
      { id: 'notes', label: '备注 1', render: assetValue('notes'), long: true },
      { id: 'notes2', label: '备注 2', render: assetValue('notes2'), long: true },
      {
        id: 'actions',
        label: '操作',
        action: true,
        render: (row) =>
          `<div class="action-links">${A.textAction('编辑', 'apple-edit', `data-id="${E(row.id)}"`)}${A.textAction('详情', 'apple-details', `data-id="${E(row.id)}"`)}${A.textAction('更多操作', 'apple-more', `data-id="${E(row.id)}"`)}</div>`
      }
    ];
    return (
      A.header(
        '苹果 ID 余额',
        '苹果 ID 在账号管理独立维护。确认内购代付后扣减余额；客户退款、Apple 余额退回和更正撤回分别记录。',
        A.button('列设置', 'column-settings', '', 'columns', 'data-table-id="苹果ID余额"') +
          A.button('本表设置', 'inventory-settings', '', 'settings') +
          A.button('批量导入', 'apple-import', '', 'upload') +
          A.button('新增苹果 ID', 'apple-add', 'primary', 'plus')
      ) +
      refreshFeedback +
      A.summary([
        ['苹果 ID', accounts.length, '个'],
        [
          '余额合计',
          shown(accounts.reduce((total, row) => M.add(total, row.balance), '0')),
          'USD · 美元'
        ],
        ['有余额', accounts.filter((row) => M.compare(row.balance, '0') > 0).length, '个']
      ]) +
      `<section class="panel design-async-region" data-apple-balance-region><div data-apple-balance-progress role="status" hidden></div>${tabs}${selected === 'imports' ? A.modules.inventory.renderAppleImports() : `<div class="toolbar"><div class="toolbar-left"><div class="search-field">${A.icon('search')}<input data-auto-search id="apple-list-search" aria-label="搜索苹果 ID" placeholder="搜索苹果 ID、注册地区、关联账号或订单" value="${E(S.query || '')}" /></div></div><div class="toolbar-right" data-page-actions>${localData ? A.button('刷新', 'apple-reload') : ''}</div></div>${A.table(columns, A.pageRows(rows, row => [row.createdAt, row.importedAt, row.registered]), '', '苹果ID余额')}${A.pagination(rows.length)}`}</section>`
    );
  }
  function saveDrafts() {
    const form = $('#drawer[open] form[data-apple-draft]');
    if (form) S.drafts.set(form.dataset.appleDraft, A.readDraft(form));
  }
  function finish(form) {
    const key = form.dataset.appleDraft;
    form.removeAttribute('data-apple-draft');
    A.closeDrawer();
    if (key) S.drafts.delete(key);
    A.render();
  }
  async function finishLocal(form, promise, openResult) {
    const key = form.dataset.appleDraft;
    const snapshot = JSON.stringify(A.readDraft(form));
    const result = await promise;
    if (!result.ok) {
      A.notify(result.error);
      return;
    }
    if (
      form === $('#drawer[open] form[data-apple-draft]') &&
      JSON.stringify(A.readDraft(form)) === snapshot
    ) {
      finish(form);
      openResult();
    } else {
      if (JSON.stringify(S.drafts.get(key)) === snapshot) S.drafts.delete(key);
      A.render();
      A.notify('已保存本次登记');
    }
  }
  function submitPendingRefund(form, data) {
    const isCorrection = data['apple-pending-action'] === 'edit';
    const id = data['apple-pending-id'];
    const refund = refunds.get(id);
    if (!refund) {
      A.notify('回款记录已变化，请重新核对');
      return;
    }
    const amount = data['apple-pending-amount'];
    const options = {
      version: data['apple-pending-version'],
      ledgerVersion: data['apple-pending-ledger-version'],
      walletVersion: data['apple-pending-wallet-version'],
      confirmed: Boolean(data['apple-pending-confirmed']),
      reason: String(data['apple-pending-reason'] || '').trim()
    };
    const missing = isCorrection
      ? !valid(amount) && 'apple-pending-amount'
      : !options.confirmed && 'apple-pending-confirmed';
    A.setError(
      isCorrection ? 'apple-pending-amount' : 'apple-pending-confirmed',
      missing ? (isCorrection ? '请填写有效金额' : '请确认 Apple 余额已实际到账') : ''
    );
    A.setError('apple-pending-reason', options.reason ? '' : '请填写依据或原因');
    if (missing || !options.reason) return;
    A.confirmAction(
      isCorrection ? '确认更正待回款金额' : '确认 Apple 回款到账',
      isCorrection
        ? `${refund.orderNo} · ${shown(refund.amount)} → ${shown(amount)} USD · 美元。`
        : `${refund.orderNo} · 向原付款苹果 ID 余额登记到账 ${shown(refund.amount)} USD · 美元。`,
      () =>
        void finishLocal(
          form,
          isCorrection ? correctRefund(id, amount, options) : receiveRefund(id, options),
          () => openOrderRefund(refund.orderId)
        )
    );
  }
  function onSubmit(form) {
    if (!form.id.startsWith('apple-')) return false;
    saveDrafts();
    const d = A.readForm(form);
    if (localData && form.id === 'apple-pending-form') {
      submitPendingRefund(form, d);
      return true;
    }
    if (form.id === 'apple-adjust-form') {
      const topup = d['apple-topup'] === '1';
      const amount = d['apple-amount'],
        reason = String(d['apple-reason'] || '').trim();
      const wallet = get(d['apple-id']);
      if (!wallet) {
        A.notify('苹果 ID 资料已变化，请关闭后重新选择');
        return true;
      }
      A.setError(
        'apple-amount',
        valid(amount) && M.compare(amount, '0') > 0 ? '' : '请填写大于零的金额'
      );
      A.setError('apple-reason', topup || reason ? '' : '请填写变动原因');
      if (!valid(amount) || M.compare(amount, '0') <= 0 || (!topup && !reason)) return true;
      const signed = !topup && d['apple-direction'] === 'debit' ? M.subtract('0', amount) : amount;
      A.confirmAction(
        topup ? '确认登记充值到账' : '确认登记余额变动',
        `${wallet.email} · ${M.compare(signed, '0') > 0 ? '+' : ''}${shown(signed)} USD · 美元。`,
        () => {
          const options = {
            reason,
            expectedVersion: d['apple-version'], topup, commandId: d['apple-command']
          };
          if (localData) {
            void finishLocal(form, saveAdjustment(d['apple-id'], signed, options), () =>
              openLedger(d['apple-id'])
            );
            return;
          }
          const result = adjust(d['apple-id'], signed, options);
          if (!result.ok) {
            A.notify(result.error);
            return;
          }
          finish(form);
          openLedger(d['apple-id']);
        }
      );
    } else if (!localData && form.id === 'apple-return-form') {
      const amount = d['apple-return-amount'],
        reason = String(d['apple-return-reason'] || '').trim(),
        allocation = getOrderLedger(d['apple-order-id']);
      const amountOk =
        allocation &&
        valid(amount) &&
        M.compare(amount, '0') > 0 &&
        M.compare(amount, allocation.netAmount) <= 0;
      A.setError('apple-return-amount', amountOk ? '' : '金额需大于零且不超过本单净扣款');
      A.setError('apple-return-reason', reason ? '' : '请填写实际到账依据');
      A.setError(
        'apple-return-confirmed',
        d['apple-return-confirmed'] ? '' : '请确认 Apple 余额已实际到账'
      );
      if (!amountOk || !reason || !d['apple-return-confirmed']) return true;
      A.confirmAction(
        '确认 Apple 余额已退回',
        `${allocation.orderNo} · ${shown(amount)} USD · 美元。此记录独立于客户退款，不会自动向客户退款。`,
        () => {
          const result = refundToApple(d['apple-order-id'], amount, {
            reason,
            expectedVersion: d['apple-ledger-version'],
            expectedWalletVersion: d['apple-wallet-version']
          });
          if (!result.ok) {
            A.notify(result.error);
            return;
          }
          finish(form);
          openLedger(allocation.appleIdId);
        }
      );
    }
    return true;
  }
  function onClick(action, node) {
    if (!action.startsWith('apple-')) return false;
    const id = node.dataset.id;
    if (action === 'apple-id-tab') {
      S.drafts.set('apple-id-view', node.dataset.tab);
      S.page = 1;
      A.render();
      return true;
    }
    if (action === 'apple-management-state') {
      if (S.route === managementRoute && (id === '' || id === 'missing' || Object.hasOwn(subscriptionLabels, id))) {
        Object.assign(managementView(), { state: id, page: 1 });
        A.render();
        document.getElementById(node.id)?.focus({ preventScroll: true });
      }
      return true;
    }
    if (action === 'apple-linked-accounts') {
      void openLinkedAccounts(id);
      return true;
    }
    if (action === 'apple-linked-refresh') {
      void refreshLinkedAccounts(node.closest('[data-apple-linked-id]'));
      return true;
    }
    if (action === 'apple-management-refresh') {
      void A.withActionFeedback(node, refreshManagement, { pending: '正在读取苹果内购订阅…', failure: '读取失败，请重试' });
      return true;
    }
    if (action === 'apple-management-order') {
      A.closeDrawer();
      A.go('orders/detail/' + encodeURIComponent(id));
      return true;
    }
    if (action.startsWith('apple-management-')) {
      if (S.route !== managementRoute) return true;
      const row = subscriptionRows()?.find(item => item.id === id);
      if (!row) return true;
      const attrs = `data-id="${E(id)}"`;
      const walletAttrs = row.wallet ? `data-id="${E(row.wallet.id)}"` : '';
      if (action === 'apple-management-more') A.openActionMenu(node,
        (row.canRenew ? A.button('续费', 'apple-management-renew', '', '', attrs) : '') +
        A.button('订单详情', 'apple-management-order', '', '', attrs) +
        A.button('查看关联订单', 'apple-management-history', '', '', attrs) +
        (row.wallet ? A.button('充值', 'apple-topup', '', '', walletAttrs) + A.button('余额变动', 'apple-ledger', '', '', walletAttrs) +
          healthAction(row.wallet.id) : '') +
        A.button('复制', 'apple-management-copy', '', '', attrs));
      else if (action === 'apple-management-renew' && row.canRenew) A.modules.commerce.openAppleRenewal(row.order.id);
      else if (action === 'apple-management-history') void openLinkedAccounts(id, row);
      else if (action === 'apple-management-copy') void A.copyText([
        '订阅账号：' + row.account, '付款苹果 ID：' + row.apple, row.expected ? '预计金额：' + row.expected : ''
      ].filter(Boolean).join('\n'));
      return true;
    }
    if (action === 'apple-add') A.modules.inventory.editAppleId();
    else if (action === 'apple-edit') A.modules.inventory.editAppleId(id);
    else if (action === 'apple-details') A.modules.inventory.showAppleId(id);
    else if (action === 'apple-import') A.modules.inventory.importAppleIds();
    else if (action === 'apple-ledger') openLedger(id);
    else if (action === 'apple-adjust') adjustmentEditor(id);
    else if (action === 'apple-topup') {
      if (ready()) adjustmentEditor(id, true);
      else void ensureReady().then(ok => ok ? adjustmentEditor(id, true) : A.notify('余额读取失败，请重试'));
    } else if (action === 'apple-more') {
      A.openActionMenu(node, healthAction(id) + A.button('关联账号', 'apple-linked-accounts', '', '', `data-id="${E(id)}"`) +
        A.button('充值', 'apple-topup', '', '', `data-id="${E(id)}"`) +
        A.button('余额变动', 'apple-ledger', '', '', `data-id="${E(id)}"`));
    }
    else if (action === 'apple-reload') void A.withActionFeedback(node, refreshManagement,
      { pending: '正在读取余额与关联资料…', success: '余额与关联资料已刷新', failure: '读取失败，已保留当前资料' });
    else if (action === 'apple-pending-edit') pendingRefundEditor(id, true);
    else if (action === 'apple-pending-receive') pendingRefundEditor(id, false);
    else if (action === 'apple-refund-history') openRefundHistory(id);
    else if (action === 'apple-return-select') {
      if (localData) {
        openRefundList(listRefunds().filter((refund) => refund.appleIdId === id));
        return true;
      }
      const row = [...allocations.values()].filter(
        (allocation) => allocation.appleIdId === id && M.compare(net(allocation), '0') > 0
      );
      A.openDrawer(
        '选择 Apple 退回订单',
        '只列出该苹果 ID 已有净扣款的订单，逐项核对实际到账。',
        A.table(
          [
            { id: 'orderNo', label: '订单编号' },
            { id: 'email', label: '客户账号' },
            {
              id: 'remaining',
              label: '可退回余额（美元）',
              render: (entry) => E(shown(net(entry)))
            },
            {
              id: 'actions',
              label: '操作',
              action: true,
              render: (entry) =>
                A.textAction('登记实际退回', 'apple-return-order', `data-id="${E(entry.orderId)}"`)
            }
          ],
          row.map((entry) => ({ ...entry, id: entry.orderId })),
          '',
          'Apple退回订单'
        ),
        A.button('关闭', 'drawer-close')
      );
    } else if (action === 'apple-return-order') openOrderRefund(id);
    else if (action === 'apple-undo') {
      const entry = movements.find((row) => row.id === id);
      if (entry)
        A.openDrawer(
          '补偿撤回余额变动',
          '只撤回人工余额变动；后续已有扣款或余额记录时禁止覆盖。',
          `<div class="property-list">${property('原变动', `${shown(entry.amount)} USD · 美元`)}${property('原原因', entry.reason)}</div><form id="apple-undo-form" data-apple-draft="apple-undo:${E(id)}" novalidate><input type="hidden" name="apple-entry-id" value="${E(id)}" />${A.field('撤回原因', 'apple-undo-reason', A.input('apple-undo-reason', S.drafts.get(`apple-undo:${id}`)?.['apple-undo-reason'] || ''), true)}</form>`,
          A.button('取消', 'drawer-close') +
            '<button class="button primary" form="apple-undo-form" type="submit">核对补偿撤回</button>',
          `apple-undo:${id}`
        );
    }
    return true;
  }
  function onInput(node) {
    if (node.id === 'apple-linked-search') {
      const panel = node.closest('[data-apple-linked-id]');
      if (panel) {
        Object.assign(linkedView(panel.dataset.appleLinkedId), { query: node.value, page: 1 });
        updateLinkedAccounts();
      }
      return true;
    }
    if (node.id === 'apple-list-search' || node.id === 'apple-management-search') {
      const cursor = node.selectionStart;
      if (node.id === 'apple-management-search') Object.assign(managementView(), { query: node.value, page: 1 });
      else {
        S.query = node.value;
        S.page = 1;
      }
      A.render();
      const next = $('#' + node.id);
      next.focus();
      next.setSelectionRange(cursor, cursor);
      return true;
    }
    if (node.closest('form[data-apple-draft]')) {
      saveDrafts();
      return true;
    }
    return false;
  }
  const baseSubmit = onSubmit;
  function submit(form) {
    if (form.id !== 'apple-undo-form') return baseSubmit(form);
    saveDrafts();
    const d = A.readForm(form),
      reason = String(d['apple-undo-reason'] || '').trim();
    A.setError('apple-undo-reason', reason ? '' : '请填写撤回原因');
    if (!reason) return true;
    A.confirmAction(
      '确认补偿撤回',
      '新增一笔反向流水，保留原始变动；不会删除订单或已有余额历史。',
      () => {
        const entry = movements.find((row) => row.id === d['apple-entry-id']);
        if (localData) {
          void finishLocal(form, saveAdjustmentUndo(d['apple-entry-id'], reason), () =>
            openLedger(entry.appleIdId)
          );
          return;
        }
        const result = undoAdjustment(d['apple-entry-id'], reason);
        if (!result.ok) {
          A.notify(result.error);
          return;
        }
        finish(form);
        openLedger(entry.appleIdId);
      }
    );
    return true;
  }
  A.modules.appleBalance = {
    list,
    get,
    fundingIndex: orders => window.IDAppleFunding?.appleFundingIndex(orders, { allocations: [...allocations.values()], movements }),
    previewOrder,
    commitOrder: localData ? () => fail('余额扣款必须与本机订单一起保存') : commitOrder,
    prepareOrder,
    registerOpeningOrder,
    reconcileOrder: localData ? () => fail('余额扣款必须与本机订单一起保存') : commitOrder,
    refundToApple: localData ? () => fail('请通过待回款记录确认实际到账') : refundToApple,
    getOrderLedger,
    entries,
    adjust: localData ? saveAdjustment : adjust,
    undoAdjustment: localData ? saveAdjustmentUndo : undoAdjustment,
    prepareRefund,
    listRefunds,
    correctRefund,
    receiveRefund,
    ready,
    readFailed: () => loadState === 'error',
    ensureReady,
    applyCommittedBalance,
    refreshLocalBalance,
    openLedger,
    openSubscriptionFunding: openLinkedAccounts,
    openOrderRefund
  };
  window.IDDesignModules.push({
    id: 'apple-balance',
    matches: (route) => ['accounts/apple-balances', 'mailboxes/apple', managementRoute].includes(route),
    beforeNavigate(route) {
      if (localData && A.usesSharedBusinessData(route) &&
          (A.canVisit('accounts/apple-balances') || A.canVisit(managementRoute)) && loadState === 'idle')
        void ensureReady();
    },
    render,
    afterRender({ routeChanged } = {}) {
      if (loading) bindBalanceRead();
      if (routeChanged && isBalanceRoute() && localData) void refreshManagement();
    },
    onDataChanges(scopes) {
      if (isBalanceRoute() && ['commerce', 'inventory', 'settings'].some(scope => scopes.includes(scope)))
        return refreshManagement();
    },
    onClick,
    onSubmit: submit,
    onInput,
    onChange: (node) => {
      if (S.route === managementRoute && ['apple-management-plan', 'apple-management-sort'].includes(node.id)) {
        Object.assign(managementView(), { [node.id.slice('apple-management-'.length)]: node.value, page: 1 });
        A.render();
        return true;
      }
      if (node.closest('form[data-apple-draft]')) {
        saveDrafts();
        return true;
      }
      return false;
    },
    preserveDraft: saveDrafts
  });
  document.addEventListener?.('id-pagination-change', ({ detail, target }) => {
    const panel = target.closest?.('#drawer[open] [data-apple-linked-id]');
    if (detail.id === 'apple-linked' && panel) {
      Object.assign(linkedView(panel.dataset.appleLinkedId), { page: detail.page, pageSize: detail.pageSize });
      updateLinkedAccounts();
      return;
    }
    if (S.route !== managementRoute || detail.id !== 'apple-management' || !$('#main')?.contains(target)) return;
    Object.assign(managementView(), { page: detail.page, pageSize: detail.pageSize });
    A.render();
  });
})();
