import { effectScope, ref } from 'vue';
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
    draft.complete();
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
    firstScope.stop();
    const nextScope = effectScope();
    const next = nextScope.run(() => useV2FormDraft('pending', () => ({ text: '' })))!;
    next.open('a');
    next.form.text = '继续编辑的内容';
    first.complete();
    next.open('a');
    expect(next.form.text).toBe('继续编辑的内容');
    nextScope.stop();
  });
});
