import { describe, expect, it } from 'vitest';
import view from './V2OptionsView.vue?raw';
import pageState from './useOptionsPage.ts?raw';
import categoryRail from './components/V2OptionsCategoryRail.vue?raw';
import list from './components/V2OptionsList.vue?raw';
import overview from './components/V2OptionsOverview.vue?raw';
import toolbar from './components/V2OptionsToolbar.vue?raw';
import fixture from '../../testing/V2OptionsDesignFixture.vue?raw';

describe('options scheme 3 redesign contract', () => {
  it('composes the overview, category rail, filters and list around the existing dialogs', () => {
    expect(view).toContain('<V2OptionsOverview :page="page" />');
    expect(view).toContain('<V2OptionsCategoryRail :page="page" />');
    expect(view).toContain('<V2OptionsToolbar :page="page" />');
    expect(view).toContain('<V2OptionsList :page="page" />');
    expect(view).toContain('<V2OptionFormDrawer');
    expect(view).toContain('<V2ConfirmDialog');
    expect(view).toContain('const page = reactive(useOptionsPage())');
  });

  it('preserves category switching, filters and all write actions', () => {
    expect(categoryRail).toContain('@click="page.handleTypeChange(definition.type)"');
    expect(toolbar).toContain('page.query.keyword');
    expect(toolbar).toContain('page.query.status');
    expect(toolbar).toContain('@click="page.handleSearch"');
    expect(toolbar).toContain('@click="page.resetFilters"');
    expect(overview).toContain('@click="page.handleRefresh"');
    expect(overview).toContain('@click="page.openCreate"');
    expect(list).toContain('@click="page.openEdit(row)"');
    expect(list).toContain('@click="page.openDelete(row)"');
  });

  it('keeps column settings inline and a stable scroll-table frame', () => {
    const settingsIndex = list.indexOf('<V2TableColumnSettings');
    const pageCountIndex = list.indexOf('本页 {{ page.items.length }} 条');
    expect(settingsIndex).toBeGreaterThan(-1);
    expect(pageCountIndex).toBeGreaterThan(settingsIndex);
    expect(list).toContain(':show-column-settings="false"');
    expect(list).toContain('useV2StableListFrame');
    expect(list).toContain(':view-key="page.renderedType"');
    expect(list).not.toContain('v2-options-mobile-list');
  });

  it('keeps the existing cross-module refresh boundary after option mutations', () => {
    expect(pageState).toContain('idBusinessV2OptionsApi.create');
    expect(pageState).toContain('idBusinessV2OptionsApi.update');
    expect(pageState).toContain('idBusinessV2OptionsApi.remove');
    expect(pageState).toContain('void loadOptions(true)');
  });

  it('keeps space between the overview and workspace inside the async region', () => {
    expect(view).toContain('<div class="v2-options-page__content">');
    expect(fixture).toContain('<div class="v2-options-page__content">');
  });
});
