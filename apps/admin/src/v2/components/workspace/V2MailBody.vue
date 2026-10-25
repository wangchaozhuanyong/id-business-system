<template>
  <pre
    class="v2-mail-body"
  ><template v-for="(part, index) in parts" :key="index"><a v-if="part.href" :href="part.href" target="_blank" rel="noopener noreferrer nofollow">{{ part.text }}</a><template v-else>{{ part.text }}</template></template><template v-if="!parts.length">（无正文）</template></pre>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { mailBodyParts } from './mail-viewer';
const props = defineProps<{ body: string }>();
const parts = computed(() => mailBodyParts(props.body));
</script>

<style scoped>
.v2-mail-body {
  max-height: 480px;
  max-width: 100%;
  margin: 0;
  overflow: auto;
  color: var(--v2-text);
  font: inherit;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.v2-mail-body a {
  color: var(--v2-primary);
  text-decoration: underline;
}
</style>
