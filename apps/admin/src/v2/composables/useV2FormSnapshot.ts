import { computed, ref, watch } from 'vue';

export function useV2FormSnapshot<T>(visible: () => boolean, source: () => T) {
  const initialSnapshot = ref('');
  const currentSnapshot = computed(() => JSON.stringify(source()));
  const dirty = computed(
    () =>
      visible() && Boolean(initialSnapshot.value) && currentSnapshot.value !== initialSnapshot.value
  );

  function capture() {
    initialSnapshot.value = currentSnapshot.value;
  }

  watch(
    visible,
    (isVisible) => {
      if (isVisible) capture();
      else initialSnapshot.value = '';
    },
    { immediate: true, flush: 'post' }
  );

  return { dirty, capture };
}
