<template>
  <el-popover
    v-model:visible="visible"
    :placement="placement"
    trigger="manual"
    :width="width"
    :z-index="popperZIndex"
    popper-class="feature-help-popper"
  >
    <template #reference>
      <button
        v-bind="attrs"
        class="feature-help"
        :aria-expanded="visible ? 'true' : 'false'"
        :aria-haspopup="links.length ? 'dialog' : 'true'"
        :aria-label="accessibilityLabel"
        type="button"
        @blur="scheduleHide"
        @click.stop.prevent="toggle"
        @focus="show"
        @keydown.esc.stop.prevent="close"
      >
        <span class="feature-help__marker" aria-hidden="true">
          <el-icon>
            <QuestionFilled />
          </el-icon>
        </span>
      </button>
    </template>
    <span
      class="feature-help-popper__content"
      :role="links.length ? 'dialog' : 'tooltip'"
      @click.stop
      @focusin="show"
      @focusout="scheduleHide"
      @mouseenter="show"
      @mouseleave="scheduleHide"
    >
      <strong v-if="title">{{ title }}</strong>
      <span v-for="item in helpItems" :key="item">{{ item }}</span>
      <span v-if="links.length" class="feature-help-popper__links">
        <a
          v-for="link in links"
          :key="`${link.href}-${link.label}`"
          :href="link.href"
          target="_blank"
          rel="noopener noreferrer"
        >
          {{ link.label }}
        </a>
      </span>
    </span>
  </el-popover>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useAttrs } from 'vue';
import { QuestionFilled } from '@element-plus/icons-vue';
import { useZIndex } from 'element-plus/es/hooks/use-z-index/index.mjs';

interface FeatureHelpLink {
  href: string;
  label: string;
}

defineOptions({
  inheritAttrs: false
});

const props = withDefaults(
  defineProps<{
    text: string | string[];
    title?: string;
    placement?: 'top' | 'bottom' | 'left' | 'right';
    width?: number;
    links?: readonly FeatureHelpLink[];
  }>(),
  {
    title: '',
    placement: 'top',
    width: 320,
    links: () => []
  }
);

const attrs = useAttrs();
const { nextZIndex } = useZIndex();
const visible = ref(false);
const pinned = ref(false);
const popperZIndex = ref<number>();
let hideTimer: number | undefined;
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
  if (hideTimer !== undefined) {
    window.clearTimeout(hideTimer);
    hideTimer = undefined;
  }
  if (!visible.value) popperZIndex.value = nextZIndex();
  visible.value = true;
}

function scheduleHide() {
  if (pinned.value) return;
  if (hideTimer !== undefined) window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    hideTimer = undefined;
    if (!pinned.value) visible.value = false;
  }, 180);
}

function toggle() {
  pinned.value = !pinned.value;
  if (pinned.value) {
    show();
    return;
  }
  visible.value = false;
}

function close() {
  if (hideTimer !== undefined) {
    window.clearTimeout(hideTimer);
    hideTimer = undefined;
  }
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
  if (hideTimer !== undefined) window.clearTimeout(hideTimer);
  document.removeEventListener('click', closeFromDocument);
});
</script>
