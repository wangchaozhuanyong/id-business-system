<template>
  <el-input
    v-bind="$attrs"
    :model-value="input"
    @update:model-value="updateInput"
    @compositionstart="startComposition"
    @compositionend="endComposition"
    @keydown.enter="submitEnter"
    @clear="clearInput"
  />
</template>

<script setup lang="ts">
import { onMounted, onScopeDispose, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useV2SessionDraft } from '@/v2/composables/useV2SessionDraft';
import { createV2SearchCommit, registerV2SearchInput } from '@/v2/composables/useV2AutoSearch';

defineOptions({ inheritAttrs: false });
const props = defineProps<{ modelValue?: string | null; draftKey: string; minLength?: number }>();
const emit = defineEmits<{ 'update:modelValue': [value: string]; search: [] }>();
const input = useV2SessionDraft(`search-input:${useRoute().path}:${props.draftKey}`, () =>
  ref(props.modelValue ?? '')
);
let applied = props.modelValue ?? '';
let composing = false;
const pending = createV2SearchCommit(() => {
  if (composing) return;
  const value = input.value.trim();
  if (value && value.length < (props.minLength ?? 0)) return;
  if (value === applied) return;
  applied = value;
  emit('update:modelValue', value);
  emit('search');
});
function updateInput(value: string) {
  input.value = value;
  if (composing) return;
  if (!value.trim()) pending.flush();
  else pending.schedule();
}
function clearInput() {
  input.value = '';
  pending.flush();
}
function startComposition() {
  composing = true;
  pending.cancel();
}
function endComposition() {
  composing = false;
  pending.schedule();
}
function submitEnter(event: KeyboardEvent) {
  if (composing || event.isComposing) return;
  event.preventDefault();
  pending.flush();
}
watch(
  () => props.modelValue,
  (value) => {
    const next = value ?? '';
    if (next === applied) return;
    pending.cancel();
    applied = next;
    input.value = next;
  },
  { flush: 'sync' }
);
const unregister = registerV2SearchInput(props.draftKey, () => {
  pending.cancel();
  input.value = '';
  applied = '';
});
onMounted(() => {
  if (input.value.trim() !== applied) pending.flush();
});
onScopeDispose(() => {
  pending.cancel();
  unregister();
});
</script>
