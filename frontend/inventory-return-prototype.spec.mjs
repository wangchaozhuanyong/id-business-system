import assert from 'node:assert/strict';
import * as inventoryList from '../modules/inventory/list.mjs';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { URL } from 'node:url';
import test from 'node:test';

const source = await readFile(new URL('./inventory-prototype.js', import.meta.url), 'utf8');
const decode = (text = '') =>
  text.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&amp;', '&');
const escape = (text = '') =>
  String(text).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
const attributes = (html) =>
  Object.fromEntries(
    [...html.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map((match) => [
      match[1],
      decode(match[2] ?? '')
    ])
  );

// The VM runs the actual module with fictional assets. Only this source copy
// exposes private command functions; no runtime API or website is changed.
function runtime(kind = 'account') {
  let sequence = 0,
    opened = null,
    activeForm = null,
    pendingConfirm = null;
  const notices = [],
    errors = new Map(),
    selections = new Map(),
    summary = { textContent: '' },
    submit = { disabled: false },
    drawer = {
      close() {
        activeForm = null;
      }
    };
  const assets = Array.from({ length: 12 }, (_, index) => ({
    id: kind + '-' + (index + 1),
    type: kind === 'mail' ? 'google' : 'gpt',
    email: kind + '.' + (index + 1) + '@example.test',
    password: 'Fictional-Only',
    status: '正常',
    health: 'normal',
    used: false,
    version: 1
  }));
  const api = {
    state: {
      drafts: new Map(),
      actor: { id: 'actor-1', name: '演示测试员', role: 'admin' },
      route: 'workspace/extractions'
    },
    collections: {
      accounts: kind === 'account' ? assets : [],
      mailboxes: kind === 'mail' ? assets : []
    },
    modules: {},
    esc: escape,
    icon: () => '',
    button: (label, action, _kind, _icon, extra = '') =>
      '<button data-action="' + action + '" ' + extra + '>' + label + '</button>',
    tag: (label) => '<span>' + label + '</span>',
    textAction: (label) => label,
    options: (choices, selected) =>
      choices
        .map((choice) => {
          const [value, label] = Array.isArray(choice) ? choice : [choice, choice];
          return (
            '<option value="' +
            escape(value) +
            '" ' +
            (value === selected ? 'selected' : '') +
            '>' +
            escape(label) +
            '</option>'
          );
        })
        .join(''),
    input: (id, value = '') =>
      '<input id="' + id + '" name="' + id + '" value="' + escape(value) + '" />',
    select: (id, choices, selected) =>
      '<select id="' + id + '" name="' + id + '">' + api.options(choices, selected) + '</select>',
    field: (label, id, control) =>
      '<div class="field"><label for="' + id + '">' + label + '</label>' + control + '</div>',
    header: () => '',
    summary: () => '',
    empty: () => '',
    table: (columns, rows) =>
      '<table><tbody>' +
      rows
        .map(
          (row) =>
            '<tr>' +
            columns
              .map(
                (column) =>
                  '<td>' + (column.render ? column.render(row) : escape(row[column.id])) + '</td>'
              )
              .join('') +
            '</tr>'
        )
        .join('') +
      '</tbody></table>',
    pagination: () => '',
    pageRows: (rows) => rows,
    newId: (prefix) => prefix + '-' + ++sequence,
    nowText: () => '2026-11-04 10:30',
    getSelection: (key) => {
      if (!selections.has(key)) selections.set(key, new Set());
      return selections.get(key);
    },
    readDraft: (form) => api.readForm(form),
    readForm: (form) => {
      if (form.raw) return { ...form.raw };
      const data = new globalThis.FormData();
      for (const checkbox of form.boxes)
        if (checkbox.checked && !checkbox.disabled) data.append(checkbox.name, checkbox.value);
      data.append('inventory-return-reason', form.reason);
      data.append('inventory-return-notes', form.notes);
      return Object.fromEntries(data.entries());
    },
    openDrawer: (title, description, body, footer, context) => {
      opened = { title, description, body, footer, context };
      const formAttributes = attributes(body.match(/<form ([^>]*)>/)[1]);
      const boxes = [...body.matchAll(/<input ([^>]*)\/?>/g)]
        .map((match) => attributes(match[1]))
        .filter((attrs) => attrs.type === 'checkbox')
        .map((attrs) => ({
          id: attrs.id,
          name: attrs.name,
          value: attrs.value,
          disabled: Object.hasOwn(attrs, 'disabled'),
          checked: Object.hasOwn(attrs, 'checked')
        }));
      const reasonHtml = body.match(
        /<select[^>]*name="inventory-return-reason"[^>]*>(.*?)<\/select>/s
      )[1];
      const reasonOptions = [...reasonHtml.matchAll(/<option ([^>]*)>(.*?)<\/option>/g)].map(
        (match) => ({ ...attributes(match[1]), label: match[2] })
      );
      activeForm = {
        id: 'inventory-return-form',
        dataset: { inventoryDraft: formAttributes['data-inventory-draft'] },
        boxes,
        reason: (
          reasonOptions.find((option) => Object.hasOwn(option, 'selected')) || reasonOptions[0]
        ).value,
        notes: decode(
          body.match(/<textarea[^>]*name="inventory-return-notes"[^>]*>(.*?)<\/textarea>/s)[1]
        ),
        querySelectorAll: (selector) =>
          selector.includes(':not(:disabled)') ? boxes.filter((box) => !box.disabled) : boxes
      };
      for (const box of boxes) box.form = activeForm;
      submit.disabled = /type="submit" disabled/.test(footer);
      api.state.drawerContext = context;
    },
    notify: (message) => notices.push(message),
    setError: (id, message) => errors.set(id, message),
    confirmAction: (title, message, callback) => {
      pendingConfirm = { title, message, callback };
    },
    render() {},
    go() {},
    closeDrawer: () => drawer.close()
  };
  const document = {
    querySelectorAll: () => (activeForm ? [activeForm] : []),
    querySelector: (selector) =>
      selector === '#drawer' ? drawer : selector.startsWith('button[form=') ? submit : activeForm,
    getElementById: (id) =>
      id === 'inventory-return-form'
        ? activeForm
        : id === 'inventory-return-summary'
          ? summary
          : null
  };
  const modules = [];
  const vmSource = source.replace(
    '  api.modules.inventory = {',
    '  api.modules.returnTest = {createBatch,requestReturn,submitReturn,updateReturnSelection,' +
      'returnRecords,batches,consume,extractionBatchNumbers,skipSeed(){initialized=true;}};\n  api.modules.inventory = {'
  );
  assert.notEqual(vmSource, source, 'VM test export injection point must exist');
  runInNewContext(vmSource, {
    window: { IDInventoryList: inventoryList, IDDesignAPI: api, IDDesignModules: modules },
    document
  });
  const T = api.modules.returnTest;
  T.skipSeed();
  const batch = T.createBatch(kind, assets.slice(0, 10), '业务备用', '演示批次');
  const claims = batch.items.map((item) => ({ batch, item }));
  return {
    api,
    T,
    assets,
    batch,
    claims,
    notices,
    errors,
    summary,
    submit,
    module: modules[0],
    opened: () => opened,
    form: () => activeForm,
    pending: () => pendingConfirm,
    resetConfirm: () => {
      pendingConfirm = null;
    },
    confirm: () => {
      assert.ok(pendingConfirm, 'a confirmation must be pending');
      const callback = pendingConfirm.callback;
      pendingConfirm = null;
      callback();
    },
    choose: (indexes) => {
      const chosen = new Set(indexes);
      activeForm.boxes.forEach((box, index) => {
        box.checked = chosen.has(index);
      });
      T.updateReturnSelection(activeForm);
    }
  };
}

test('同日提取批次顺序编号，新增批次后保留历史短号与原领用关联', () => {
  const { T, batch, assets } = runtime('mail');
  const next = T.createBatch('mail', [assets[10]], '注册 Claude');
  const nextDay = T.createBatch('mail', [assets[11]], '注册 Claude', '', undefined, '2026-11-05 10:30');
  const numbers = T.extractionBatchNumbers();
  assert.equal(numbers.get(batch.id), 'hd261104-01');
  assert.equal(numbers.get(next.id), 'hd261104-02');
  assert.equal(numbers.get(nextDay.id), 'hd261105-01');
  assert.equal(assets[0].claimBatchId, batch.id);
});

for (const kind of ['account', 'mail']) {
  test(
    (kind === 'account' ? '账号' : '邮箱') + '提取10条只归还所勾4条，保留其余6条领用及原历史',
    () => {
      const r = runtime(kind);
      r.T.requestReturn(r.claims, [], false);
      assert.equal(r.form().boxes.filter((box) => box.checked).length, 0);
      assert.equal(r.submit.disabled, true);
      r.choose([0, 2, 4, 7]);
      r.form().notes = '四条未使用，其他继续领用';
      assert.match(r.summary.textContent, /已选 4 条 \/ 可归还 10 条/);
      assert.equal(r.submit.disabled, false);
      r.T.submitReturn(r.form());
      assert.match(r.pending().message, /^4 条资料/);
      r.confirm();
      assert.equal(r.T.returnRecords.length, 4);
      assert.equal(r.batch.items.filter((item) => item.status === 'returned').length, 4);
      assert.equal(r.batch.items.filter((item) => item.status === 'pending').length, 6);
      for (let index = 0; index < 10; index++) {
        const returned = [0, 2, 4, 7].includes(index);
        assert.equal(r.assets[index].inventoryState, returned ? 'available' : 'claimed');
        assert.equal(r.assets[index].inventoryHistory.length, returned ? 2 : 1);
        assert.equal(r.batch.items[index].status, returned ? 'returned' : 'pending');
      }
      assert.equal(
        r.T.returnRecords.every((row) => row.notes === '四条未使用，其他继续领用'),
        true
      );
      assert.equal(r.T.batches.length, 1);
    }
  );
}

test('单条默认勾选；取消全部后禁止提交，成功只清当前候选草稿', () => {
  const r = runtime();
  r.T.requestReturn([r.claims[2]]);
  assert.equal(r.form().boxes[0].checked, true);
  const key = r.form().dataset.inventoryDraft;
  r.choose([]);
  r.T.submitReturn(r.form());
  assert.equal(r.pending(), null);
  assert.equal(r.submit.disabled, true);
  assert.match(r.notices.at(-1), /请勾选/);
  r.choose([0]);
  r.api.state.drafts.set('other-candidate', { notes: '保留' });
  r.T.submitReturn(r.form());
  const oldForm = r.form();
  r.confirm();
  assert.equal(r.T.returnRecords.length, 1);
  assert.equal(r.assets[2].inventoryState, 'available');
  assert.equal(r.api.state.drafts.has(key), false);
  assert.equal(r.api.state.drafts.has('other-candidate'), true);
  r.T.submitReturn(oldForm);
  assert.equal(r.pending(), null);
  assert.equal(r.T.returnRecords.length, 1);
});

test('不存在或重复的领用ID整次拒绝，不静默少处理；非法理由也不写记录', () => {
  const r = runtime();
  const base = {
    'inventory-return-choice-one': r.claims[0].item.id,
    'inventory-return-reason': '未使用'
  };
  for (const raw of [
    { ...base, 'inventory-return-choice-two': 'missing-claim' },
    { ...base, 'inventory-return-choice-two': r.claims[0].item.id }
  ]) {
    r.T.submitReturn({ raw });
    assert.equal(r.pending(), null);
    assert.match(r.notices.at(-1), /领用记录无效/);
  }
  r.T.submitReturn({ raw: { ...base, 'inventory-return-reason': '随意状态' } });
  assert.match(r.errors.get('inventory-return-reason'), /有效的归还理由/);
  assert.equal(r.T.returnRecords.length, 0);
  assert.equal(
    r.batch.items.every((item) => item.status === 'pending'),
    true
  );
});

test('选中资料提交前已使用则整次阻止；未选中的已使用资料不妨碍其他归还', () => {
  const r = runtime();
  r.T.consume(r.assets[0], r.claims[0].item, { kind: 'manual-use', label: '已实际交付' });
  r.T.requestReturn(r.claims, [], false);
  assert.equal(r.form().boxes[0].disabled, true);
  assert.equal(r.form().boxes[0].checked, false);
  r.choose([1, 2, 3, 4]);
  r.T.submitReturn(r.form());
  r.confirm();
  assert.equal(r.T.returnRecords.length, 4);
  assert.equal(r.assets[0].inventoryState, 'used');
  assert.equal(r.claims[0].item.status, 'used');
  assert.equal(r.batch.items.filter((item) => item.status === 'pending').length, 5);

  const later = runtime();
  later.T.requestReturn(later.claims, [], false);
  later.choose([0, 1]);
  later.T.consume(later.assets[0], later.claims[0].item, { kind: 'manual-use' });
  later.T.submitReturn(later.form());
  assert.equal(later.pending(), null);
  assert.equal(later.T.returnRecords.length, 0);
  assert.equal(later.assets[1].inventoryState, 'claimed');
  assert.match(later.notices.at(-1), /状态已变化/);
});

test('二次确认期间出现任务或其他批次占用，全部停止，不先归还其他选中项', () => {
  for (const change of [
    (r) => {
      r.claims[1].item.taskId = 'new-task';
    },
    (r) => {
      r.assets[1].claimId = 'another-claim';
    }
  ]) {
    const r = runtime();
    r.T.requestReturn(r.claims, [], false);
    r.choose([0, 1]);
    r.T.submitReturn(r.form());
    assert.ok(r.pending());
    change(r);
    r.confirm();
    assert.equal(r.T.returnRecords.length, 0);
    assert.equal(r.assets[0].inventoryState, 'claimed');
    assert.equal(r.batch.items[0].status, 'pending');
    assert.match(r.notices.at(-1), /后续业务关联/);
  }
});

test('草稿按候选集合隔离，重排可恢复选择；全不选和理由备注也恢复', () => {
  const r = runtime();
  r.api.state.drafts.set('inventory-return', {
    'inventory-claim-ids': 'old-claim',
    'inventory-return-reason': '死号'
  });
  r.T.requestReturn(r.claims, [], false);
  const key = r.form().dataset.inventoryDraft;
  assert.equal(r.form().reason, '未使用');
  r.form().reason = '解封中';
  r.form().notes = '等待人工核对';
  r.choose([1, 3, 5, 9]);
  r.T.requestReturn([...r.claims].reverse(), [], true);
  assert.equal(r.form().dataset.inventoryDraft, key);
  assert.equal(r.form().boxes.filter((box) => box.checked).length, 4);
  assert.equal(r.form().reason, '解封中');
  assert.equal(r.form().notes, '等待人工核对');
  const selectedIds = new Set([1, 3, 5, 9].map((index) => r.claims[index].item.id));
  assert.equal(
    r
      .form()
      .boxes.filter((box) => box.checked)
      .every((box) => selectedIds.has(box.value)),
    true
  );

  r.T.requestReturn([r.claims[0]], [], false);
  assert.notEqual(r.form().dataset.inventoryDraft, key);
  assert.equal(r.form().boxes[0].checked, false);
  assert.equal(r.form().reason, '未使用');
  r.T.requestReturn(r.claims, [], true);
  r.choose([]);
  r.T.requestReturn(r.claims, [], true);
  assert.equal(
    r.form().boxes.some((box) => box.checked),
    false
  );
  assert.equal(r.form().reason, '解封中');
  assert.equal(r.form().notes, '等待人工核对');
  assert.equal(r.submit.disabled, true);
});

test('每条复选框使用独立名称，经真实FormData保留多个ID；全选和清空同步数量', () => {
  const r = runtime();
  r.T.requestReturn(r.claims, [{ email: 'missing@example.test', reason: '未找到资料' }], false);
  assert.equal(r.form().boxes.length, 11);
  assert.equal(new Set(r.form().boxes.map((box) => box.name)).size, 11);
  assert.equal(r.form().boxes.at(-1).disabled, true);
  r.module.onClick('inventory-return-all', { dataset: {} });
  assert.equal(r.form().boxes.filter((box) => box.checked).length, 10);
  assert.match(r.summary.textContent, /已选 10 条 \/ 可归还 10 条，1 条被阻止/);
  const serialized = r.api.readForm(r.form());
  assert.equal(
    Object.keys(serialized).filter((key) => key.startsWith('inventory-return-choice-')).length,
    10
  );
  assert.equal(
    new Set(
      Object.entries(serialized)
        .filter(([key]) => key.startsWith('inventory-return-choice-'))
        .map(([, value]) => value)
    ).size,
    10
  );
  r.module.onClick('inventory-return-clear', { dataset: {} });
  assert.equal(
    r.form().boxes.some((box) => box.checked),
    false
  );
  assert.equal(r.submit.disabled, true);
});

test('批次入口默认不勾选，单项入口仅勾选目标，不复用外层选择集合', () => {
  const r = runtime();
  r.api.getSelection('inventory-claims').add(r.claims[0].item.id);
  r.module.onClick('inventory-batch-return', { dataset: { id: r.batch.id } });
  assert.equal(r.form().boxes.length, 10);
  assert.equal(
    r.form().boxes.some((box) => box.checked),
    false
  );
  r.module.onClick('inventory-item-return', { dataset: { id: r.claims[4].item.id } });
  assert.equal(r.form().boxes.length, 1);
  assert.equal(r.form().boxes[0].value, r.claims[4].item.id);
  assert.equal(r.form().boxes[0].checked, true);
  assert.equal(r.api.getSelection('inventory-claims').has(r.claims[0].item.id), true);
});
