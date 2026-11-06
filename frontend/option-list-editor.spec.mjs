import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { URL } from 'node:url';
import test from 'node:test';

const core = await readFile(new URL('./prototype.js', import.meta.url), 'utf8');
const css = await readFile(new URL('./prototype.css', import.meta.url), 'utf8');
const fragment = (start, end) => {
  const from = core.indexOf(start),
    to = core.indexOf(end, from);
  assert(from >= 0 && to > from, `共享函数边界缺失：${start}`);
  return core.slice(from, to);
};
const sharedSource = [
  fragment('const escapeHtml =', 'const icons ='),
  fragment('function button(', 'const navigation ='),
  fragment('function readOptionList(', 'function readDraft(')
].join('\n');

const decode = (value = '') =>
  value.replace(
    /&(quot|amp|lt|gt|#39);/g,
    (_, entity) =>
      ({
        quot: '"',
        amp: '&',
        lt: '<',
        gt: '>',
        '#39': "'"
      })[entity]
  );
function attribute(tag, name) {
  return decode(tag.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))?.[1] || '');
}

// A small DOM double only models the nodes these real helpers read and replace.
// It is serialization/action coverage, not layout, focus-ring or browser proof.
function runtime(config = {}) {
  let current,
    html = '',
    draftCalls = 0,
    drawerCalls = 0,
    focusCalls = 0;
  const notices = [];
  const context = createContext({
    icon: () => '',
    notify: (message) => notices.push(message),
    state: { drawerContext: 'option-settings-test' },
    window: { IDDesignModules: [{ preserveDraft: () => draftCalls++ }] },
    preserveDrawerDraft: () => drawerCalls++,
    document: { getElementById: () => current?.pending },
    $: (selector, editor) => editor.querySelector(selector)
  });
  const api = runInContext(
    `${sharedSource}\n({ readOptionList, optionListEditor, optionListPending, changeOptionList })`,
    context
  );
  function install(markup) {
    html = markup;
    const opening = markup.match(/<section\b[^>]*>/)[0];
    const serialized = attribute(opening, 'data-option-config');
    const descriptor = JSON.parse(serialized);
    const inputs = [...markup.matchAll(/<input\b[^>]*>/g)].map(([tag]) => ({
      name: attribute(tag, 'name'),
      value: attribute(tag, 'value'),
      tag
    }));
    const hidden = inputs.find((input) => input.name === descriptor.id);
    const editing = inputs.find((input) => input.name === `${descriptor.id}-editing`);
    const inputTag = inputs.find((input) => /\bdata-option-input\b/.test(input.tag));
    const selectTag = markup.match(/<select\b[^>]*data-option-input[^>]*>([\s\S]*?)<\/select>/);
    const selectOptions = selectTag ? [...selectTag[1].matchAll(/<option\b([^>]*)>/g)] : [];
    const selected =
      selectOptions.find((match) => /\bselected\b/.test(match[1])) || selectOptions[0];
    const pending = {
      value: inputTag?.value ?? (selected ? attribute(selected[1], 'value') : ''),
      attributes: {},
      focus: () => focusCalls++,
      setAttribute(name, value) {
        this.attributes[name] = value;
      }
    };
    const message = { textContent: '' };
    current = {
      dataset: { optionConfig: serialized },
      hidden,
      editing,
      pending,
      message,
      querySelector(selector) {
        if (selector === '[data-option-input]') return pending;
        if (selector === `input[name="${descriptor.id}"]`) return hidden;
        if (selector === 'input[name$="-editing"]') return editing;
        if (selector === `#${descriptor.id}-error`) return message;
        return null;
      },
      set outerHTML(next) {
        install(next);
      }
    };
  }
  install(
    api.optionListEditor({
      id: 'test-options',
      label: '测试配置',
      itemLabel: '项目',
      values: ['A', 'B'],
      ...config
    })
  );
  return {
    api,
    notices,
    get editor() {
      return current;
    },
    get html() {
      return html;
    },
    get items() {
      return JSON.parse(current.hidden.value);
    },
    get calls() {
      return { drafts: draftCalls, drawer: drawerCalls, focus: focusCalls };
    },
    form: () => ({ querySelectorAll: () => [current] }),
    act(action, index) {
      api.changeOptionList(action, {
        dataset: { index: index === undefined ? undefined : String(index) },
        closest: () => current
      });
    }
  };
}

test('真实解析器支持JSON数组与旧分隔文本，拒绝非字符串项目和破损JSON', () => {
  const { api } = runtime();
  assert.deepEqual(Array.from(api.readOptionList('[" 美国 ","日本"]')), ['美国', '日本']);
  assert.deepEqual(Array.from(api.readOptionList('美国、 日本,马来西亚\n新加坡')), [
    '美国',
    '日本',
    '马来西亚',
    '新加坡'
  ]);
  assert.deepEqual(Array.from(api.readOptionList(null)), []);
  for (const input of [{}, 1, [1], [null], '[1]', '[null]', '["bad"'])
    assert.throws(() => api.readOptionList(input));
});

test('完整输出全部列表项、转义内容，不回退textarea或小型内部滚动框', () => {
  const values = Array.from({ length: 24 }, (_, i) => `第${i + 1}项`);
  values[3] = '<script>示例 & 测试</script>';
  const r = runtime({ values });
  assert.equal((r.html.match(/class="option-item /g) || []).length, 24);
  assert.match(r.html, /&lt;script&gt;示例 &amp; 测试&lt;\/script&gt;/);
  assert(!r.html.includes('<textarea'));
  for (const selector of ['option-list', 'option-editor']) {
    const rule = css.match(new RegExp(`\\.${selector}\\s*\\{([^}]+)\\}`))[1];
    assert(!/(?:^|;)\s*(?:height|max-height)\s*:|overflow(?:-y)?\s*:\s*(?:auto|scroll)/.test(rule));
  }
});

test('输入添加会写回真实JSON并登记草稿，空白、重复和多行输入不改列表', () => {
  const r = runtime();
  r.editor.pending.value = ' C ';
  r.act('option-add');
  assert.deepEqual(r.items, ['A', 'B', 'C']);
  assert.equal(r.editor.pending.value, '');
  assert.equal(r.calls.drafts, 1);
  assert.equal(r.calls.drawer, 1);
  for (const value of ['a', ' ', 'D\nE']) {
    r.editor.pending.value = value;
    r.act('option-add');
    assert.deepEqual(r.items, ['A', 'B', 'C']);
    assert(r.editor.message.textContent);
    assert.equal(r.editor.pending.attributes['aria-invalid'], 'true');
  }
});

test('受控选择添加仅接受已有选项，已添加项目不重复出现在候选中', () => {
  const r = runtime({ values: ['Go'], choices: ['Go', 'Plus', 'Pro 5x'] });
  assert(!r.html.includes('<option value="Go"'));
  assert(r.html.includes('<option value="Plus"'));
  r.editor.pending.value = 'Plus';
  r.act('option-add');
  assert.deepEqual(r.items, ['Go', 'Plus']);
  r.editor.pending.value = 'Pro';
  r.act('option-add');
  assert.deepEqual(r.items, ['Go', 'Plus']);
  assert.match(r.editor.message.textContent, /已有项目/);
});

test('编辑、保存、取消与移除保持列表顺序，移除前项会调整正在编辑的索引', () => {
  const r = runtime({ values: ['A', 'B', 'C'] });
  r.act('option-edit', 1);
  assert.equal(r.editor.pending.value, 'B');
  assert.equal(r.editor.editing.value, '1');
  r.editor.pending.value = 'B-new';
  r.act('option-add');
  assert.deepEqual(r.items, ['A', 'B-new', 'C']);
  r.act('option-edit', 2);
  r.editor.pending.value = '未保存';
  r.act('option-cancel');
  assert.deepEqual(r.items, ['A', 'B-new', 'C']);
  assert.equal(r.editor.pending.value, '');
  r.act('option-edit', 2);
  r.act('option-remove', 0);
  assert.deepEqual(r.items, ['B-new', 'C']);
  assert.equal(r.editor.editing.value, '1');
  assert.equal(r.editor.pending.value, 'C');
  r.act('option-remove', 1);
  assert.deepEqual(r.items, ['B-new']);
  assert.equal(r.editor.pending.value, '');
});

test('有未添加输入时不跳去编辑其他项，待添加或编辑状态会阻止整表提交', () => {
  const r = runtime();
  assert.equal(r.api.optionListPending(r.form()), false);
  r.editor.pending.value = '尚未添加';
  r.act('option-edit', 1);
  assert.equal(r.editor.editing.value, '');
  assert.match(r.notices.at(-1), /先添加当前输入/);
  assert.equal(r.api.optionListPending(r.form()), true);
  r.editor.pending.value = '';
  r.act('option-edit', 0);
  r.editor.pending.value = '';
  assert.equal(r.api.optionListPending(r.form()), true);
  r.act('option-cancel');
  assert.equal(r.api.optionListPending(r.form()), false);
});

test('最小数量、保留项和禁用模式均在命令层阻止修改或移除', () => {
  const minimum = runtime({ values: ['A'], minItems: 1 });
  minimum.act('option-remove', 0);
  assert.deepEqual(minimum.items, ['A']);
  const protectedList = runtime({
    values: ['127.0.0.1', '192.0.2.1'],
    protectedValues: ['127.0.0.1']
  });
  protectedList.act('option-edit', 0);
  assert.equal(protectedList.editor.editing.value, '');
  protectedList.act('option-remove', 0);
  assert.deepEqual(protectedList.items, ['127.0.0.1', '192.0.2.1']);
  const disabled = runtime({ disabled: true });
  disabled.editor.pending.value = 'C';
  for (const action of ['option-add', 'option-edit', 'option-remove', 'option-cancel'])
    disabled.act(action, 0);
  assert.deepEqual(disabled.items, ['A', 'B']);
  assert.equal(disabled.calls.drafts, 0);
});

test('恢复或异常编辑索引不能修改保留项，也不能写出稀疏数组', () => {
  const protectedList = runtime({
    values: ['127.0.0.1', '192.0.2.1'],
    protectedValues: ['127.0.0.1']
  });
  protectedList.editor.editing.value = '0';
  protectedList.editor.pending.value = '192.0.2.9';
  protectedList.act('option-add');
  assert.deepEqual(protectedList.items, ['127.0.0.1', '192.0.2.1']);
  for (const index of ['99', '-1', 'invalid']) {
    const r = runtime();
    r.editor.editing.value = index;
    r.editor.pending.value = 'C';
    r.act('option-add');
    assert.deepEqual(r.items, ['A', 'B']);
  }
});

test('所有列表操作按钮都明确type=button，编辑取消也不会误提交外层表单', () => {
  const r = runtime({ draft: { 'test-options-editing': '0', 'test-options-pending': 'A' } });
  const buttons = [...r.html.matchAll(/<button\b[^>]*>/g)].map(([tag]) => tag);
  assert(buttons.length >= 6);
  for (const tag of buttons) assert.match(tag, /\btype="button"/);
  assert.match(r.html, /data-action="option-cancel"/);
});
