<template>
  <el-popover
    v-model:visible="visible"
    :placement="placement"
    trigger="manual"
    :width="width"
    popper-class="feature-help-popper"
  >
    <template #reference>
      <button
        v-bind="attrs"
        class="feature-help"
        :aria-expanded="visible ? 'true' : 'false'"
        aria-haspopup="true"
        :aria-label="accessibilityLabel"
        type="button"
        @blur="hide"
        @click.stop.prevent="toggle"
        @focus="show"
        @keydown.esc.stop.prevent="close"
        @keydown.enter.prevent="toggle"
        @keydown.space.prevent="toggle"
        @mouseenter="show"
        @mouseleave="hide"
      >
        <span class="feature-help__marker" aria-hidden="true">
          <el-icon>
            <QuestionFilled />
          </el-icon>
        </span>
      </button>
    </template>
    <span class="feature-help-popper__content" role="tooltip" @click.stop>
      <strong v-if="title">{{ title }}</strong>
      <span v-for="item in helpItems" :key="item">{{ item }}</span>
    </span>
  </el-popover>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useAttrs } from 'vue';
import { QuestionFilled } from '@element-plus/icons-vue';

defineOptions({
  inheritAttrs: false
});

const props = withDefaults(
  defineProps<{
    text: string | string[];
    title?: string;
    placement?: 'top' | 'bottom' | 'left' | 'right';
    width?: number;
  }>(),
  {
    title: '',
    placement: 'top',
    width: 320
  }
);

const attrs = useAttrs();
const visible = ref(false);
const pinned = ref(false);
const helpItems = computed(() => {
  const items = Array.isArray(props.text) ? props.text : [props.text];
  return items.map((item) => item.trim()).filter(Boolean);
});
const accessibilityLabel = computed(() =>
  props.title
    ? `${props.title}：${helpItems.value.join(' ')}`
    : `说明：${helpItems.value.join(' ')}`
);

function show() {
  visible.value = true;
}

function hide() {
  if (pinned.value) return;
  visible.value = false;
}

function toggle() {
  pinned.value = !pinned.value;
  visible.value = pinned.value;
}

function close() {
  pinned.value = false;
  visible.value = false;
}

function closeFromDocument() {
  close();
}

onMounted(() => {
  document.addEventListener('click', closeFromDocument);
});

onBeforeUnmount(() => {
  document.removeEventListener('click', closeFromDocument);
});
</script>
