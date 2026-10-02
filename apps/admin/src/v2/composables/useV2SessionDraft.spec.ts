import { effectScope, nextTick, reactive, ref, watch } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const identity = vi.hoisted(() => ({ epoch: 0, changed: () => {} }));
vi.mock('@/auth/sessionCoordinator', () => ({
  sessionCoordinator: {
    get identityEpoch() {
      return { value: identity.epoch };
    },
    subscribeIdentityChange: (listener: () => void) => (identity.changed = listener)
  }
}));

import { clearV2SessionDrafts, useV2FormDraft, useV2SessionDraft } from './useV2SessionDraft';

beforeEach(clearV2SessionDrafts);

describe('会话内草稿保留', () => {
  it('页面卸载后恢复输入，且不同功能互不覆盖', () => {
    const scope = effectScope();
    const state = scope.run(() => useV2SessionDraft('first', () => ({ text: ref('') })))!;
    state.text.value = '尚未保存';
    scope.stop();
    expect(useV2SessionDraft('first', () => ({ text: ref('') })).text.value).toBe('尚未保存');
    expect(useV2SessionDraft('second', () => ({ text: ref('') })).text.value).toBe('');
  });

  it('同一功能按新增和不同资料分别恢复，并保留修改前快照', () => {
    const scope = effectScope();
    const draft = scope.run(() => useV2FormDraft('reply', () => ({ title: '', content: '' })))!;
    draft.open('create');
    draft.form.title = '新增草稿';
    draft.open('existing', { title: '原题', content: '原文' });
    draft.form.content = '修改草稿';
    draft.open('another', { title: '另一条', content: '独立内容' });
    draft.form.content = '另一个草稿';
    scope.stop();

    const nextScope = effectScope();
    const restored = nextScope.run(() =>
      useV2FormDraft('reply', () => ({ title: '', content: '' }))
    )!;
    restored.open('existing', { title: '原题', content: '原文' });
    expect(restored.form.content).toBe('修改草稿');
    expect(JSON.parse(restored.original.value)).toEqual({ title: '原题', content: '原文' });
    restored.open('create');
    expect(restored.form.title).toBe('新增草稿');
    restored.open('another');
    expect(restored.form.content).toBe('另一个草稿');
    nextScope.stop();
  });

  it('保存成功只清理当前资料，其他未保存草稿仍可恢复', () => {
    const scope = effectScope();
    const draft = scope.run(() => useV2FormDraft('editor', () => ({ text: '' })))!;
    draft.open('a');
    draft.form.text = '保留';
    draft.open('b');
    draft.form.text = '已提交';
    draft.beginSave()();
    draft.open('b', { text: '服务端新值' });
    expect(draft.form.text).toBe('服务端新值');
    draft.open('a');
    expect(draft.form.text).toBe('保留');
    scope.stop();
  });

  it('登录身份改变时不把旧账号的输入交给新账号', () => {
    useV2SessionDraft('settings', () => ({ text: ref('') })).text.value = '旧身份草稿';
    identity.epoch += 1;
    identity.changed();
    expect(useV2SessionDraft('settings', () => ({ text: ref('') })).text.value).toBe('');
  });

  it('旧页面的迟到保存结果不能清除回访后继续编辑的草稿', () => {
    const firstScope = effectScope();
    const first = firstScope.run(() => useV2FormDraft('pending', () => ({ text: '' })))!;
    first.open('a');
    first.form.text = '正在保存的内容';
    const completeFirstSave = first.beginSave();
    firstScope.stop();
    const nextScope = effectScope();
    const next = nextScope.run(() => useV2FormDraft('pending', () => ({ text: '' })))!;
    next.open('a');
    next.form.text = '继续编辑的内容';
    completeFirstSave();
    next.open('a');
    expect(next.form.text).toBe('继续编辑的内容');
    nextScope.stop();
  });

  it('保存成功只清理已提交快照，保存期间的后续输入继续保留', () => {
    const scope = effectScope();
    const draft = scope.run(() => useV2FormDraft('saving', () => ({ text: '' })))!;
    draft.open('a');
    draft.form.text = '提交的内容';
    const completeSave = draft.beginSave();
    draft.form.text = '保存期间继续填写';
    completeSave();
    draft.form.text += '，继续保留';
    scope.stop();
    const nextScope = effectScope();
    const next = nextScope.run(() => useV2FormDraft('saving', () => ({ text: '' })))!;
    next.open('a');
    expect(next.form.text).toBe('保存期间继续填写，继续保留');
    nextScope.stop();
  });

  it('切换编辑记录后，上一条保存成功不清理当前记录的输入', () => {
    const scope = effectScope();
    const draft = scope.run(() => useV2FormDraft('saving', () => ({ text: '' })))!;
    draft.open('a');
    draft.form.text = '第一条提交内容';
    const completeSave = draft.beginSave();
    draft.open('b');
    draft.form.text = '第二条未提交内容';
    completeSave();
    draft.open('a', { text: '第一条保存后资料' });
    expect(draft.form.text).toBe('第一条保存后资料');
    draft.open('b');
    expect(draft.form.text).toBe('第二条未提交内容');
    scope.stop();
  });
  it('搜索、筛选、排序和分页整体恢复，显式重置仍可更新共享状态', () => {
    const first = useV2SessionDraft('filters', () =>
      reactive({ keyword: '', status: '', page: 1, sort: 'newest' })
    );
    Object.assign(first, { keyword: '未提交搜索', status: 'active', page: 3, sort: 'oldest' });
    const returned = useV2SessionDraft('filters', () =>
      reactive({ keyword: '', status: '', page: 1, sort: 'newest' })
    );
    expect(returned).toBe(first);
    expect(returned).toEqual({ keyword: '未提交搜索', status: 'active', page: 3, sort: 'oldest' });
    returned.keyword = '';
    returned.page = 1;
    expect(first.keyword).toBe('');
    expect(first.page).toBe(1);
  });

  it('恢复旧草稿保留原资料版本，成功保存后新编辑采用最新版本', () => {
    const scope = effectScope();
    const draft = scope.run(() => useV2FormDraft('versioned', () => ({ text: '' })))!;
    draft.open('a', { text: '旧服务端值' }, 'version-1');
    draft.form.text = '未提交编辑';
    draft.open('a', { text: '别人保存的新值' }, 'version-2');
    expect(draft.form.text).toBe('未提交编辑');
    expect(draft.version.value).toBe('version-1');
    expect(draft.beginSave()()).toBe(true);
    draft.open('a', { text: '已核对新资料' }, 'version-3');
    expect(draft.version.value).toBe('version-3');
    scope.stop();
  });

  it('恢复期间跳过字段联动，下一次用户编辑仍触发联动', async () => {
    const scope = effectScope();
    const draft = scope.run(() => useV2FormDraft('dependent', () => ({ kind: '', amount: '' })))!;
    draft.open('a');
    draft.form.kind = 'manual';
    draft.form.amount = '123';
    await nextTick();
    scope.run(() =>
      watch(
        () => draft.form.kind,
        () => {
          if (!draft.restoring.value) draft.form.amount = '';
        }
      )
    );
    draft.open('b', { kind: 'auto', amount: '99' });
    await nextTick();
    draft.open('a');
    await nextTick();
    expect(draft.form.amount).toBe('123');
    draft.form.kind = 'other';
    await nextTick();
    expect(draft.form.amount).toBe('');
    scope.stop();
  });
});
