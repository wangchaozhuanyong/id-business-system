import { computed, reactive, ref } from 'vue';
import { describe, expect, it } from 'vitest';
import type { V2ManualRenewalOptions, V2RenewalWorkbenchItem } from './contracts';
import { useRenewalServiceSelection } from './useRenewalServiceSelection';

const services: V2ManualRenewalOptions['services'] = [
  createService('service-ai', 'category-ai', 'AI 工具'),
  createService('service-video', 'category-video', '影音订阅')
];

describe('useRenewalServiceSelection', () => {
  it('groups services by category for the selected account country', () => {
    const form = reactive({ categoryOptionId: 'category-ai', serviceOptionId: 'service-ai' });
    const selection = createSelection(form);

    expect(selection.availableCategories.value).toEqual([
      { id: 'category-ai', name: 'AI 工具' },
      { id: 'category-video', name: '影音订阅' }
    ]);
    expect(selection.categoryServices.value.map((service) => service.id)).toEqual(['service-ai']);
    expect(selection.selectedManualService.value?.id).toBe('service-ai');
  });

  it('keeps the current service for its category and clears it after changing categories', () => {
    const form = reactive({ categoryOptionId: 'category-ai', serviceOptionId: 'service-ai' });
    const selection = createSelection(form);

    selection.handleRenewalCategoryChange();
    expect(form.serviceOptionId).toBe('service-ai');

    form.categoryOptionId = 'category-video';
    selection.handleRenewalCategoryChange();
    expect(form.serviceOptionId).toBe('');
  });
});

function createSelection(form: { categoryOptionId: string; serviceOptionId: string }) {
  const options = computed<V2ManualRenewalOptions>(() => ({
    settlementPlatforms: [],
    services
  }));
  const selectedRenewal = ref({
    account: { country: { id: 'country-us' } }
  } as V2RenewalWorkbenchItem);
  return useRenewalServiceSelection(options, selectedRenewal, form);
}

function createService(
  id: string,
  categoryId: string,
  categoryName: string
): V2ManualRenewalOptions['services'][number] {
  return {
    id,
    code: id,
    name: id,
    category: { id: categoryId, name: categoryName },
    country: {
      id: 'country-us',
      code: 'US',
      name: '美国',
      currencyCode: 'USD'
    },
    businessAmount: '20',
    currencyCode: 'USD'
  };
}
