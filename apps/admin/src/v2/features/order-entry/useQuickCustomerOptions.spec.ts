import { effectScope } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearV2QueryCache, invalidateV2Queries } from '@/v2/composables/useV2Query';
import type { V2OptionSelector } from './contracts';
import { idBusinessV2CustomersApi } from './api';
import { useQuickCustomerOptions } from './useQuickCustomerOptions';

function createOption(id: string, type: 'customer_source' | 'customer_tag'): V2OptionSelector {
  return {
    id,
    type,
    code: id,
    name: id,
    parentId: null,
    parent: null,
    countryOptionId: null,
    country: null,
    businessAmount: null,
    currencyCode: null
  };
}

function createBootstrapResult(tagIds: string[]) {
  return {
    list: {} as never,
    options: {
      sources: [createOption('source-1', 'customer_source')],
      tags: tagIds.map((id) => createOption(id, 'customer_tag')),
      services: []
    },
    generatedAt: new Date().toISOString()
  };
}

afterEach(() => {
  clearV2QueryCache();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('useQuickCustomerOptions', () => {
  it('reloads customer tags after an option mutation invalidates the shared scope', async () => {
    vi.useFakeTimers();
    const bootstrap = vi
      .spyOn(idBusinessV2CustomersApi, 'bootstrap')
      .mockResolvedValueOnce(createBootstrapResult(['tag-1']))
      .mockResolvedValueOnce(createBootstrapResult(['tag-1', 'tag-2']));
    const scope = effectScope();
    const options = scope.run(() => useQuickCustomerOptions());
    if (!options) return;

    await options.loadOptions();
    expect(options.tagOptions.value.map((option) => option.id)).toEqual(['tag-1']);

    invalidateV2Queries('options');
    await vi.advanceTimersByTimeAsync(100);
    await Promise.resolve();

    expect(bootstrap).toHaveBeenCalledTimes(2);
    expect(options.tagOptions.value.map((option) => option.id)).toEqual(['tag-1', 'tag-2']);
    scope.stop();
  });
});
