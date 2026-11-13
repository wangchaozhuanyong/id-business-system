const labels = Object.freeze({ plus: 'Plus', pro100: 'Pro 100', pro200: 'Pro 200', pro500: 'Pro 500' });
const choices = Object.entries(labels).map(([value, label]) =>
  '<label class="card-plan-choice"><input type="checkbox" value="' + value + '"><span>' + label + '</span></label>').join('');

export const cardPlanImportFields = '<fieldset id="card_pool_import_plans" class="card-plan-options" disabled>' +
  '<legend>允许套餐</legend><div class="card-plan-grid">' + choices + '</div></fieldset>';

export const cardPlanToolbar = `
  <div class="card-plan-toolbar" aria-label="银行卡套餐规则" role="group">
    <button type="button" class="btn btn-secondary" id="card_plan_mode" aria-pressed="false" disabled>仅使用已设置套餐的卡</button>
    <button type="button" class="btn btn-secondary" id="card_plan_batch" disabled>批量设置套餐</button>
    <span id="card_plan_summary" role="status">正在读取套餐设置…</span>
  </div>
  <dialog class="card-plan-editor" id="card_plan_editor" aria-labelledby="card_plan_title" aria-describedby="card_plan_result">
    <form>
      <header class="card-plan-editor-header"><h3 id="card_plan_title">设置允许套餐</h3></header>
      <div class="card-plan-editor-body">
        <fieldset id="card_plan_options" class="card-plan-options">
          <legend>允许套餐</legend><div class="card-plan-grid">${choices}</div>
        </fieldset>
        <p id="card_plan_result" role="status"></p>
      </div>
      <footer class="card-plan-editor-actions">
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
  const summary = element('card_plan_summary');
  const dialog = element('card_plan_editor');
  const options = element('card_plan_options');
  const result = element('card_plan_result');
  const save = dialog.querySelector('[type="submit"]');
  const selected = new Set();
  let snapshot = null, rows = new Map(), editing = null, writing = false;

  function attachImportHelp() {
    for (const [title, hint, control] of [
      [element('card_pool_import_box')?.querySelector('.import-box-title'), element('card_pool_import_hint'), element('card_pool_import_text')],
      [document.querySelector('label[for="card_pool_import_type"]'), element('card_pool_import_type_hint'), element('card_pool_import_type')]
    ]) {
      if (!title || !hint || !window.IDTitleHelp) continue;
      window.IDTitleHelp.attach(title, hint);
      control?.setAttribute('aria-describedby', title.parentElement.querySelector('.title-description').id);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attachImportHelp, { once: true });
  else attachImportHelp();

  const readChoices = group => [...group.querySelectorAll('input:checked')].map(input => input.value);
  const setChoices = (group, values) => {
    for (const input of group.querySelectorAll('input')) input.checked = values.includes(input.value);
  };
  const validPolicy = value => Number.isSafeInteger(value?.version) && value.version >= 0 &&
    typeof value.strict === 'boolean';
  const readDraft = () => window.parent.IDRechargeDrafts?.read('admin') || {};
  const writeDraft = values => window.parent.IDRechargeDrafts?.write('admin', values);
  function rememberImport() {
    writeDraft({ ...readDraft(), card_pool_allowed_plans: readChoices(importFields).join(',') });
    onImportChange();
  }
  setChoices(importFields, String(readDraft().card_pool_allowed_plans || '').split(','));
  importFields.addEventListener('change', rememberImport);

  function paint() {
    batch.disabled = !snapshot || writing || selected.size === 0;
    batch.textContent = selected.size ? '设置所选 ' + selected.size + ' 张卡' : '批量设置套餐';
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
    const tail = /^\d{4}$/.test(card.last4) ? '尾号 ' + card.last4 : '编号 ' + id;
    return '<div class="card-plan-cell"><label class="card-plan-select"><input type="checkbox" data-card-plan-select value="' + id +
      '" aria-label="选择银行卡' + tail + '"></label>' +
      '<button type="button" class="btn btn-secondary" data-card-plan-edit="' + id +
      '" aria-haspopup="dialog" aria-label="设置银行卡' + tail + '的允许套餐">' +
      (allowed || '待核对') + '</button></div>';
  }

  function open(ids) {
    if (!snapshot || writing || ids.some(id => !rows.has(id))) return;
    const key = [...ids].sort((a, b) => a - b).join(',');
    let draft;
    try { draft = JSON.parse(readDraft().card_pool_plan_editor || 'null'); } catch { /* Invalid drafts are discarded. */ }
    editing = { ids, key, version: snapshot.version };
    result.textContent = ids.length > 1 ? '将替换这 ' + ids.length + ' 张卡的允许套餐。' : '';
    setChoices(options, draft?.key === key && Array.isArray(draft.plans) ? draft.plans :
      (ids.length === 1 ? rows.get(ids[0]).allowed_plans || [] : []));
    save.disabled = false;
    dialog.showModal();
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
    finally { writing = false; paint(); }
  });
  element('card_plan_cancel').addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => { if (writing) event.preventDefault(); });
  options.addEventListener('change', () => {
    if (editing) writeDraft({ ...readDraft(),
      card_pool_plan_editor: JSON.stringify({ key: editing.key, plans: readChoices(options) }) });
  });
  dialog.addEventListener('close', () => {
    editing = null;
  });
  dialog.querySelector('form').addEventListener('submit', async event => {
    event.preventDefault();
    if (writing || !editing) return;
    const allowedPlans = readChoices(options);
    if (!allowedPlans.length) { result.textContent = '请选择至少一个允许套餐。'; return; }
    const { ids, version } = editing;
    writing = true;
    save.disabled = true;
    element('card_plan_cancel').disabled = true;
    options.disabled = true;
    paint();
    try {
      await write({ version, cardIds: ids, allowedPlans });
      for (const id of ids) selected.delete(id);
      const draft = readDraft();
      delete draft.card_pool_plan_editor;
      writeDraft(draft);
      editing = null;
      dialog.close();
      notify('允许套餐已保存。', 'success');
    } catch (error) {
      result.textContent = error.message;
    } finally {
      writing = false;
      save.disabled = false;
      element('card_plan_cancel').disabled = false;
      options.disabled = false;
      paint();
    }
  });
  window.idRechargeCardPlansChanged = marker => {
    const version = Number(String(marker || '').split(':').at(-1));
    if (snapshot && Number.isSafeInteger(version) && version > snapshot.version && !writing &&
        !element('card_pool_import_btn').dataset.saving && window.idRechargeVisible !== false && !document.hidden &&
        element('cards')?.classList.contains('active') && tbody.checkVisibility())
      void loadCards();
  };
  return {
    accept, cell, paint,
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
