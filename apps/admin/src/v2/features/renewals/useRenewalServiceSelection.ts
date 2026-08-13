import { computed, type ComputedRef, type Ref } from 'vue';
import type { V2ManualRenewalOptions, V2RenewalWorkbenchItem } from './contracts';

interface RenewalServiceForm {
  categoryOptionId: string;
  serviceOptionId: string;
}

export function useRenewalServiceSelection(
  options: ComputedRef<V2ManualRenewalOptions>,
  selectedRenewal: Readonly<Ref<V2RenewalWorkbenchItem | null>>,
  form: RenewalServiceForm
) {
  const availableServices = computed(() => {
    const countryId = selectedRenewal.value?.account.country.id;
    if (!countryId) return [];
    return options.value.services.filter((service) => service.country?.id === countryId);
  });
  const availableCategories = computed(() => {
    const categories = new Map<string, { id: string; name: string }>();
    for (const service of availableServices.value) {
      if (service.category) categories.set(service.category.id, service.category);
    }
    return [...categories.values()];
  });
  const categoryServices = computed(() =>
    availableServices.value.filter((service) => service.category?.id === form.categoryOptionId)
  );
  const selectedManualService = computed(
    () => availableServices.value.find((service) => service.id === form.serviceOptionId) ?? null
  );

  function handleRenewalCategoryChange() {
    const currentServiceMatchesCategory = availableServices.value.some(
      (service) =>
        service.id === form.serviceOptionId && service.category?.id === form.categoryOptionId
    );
    if (!currentServiceMatchesCategory) form.serviceOptionId = '';
  }

  return {
    availableServices,
    availableCategories,
    categoryServices,
    selectedManualService,
    handleRenewalCategoryChange
  };
}
