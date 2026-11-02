import { h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it, vi } from 'vitest';
import V2AsyncRegion from './V2AsyncRegion.vue';

describe('V2AsyncRegion activation and access', () => {
  it('renders no feedback or business content for an inactive query', async () => {
    const slot = vi.fn(() => h('p', '受限内容'));
    const html = await renderToString(
      h(
        V2AsyncRegion,
        { phase: 'disabled', error: '上次错误', empty: true, loadingTitle: '正在加载' },
        { default: slot }
      )
    );
    expect(html).not.toContain('<section');
    expect(html).not.toContain('权限不足');
    expect(html).not.toContain('正在加载');
    expect(html).not.toContain('上次错误');
    expect(slot).not.toHaveBeenCalled();
  });

  it.each(['disabled', 'initial-loading', 'ready'] as const)(
    'keeps explicit permission denial authoritative during %s',
    async (phase) => {
      const slot = vi.fn(() => h('p', '受限内容'));
      const html = await renderToString(
        h(V2AsyncRegion, { phase, forbidden: true, loadingTitle: '正在加载' }, { default: slot })
      );
      expect(html).toContain('权限不足');
      expect(html).not.toContain('正在加载');
      expect(slot).not.toHaveBeenCalled();
    }
  );

  it.each(['idle', 'initial-loading'] as const)(
    'shows loading feedback without rendering content during %s',
    async (phase) => {
      const slot = vi.fn(() => h('p', '业务资料'));
      const html = await renderToString(
        h(V2AsyncRegion, { phase, loadingTitle: '正在加载' }, { default: slot })
      );
      expect(html).toContain('正在加载');
      expect(html).not.toContain('权限不足');
      expect(slot).not.toHaveBeenCalled();
    }
  );
});
