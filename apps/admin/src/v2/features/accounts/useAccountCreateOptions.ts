import type { Ref } from 'vue';
import { getApiErrorMessage } from '@/api/client';
import { idBusinessV2OptionsApi } from '@/v2/api/options';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import type { AccountFormState } from './account-form';
import type { V2Account, V2OptionSelector } from './contracts';

interface AccountCreateOptionsContext {
  countryOptions: Ref<V2OptionSelector[]>;
  statusOptions: Ref<V2OptionSelector[]>;
  supplierOptions: Ref<V2OptionSelector[]>;
  drawerVisible: Ref<boolean>;
  editingItem: Ref<V2Account | null>;
  form: AccountFormState;
}

export function useAccountCreateOptions(context: AccountCreateOptionsContext) {
  return async function refreshCreateOptions() {
    try {
      const [countries, statuses, suppliers] = await Promise.all([
        idBusinessV2OptionsApi.listSelectors('country', undefined, { force: true }),
        idBusinessV2OptionsApi.listSelectors('id_status', undefined, { force: true }),
        idBusinessV2OptionsApi.listSelectors('id_supplier', undefined, { force: true })
      ]);
      context.countryOptions.value = countries.items;
      context.statusOptions.value = statuses.items;
      context.supplierOptions.value = suppliers.items;
      if (!context.editingItem.value && context.drawerVisible.value) {
        const normalStatus = statuses.items.find((option) => option.code === 'normal');
        if (!context.form.countryOptionId)
          context.form.countryOptionId = countries.items[0]?.id ?? '';
        if (!context.form.statusOptionId) context.form.statusOptionId = normalStatus?.id ?? '';
      }
    } catch (error) {
      ElMessage.error(`最新选项加载失败：${getApiErrorMessage(error)}`);
    }
  };
}
