const labels = Object.freeze({ plus: 'Plus', pro100: 'Pro 100', pro200: 'Pro 200', pro500: 'Pro 500' });
const choices = Object.entries(labels).map(([value, label]) =>
  '<label class="card-plan-choice"><input type="checkbox" value="' + value + '"><span>' + label + '</span></label>').join('');

export const cardPlanImportFields = '<fieldset id="card_pool_import_plans" class="card-plan-options" disabled>' +
  '<legend>允许套餐</legend><div class="card-plan-grid">' + choices + '</div></fieldset>';

export const cardPlanToolbar = `
  <section class="card-plan-toolbar" aria-labelledby="card_pool_list_title" tabindex="0">
    <h2 class="panel-title" id="card_pool_list_title">银行卡列表</h2>
    <button type="button" class="btn btn-secondary" id="card_plan_mode" aria-pressed="false" disabled>仅使用已设置套餐的卡</button>
    <button type="button" class="btn btn-secondary" id="card_plan_batch" disabled>批量设置套餐</button>
    <button type="button" class="btn btn-secondary" id="card_plan_enable_all" style="color:var(--success,#10b981);">一键开启</button>
    <button type="button" class="btn btn-secondary" id="card_plan_disable_all" style="color:var(--text-dim,#6b7280);">一键关闭</button>
    <span id="card_plan_summary" role="status">正在读取套餐设置…</span>
  </section>`;

export const cardPlanEditor = `
  <dialog class="card-plan-editor" id="card_plan_editor" aria-labelledby="card_plan_title" aria-describedby="card_plan_result">
    <form>
      <header class="card-plan-editor-header">
        <h3 id="card_plan_title">设置允许套餐</h3>
        <p id="card_plan_help">选择银行卡允许使用的套餐，可多选，至少选择一项。保存后，已设置的卡只用于所选套餐；批量设置会统一替换所选银行卡的允许套餐。</p>
        <button type="button" class="btn btn-secondary card-plan-editor-close" id="card_plan_close" aria-label="关闭套餐设置"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg></button>
      </header>
      <div class="card-plan-editor-body">
        <div class="card-plan-target">
          <span class="card-plan-target-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 10h18M7 15h4"/></svg></span>
          <div class="card-plan-target-copy"><span id="card_plan_target_label">当前银行卡</span><strong id="card_plan_target"></strong><p id="card_plan_target_detail" hidden></p></div>
        </div>
        <fieldset id="card_plan_options" class="card-plan-options">
          <legend>允许套餐</legend><div class="card-plan-grid">${choices}</div>
        </fieldset>
        <div class="embedded-field" style="margin-top: 14px;">
          <label for="card_plan_max_usage">单卡使用上限（可选）</label>
          <input type="number" id="card_plan_max_usage" class="asset-input" min="1" max="20" placeholder="留空则按套餐默认上限">
          <p class="embedded-field-hint">单独限制此卡最多充值账户数（1–20 次）。留空则自动按「一卡几充设置」中的套餐上限执行。</p>
        </div>
        <p id="card_plan_result" role="status"></p>
      </div>
      <footer class="card-plan-editor-actions">
        <span id="card_plan_selection" role="status" aria-live="polite"></span>
        <button type="button" class="btn btn-secondary" id="card_plan_cancel">取消</button>
        <button type="submit" class="btn btn-primary">保存</button>
      </footer>
    </form>
  </dialog>`;

export function createCardPlanAdmin({ labels, request, loadCards, onImportChange, notify, confirm }) {
  const element = id => document.getElementById(id);
  const importFields = element('card_pool_import_plans');
  const tbody = element('card_pool_list_body');
  const mode = element('card_plan_mode');
  const batch = element('card_plan_batch');
  const enableAllBtn = element('card_plan_enable_all');
  const disableAllBtn = element('card_plan_disable_all');
  const summary = element('card_plan_summary');
  const dialog = element('card_plan_editor');
  const options = element('card_plan_options');
  const result = element('card_plan_result');
  const save = dialog.querySelector('[type="submit"]');
  const selected = new Set();
  let snapshot = null, rows = new Map(), editing = null, writing = false;

  function attachCardPlanHelp() {
    for (const [title, hint, control] of [
      [element('card_plan_title'), element('card_plan_help')],
      [element('card_pool_import_box')?.querySelector('.import-box-title'), element('card_pool_import_hint'), element('card_pool_import_text')],
      [document.querySelector('label[for="card_pool_import_type"]'), element('card_pool_import_type_hint'), element('card_pool_import_type')]
    ]) {
      if (!title || !hint || !window.IDTitleHelp) continue;
      window.IDTitleHelp.attach(title, hint);
      control?.setAttribute('aria-describedby', title.parentElement.querySelector('.title-description').id);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attachCardPlanHelp, { once: true });
  else attachCardPlanHelp();

  const readChoices = group => [...group.querySelectorAll('input:checked')].map(input => input.value);
  const setChoices = (group, values) => {
    for (const input of group.querySelectorAll('input')) input.checked = values.includes(input.value);
  };
  const validPolicy = value => Number.isSafeInteger(value?.version) && value.version >= 0 &&
    typeof value.strict === 'boolean';
  const readDraft = () => window.parent.IDRechargeDrafts?.read('admin') || {};
  const writeDraft = values => window.parent.IDRechargeDrafts?.write('admin', values);
  function readLimits() {
    try {
      return JSON.parse(readDraft().card_pool_usage_limits || '{}');
    } catch {
      return {};
    }
  }
  function writeLimits(limits) {
    try {
      const draft = readDraft();
      draft.card_pool_usage_limits = JSON.stringify(limits);
      writeDraft(draft);
    } catch { /* Ignore draft errors */ }
  }
  function readPlanReuseLimits() {
    try {
      if (window.idRechargePlanReuseLimits) return window.idRechargePlanReuseLimits;
      const raw = readDraft().card_plan_reuse_limits;
      if (raw) return JSON.parse(raw);
    } catch { /* Ignore draft errors */ }
    return { plus: 4, pro100: 1, pro200: 1, pro500: 1 };
  }
  function getCardLimit(card) {
    const limits = readLimits();
    const custom = limits[Number(card.id)];
    if (Number.isSafeInteger(custom) && custom >= 1 && custom <= 20) return custom;
    const planLimits = readPlanReuseLimits();
    const plans = Array.isArray(card.allowed_plans) && card.allowed_plans.length ? card.allowed_plans : ['plus'];
    if (plans.every(p => p.startsWith('pro'))) {
      const proKey = plans[0] || 'pro100';
      return planLimits[proKey] || 1;
    }
    return planLimits.plus || 4;
  }
  function usageCell(card) {
    const count = Number(card.usage_count || 0);
    const limit = getCardLimit(card);
    const exhausted = count >= limit;
    return '<span class="card-usage-metric' + (exhausted ? ' is-exhausted' : '') + '">' +
      count + ' / ' + limit + '</span>' +
      (exhausted ? ' <span class="status-badge status-exhausted">已用满</span>' : '');
  }
  function isExhausted(card) {
    return Number(card.usage_count || 0) >= getCardLimit(card);
  }
  function rememberImport() {
    writeDraft({ ...readDraft(), card_pool_allowed_plans: readChoices(importFields).join(',') });
    onImportChange();
  }
  setChoices(importFields, String(readDraft().card_pool_allowed_plans || '').split(','));
  importFields.addEventListener('change', rememberImport);

  function paint() {
    batch.disabled = !snapshot || writing || selected.size === 0;
    batch.textContent = selected.size ? '设置所选 ' + selected.size + ' 张卡' : '批量设置套餐';
    if (enableAllBtn) {
      enableAllBtn.disabled = !snapshot || writing;
      enableAllBtn.textContent = selected.size ? '开启所选 ' + selected.size + ' 张' : '一键开启';
    }
    if (disableAllBtn) {
      disableAllBtn.disabled = !snapshot || writing;
      disableAllBtn.textContent = selected.size ? '关闭所选 ' + selected.size + ' 张' : '一键关闭';
    }
    mode.disabled = !snapshot || writing;
    mode.setAttribute('aria-pressed', String(snapshot?.strict === true));
    importFields.disabled = !snapshot;
    if (snapshot) {
      const missing = [...rows.values()].filter(card => card.allowed_plans == null).length;
      summary.textContent = '未设置 ' + missing + ' 张 · ' +
        (snapshot.strict ? '未设置的卡不参与自动取卡' : '未设置的卡暂按原规则使用');
    }
    for (const input of tbody.querySelectorAll('[data-card-plan-select]'))
      input.checked = selected.has(Number(input.value));
  }

  function accept(policy, cards) {
    if (!validPolicy(policy)) {
      summary.textContent = '套餐设置读取失败，请刷新卡池。';
      return !snapshot;
    }
    if (snapshot && policy.version < snapshot.version) return false;
    snapshot = policy;
    rows = new Map(cards.map(card => [Number(card.id), card]));
    for (const id of selected) if (!rows.has(id)) selected.delete(id);
    paint();
    return true;
  }

  function cell(card) {
    const id = Number(card.id);
    if (!Number.isSafeInteger(id) || id < 1 || !snapshot) return '—';
    const allowed = Array.isArray(card.allowed_plans)
      ? card.allowed_plans.filter(plan => Object.hasOwn(labels, plan)).map(plan => labels[plan]).join(' / ')
      : '未设置';
    const reference = /^\d{12,19}$/.test(card.card_number) ? ' ' + card.card_number : '编号 ' + id;
    return '<div class="card-plan-cell"><label class="card-plan-select"><input type="checkbox" data-card-plan-select value="' + id +
      '" aria-label="选择银行卡' + reference + '"></label>' +
      '<button type="button" class="btn btn-secondary" data-card-plan-edit="' + id +
      '" aria-haspopup="dialog" aria-label="设置银行卡' + reference + '的允许套餐">' +
      (allowed || '待核对') + '</button></div>';
  }

  function open(ids) {
    if (!snapshot || writing || ids.some(id => !rows.has(id))) return;
    const key = [...ids].sort((a, b) => a - b).join(',');
    let draft;
    try { draft = JSON.parse(readDraft().card_pool_plan_editor || 'null'); } catch { /* Invalid drafts are discarded. */ }
    editing = { ids, key, version: snapshot.version };
    const cardLabel = id => rows.get(id).card_number || '银行卡编号 ' + id + '（未留存完整卡号）';
    element('card_plan_target_label').textContent = ids.length > 1 ? '批量设置' : '当前银行卡';
    element('card_plan_target').textContent = ids.length > 1 ? '已选 ' + ids.length + ' 张银行卡' : cardLabel(ids[0]);
    const detail = element('card_plan_target_detail');
    detail.textContent = ids.length > 1 ? ids.slice(0, 4).map(cardLabel).join(' · ') + (ids.length > 4 ? ' 等' : '') : '';
    detail.hidden = ids.length === 1;
    result.dataset.state = 'info';
    result.textContent = ids.length > 1 ? '将替换这 ' + ids.length + ' 张卡的允许套餐。' : '';
    setChoices(options, draft?.key === key && Array.isArray(draft.plans) ? draft.plans :
      (ids.length === 1 ? rows.get(ids[0]).allowed_plans || [] : []));
    const maxUsageInput = element('card_plan_max_usage');
    if (maxUsageInput) {
      if (ids.length === 1) {
        const limits = readLimits();
        maxUsageInput.value = limits[ids[0]] || '';
      } else {
        maxUsageInput.value = '';
      }
    }
    paintSelection();
    save.disabled = false;
    dialog.showModal();
  }

  function paintSelection() {
    element('card_plan_selection').textContent = '已选 ' + readChoices(options).length + ' / ' + Object.keys(labels).length;
  }

  async function write(command) {
    const response = await request('/api/admin/cards/plan-policy', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command)
    });
    const reply = await response.json();
    if (!response.ok || reply.success !== true || !validPolicy(reply.planPolicy)) {
      if (response.status === 409) {
        await loadCards();
        throw new Error(reply.message || '套餐设置已更新，请重新打开编辑');
      }
      throw new Error('套餐设置保存未确认，请刷新后核对');
    }
    if (!(await loadCards())) notify('套餐设置已保存，列表刷新失败。', 'error');
    return reply.planPolicy;
  }

  tbody.addEventListener('change', event => {
    if (!event.target.matches('[data-card-plan-select]')) return;
    const id = Number(event.target.value);
    if (event.target.checked && selected.size >= 500) {
      event.target.checked = false;
      notify('每次最多设置 500 张银行卡。', 'error');
      return;
    }
    if (event.target.checked) selected.add(id); else selected.delete(id);
    paint();
  });
  tbody.addEventListener('click', event => {
    const button = event.target.closest('[data-card-plan-edit]');
    if (button) open([Number(button.dataset.cardPlanEdit)]);
  });
  async function triggerBatchToggle(isEnabled) {
    if (!snapshot || writing) return;
    const isAll = selected.size === 0;
    const targetCount = isAll ? rows.size : selected.size;
    const actionText = isEnabled ? '开启' : '关闭';
    if (targetCount === 0) {
      notify('当前无可用银行卡', 'warning');
      return;
    }
    const ok = await confirm(isAll
      ? '确定' + actionText + '当前全部 ' + targetCount + ' 张银行卡吗？' + (isEnabled ? '开启后可被调用。' : '关闭后将暂停调用。')
      : '确定' + actionText + '所选的 ' + targetCount + ' 张银行卡吗？', actionText);
    if (!ok) return;
    writing = true;
    paint();
    try {
      const payload = isAll
        ? { all: true, is_enabled: isEnabled ? 1 : 0 }
        : { ids: [...selected], is_enabled: isEnabled ? 1 : 0 };
      const res = await request('/api/admin/cards/batch-toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (res.ok && data.success) {
        notify(actionText + '成功，共处理 ' + (data.affected || targetCount) + ' 张卡', 'success');
        await loadCards();
      } else {
        notify(data.message || data.error || '操作失败', 'error');
      }
    } catch (e) {
      notify('请求失败: ' + e.message, 'error');
    } finally {
      writing = false;
      paint();
      window.idRechargeApplyCardChanges?.();
    }
  }

  enableAllBtn?.addEventListener('click', () => triggerBatchToggle(true));
  disableAllBtn?.addEventListener('click', () => triggerBatchToggle(false));
  batch.addEventListener('click', () => open([...selected]));
  mode.addEventListener('click', async () => {
    if (!snapshot || writing) return;
    const { version, strict } = snapshot;
    if (!(await confirm(strict
      ? '关闭后，未设置套餐的卡将按原规则参与自动取卡。已设置的卡仍只用于所选套餐。'
      : '开启后，未设置套餐的卡不会参与自动取卡。没有符合条件的卡时，对应套餐将暂停受理。',
    '确认套餐取卡规则'))) return;
    if (writing) return;
    writing = true;
    paint();
    try { await write({ version, strict: !strict }); notify('套餐取卡规则已保存。', 'success'); }
    catch (error) { notify(error.message, 'error'); }
    finally { writing = false; paint(); window.idRechargeApplyCardChanges?.(); }
  });
  element('card_plan_cancel').addEventListener('click', () => dialog.close());
  element('card_plan_close').addEventListener('click', () => { if (!writing) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (writing) event.preventDefault(); });
  options.addEventListener('change', () => {
    paintSelection();
    if (editing) writeDraft({ ...readDraft(),
      card_pool_plan_editor: JSON.stringify({ key: editing.key, plans: readChoices(options) }) });
  });
  dialog.addEventListener('close', () => {
    editing = null;
    for (const help of dialog.querySelectorAll('details[open]')) help.open = false;
  });
  dialog.querySelector('form').addEventListener('submit', async event => {
    event.preventDefault();
    if (writing || !editing) return;
    const allowedPlans = readChoices(options);
    if (!allowedPlans.length) { result.dataset.state = 'error'; result.textContent = '请选择至少一个允许套餐。'; return; }
    const maxUsageInput = element('card_plan_max_usage');
    const rawMax = maxUsageInput ? maxUsageInput.value.trim() : '';
    const parsedMax = rawMax ? Number(rawMax) : null;
    if (rawMax && (!Number.isInteger(parsedMax) || parsedMax < 1 || parsedMax > 20)) {
      result.dataset.state = 'error';
      result.textContent = '单卡使用上限必须在 1 至 20 之间，或留空使用默认上限。';
      return;
    }
    const { ids, version } = editing;
    writing = true;
    save.disabled = true;
    save.textContent = '保存中…';
    dialog.querySelector('form').setAttribute('aria-busy', 'true');
    element('card_plan_cancel').disabled = true;
    element('card_plan_close').disabled = true;
    options.disabled = true;
    paint();
    try {
      await write({ version, cardIds: ids, allowedPlans });
      const limits = readLimits();
      for (const id of ids) {
        if (parsedMax) limits[id] = parsedMax;
        else delete limits[id];
      }
      writeLimits(limits);
      for (const id of ids) selected.delete(id);
      const draft = readDraft();
      delete draft.card_pool_plan_editor;
      writeDraft(draft);
      editing = null;
      dialog.close();
      notify('允许套餐与使用上限已保存。', 'success');
    } catch (error) {
      result.dataset.state = 'error';
      result.textContent = error.message;
    } finally {
      writing = false;
      save.disabled = false;
      save.textContent = '保存';
      dialog.querySelector('form').removeAttribute('aria-busy');
      element('card_plan_cancel').disabled = false;
      element('card_plan_close').disabled = false;
      options.disabled = false;
      paint();
      window.idRechargeApplyCardChanges?.();
    }
  });
  // The last component is the independent review document version.
  const cardChange = marker => /^([a-z0-9]+):(\d+):\d+$/i.exec(marker || '');
  let appliedCardChange = cardChange(window.parent.IDLocalData?.changeVersion?.('recharge-card-plans'));
  let readingCardChange = false;
  window.idRechargeCardPolicyVersion = () => snapshot?.version;
  window.idRechargeCardPlansChanged = marker => {
    if (!snapshot || writing || readingCardChange || element('card_pool_import_btn').dataset.saving ||
        window.idRechargeVisible === false || document.hidden ||
        !element('cards')?.classList.contains('active') || !tbody.checkVisibility()) return false;
    const change = cardChange(marker);
    if (change) {
      if (change[1] === appliedCardChange?.[1] && Number(change[2]) <= Number(appliedCardChange[2])) return true;
      appliedCardChange = change;
    } else {
      const version = Number(String(marker || '').split(':').at(-1));
      if (!Number.isSafeInteger(version) || version <= snapshot.version) return true;
    }
    readingCardChange = true;
    void loadCards().finally(() => {
      readingCardChange = false;
      window.idRechargeApplyCardChanges?.();
    });
    return true;
  };
  return {
    accept, cell, usageCell, isExhausted, paint,
    remove(id) {
      rows.delete(Number(id));
      selected.delete(Number(id));
      paint();
    },
    importRequest() {
      const allowedPlans = readChoices(importFields);
      return snapshot && allowedPlans.length ? { allowedPlans, planVersion: snapshot.version } : null;
    },
    confirmedImport(data, command) {
      return validPolicy(data.planPolicy) && data.assignedPlans === data.imported &&
        data.planPolicy.version === command.planVersion + (data.imported > 0 ? 1 : 0);
    }
  };
}

export const cardPlanAdminScript = '(' + createCardPlanAdmin.toString() + ')';
export const cardPlanLabels = labels;
