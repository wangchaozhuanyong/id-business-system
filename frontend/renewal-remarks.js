(() => {
  'use strict';
  const A = window.IDDesignAPI;
  const toolbox = window.IDLocalToolbox;
  if (!A || !toolbox) return;

  const prefix = 'renewal-remark-';
  const formId = 'renewal-remark-settings-form';
  const inputId = 'renewal-remark-settings-lines';
  const isTemplate = row => row.id.startsWith(prefix);
  const validRemark = value => Boolean(value) && value.length <= 160 &&
    !/[\p{Cc}\p{Cf}]/u.test(value) && !/(?:\d[ -]?){12}/.test(value);
  const activeTemplates = () => (toolbox.current()?.data.phrases || [])
    .filter(row => isTemplate(row) && !row.deleted);

  function fillPicker(picker, error = false) {
    const templates = activeTemplates();
    const placeholder = error ? '常用备注读取失败，可手动填写'
      : templates.length ? '请选择常用备注' : '暂无常用备注';
    picker.innerHTML = A.options([['', placeholder], ...templates.map(row => [row.id, row.text])], '');
    picker.disabled = templates.length === 0;
  }

  function picker(fieldId) {
    const id = fieldId + '-template';
    return A.field('常用备注', id, `<select id="${A.esc(id)}" data-renewal-remark-for="${A.esc(fieldId)}" disabled>
      <option>正在读取常用备注…</option></select>`);
  }

  function bind(form) {
    if (!form) return;
    for (const control of form.querySelectorAll('[data-renewal-remark-for]')) {
      control.addEventListener('change', () => {
        const template = activeTemplates().find(row => row.id === control.value);
        const input = form.elements.namedItem(control.dataset.renewalRemarkFor);
        control.value = '';
        if (!input || !template) return;
        input.value = template.text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
      });
      if (toolbox.current()) fillPicker(control);
      else toolbox.load().then(
        () => { if (control.isConnected) fillPicker(control); },
        () => { if (control.isConnected) fillPicker(control, true); }
      );
    }
  }

  function replaceTemplates(phrases, values) {
    const templates = phrases.filter(isTemplate);
    const matched = new Set();
    const active = values.map(text => {
      const existing = templates.find(row => row.text === text && !matched.has(row.id));
      const id = existing?.id || prefix + crypto.randomUUID();
      matched.add(id);
      return { ...existing, id, title: text.slice(0, 60), text, deleted: false };
    });
    const inactive = templates.filter(row => !matched.has(row.id)).map(row => ({ ...row, deleted: true }));
    phrases.splice(0, phrases.length, ...phrases.filter(row => !isTemplate(row)), ...active, ...inactive);
  }

  const savedLines = () => activeTemplates().map(row => row.text).join('\n');

  function showSettings() {
    const snapshot = toolbox.current();
    const draft = A.state.drafts.get(formId);
    const field = A.field('备注列表', inputId,
      `<textarea id="${inputId}" name="${inputId}" rows="8" spellcheck="false">${A.esc(draft?.[inputId] ?? savedLines())}</textarea>`,
      false, '每行一条，按填写顺序显示。单条最多 160 字，请勿填写账号凭据、银行卡号或验证码。');
    A.openDrawer('设置常用备注', '这些常用备注仅供当前登录账号选择。', `<form id="${formId}" data-protect-drawer-dismiss>
      ${field}<input type="hidden" name="renewal-remark-settings-version" value="${A.esc(draft?.['renewal-remark-settings-version'] ?? snapshot.version)}">
      <p class="field-error" role="alert" hidden></p>
      <button type="button" class="button" data-renewal-remark-reload hidden>读取已保存设置</button>
    </form>`, A.button('取消', 'drawer-close') +
      `<button type="submit" form="${formId}" class="button primary">保存常用备注</button>`, formId);
    const form = A.$('#' + formId);
    const dialog = form.closest('dialog');
    const saveButton = A.$(`[form="${formId}"][type="submit"]`, dialog);
    const input = form.elements.namedItem(inputId);
    const revision = form.elements.namedItem('renewal-remark-settings-version');
    const error = A.$('[role="alert"]', form);
    const reloadButton = A.$('[data-renewal-remark-reload]', form);
    const active = () => form.isConnected && dialog.open && A.state.drawerContext === formId;
    reloadButton.addEventListener('click', () => {
      A.confirmAction('读取已保存设置', '读取后会用当前保存的备注替换本次编辑。', async () => {
        try {
          await toolbox.load({ refresh: true });
          if (!active()) return;
          input.value = savedLines();
          revision.value = toolbox.current().version;
          error.hidden = reloadButton.hidden = true;
        } catch (failure) {
          if (!active()) return;
          error.textContent = failure.message;
          error.hidden = false;
        }
      }, '读取已保存设置');
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      event.stopPropagation();
      if (saveButton.disabled) return;
      const lines = input.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      const values = [...new Set(lines)];
      if (values.some(value => !validRemark(value))) {
        error.textContent = '每条备注最多 160 字，请检查内容和格式。';
        error.hidden = false;
        return;
      }
      const version = Number(revision.value);
      if (version === toolbox.current().version && values.join('\n') === savedLines()) {
        A.closeDrawer();
        A.state.drafts.delete(formId);
        return;
      }
      const feedback = A.beginActionFeedback(saveButton, '正在保存常用备注…');
      form.setAttribute('aria-busy', 'true');
      input.readOnly = true;
      error.hidden = reloadButton.hidden = true;
      try {
        await toolbox.save('phrases', version, phrases => replaceTemplates(phrases, values), '保存续费常用备注');
        if (feedback.current() && active()) {
          A.closeDrawer();
          A.state.drafts.delete(formId);
          A.notify('常用备注已保存', { kind: 'success' });
        }
      } catch (failure) {
        if (!feedback.current() || !active()) return;
        error.textContent = failure.message;
        error.hidden = false;
        reloadButton.hidden = failure.status !== 409;
      } finally {
        form.removeAttribute('aria-busy');
        input.readOnly = false;
        feedback.finish();
      }
    });
  }

  async function settings(node) {
    const { route, actor, drawerContext } = A.state;
    await A.withActionFeedback(node, async () => {
      await toolbox.load();
      if (node?.isConnected && A.state.route === route && A.state.actor?.id === actor?.id &&
          A.state.drawerContext === drawerContext) showSettings();
    }, { pending: '正在读取常用备注…', failure: '无法读取常用备注，请重试。' });
  }

  window.IDRenewalRemarks = Object.freeze({ isTemplate, settings, picker, bind });
})();
