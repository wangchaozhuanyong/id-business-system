<template>
  <span class="v2-brand-logo" :class="{ 'is-image': resolvedLogoUrl }" aria-hidden="true">
    <img
      v-if="resolvedLogoUrl"
      class="v2-brand-logo__image"
      :src="resolvedLogoUrl"
      alt=""
      decoding="async"
      @error="handleImageError"
    />
    <b v-else class="v2-brand-logo__fallback">{{ resolvedLogoText }}</b>
  </span>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { V2_BRANDING_DEFAULTS } from '@apple-business/shared';

const props = defineProps<{
  logoUrl?: string;
  logoText?: string;
}>();

const imageFailed = ref(false);
const normalizedLogoUrl = computed(() => props.logoUrl?.trim() || '');
const resolvedLogoUrl = computed(() => (imageFailed.value ? '' : normalizedLogoUrl.value));
const resolvedLogoText = computed(() => props.logoText?.trim() || V2_BRANDING_DEFAULTS.logoText);

watch(normalizedLogoUrl, () => {
  imageFailed.value = false;
});

function handleImageError() {
  imageFailed.value = true;
}
</script>

<style scoped>
.v2-brand-logo {
  overflow: hidden;
}

.v2-brand-logo.is-image {
  border-color: transparent;
  background: transparent;
  box-shadow: none;
}

.v2-brand-logo__image {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.v2-brand-logo__fallback {
  font: inherit;
}
</style>
