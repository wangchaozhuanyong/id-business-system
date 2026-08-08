import { shallowRef, watchEffect, type Directive, type ShallowRef } from 'vue';
import { isV2TableColumnVisible } from '@/v2/composables/useV2TablePreferences';

type V2TableColumnVisibilityBinding = readonly [tableId: string, columnKey: string];

interface V2TableColumnVisibilityState {
  binding: ShallowRef<V2TableColumnVisibilityBinding>;
  stop: () => void;
}

const stateByElement = new WeakMap<HTMLElement, V2TableColumnVisibilityState>();

export const v2TableColumnVisibility: Directive<HTMLElement, V2TableColumnVisibilityBinding> = {
  mounted(element, binding) {
    stateByElement.get(element)?.stop();
    const currentBinding = shallowRef(binding.value);
    const stop = watchEffect(() => {
      const [tableId, columnKey] = currentBinding.value;
      element.hidden = !isV2TableColumnVisible(tableId, columnKey);
    });
    stateByElement.set(element, { binding: currentBinding, stop });
  },
  updated(element, binding) {
    const state = stateByElement.get(element);
    if (state) state.binding.value = binding.value;
  },
  beforeUnmount(element) {
    stateByElement.get(element)?.stop();
    stateByElement.delete(element);
  }
};
