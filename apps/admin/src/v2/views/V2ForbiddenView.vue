<template>
  <main class="v2-forbidden-page">
    <section class="v2-forbidden-card" aria-labelledby="v2-forbidden-title">
      <span class="v2-forbidden-code" aria-hidden="true">403</span>
      <h1 id="v2-forbidden-title">权限不足</h1>
      <p>当前账号没有权限访问这个页面，请联系管理员分配对应角色或查看权限。</p>
      <AppButton variant="primary" :loading="returning" @click="returnToAllowedPage">
        返回可访问页面
      </AppButton>
    </section>
  </main>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import AppButton from '@/components/ui/AppButton.vue';
import { useAuthStore } from '@/stores/auth';
import { getFirstAllowedV2Route } from '@/v2/router/permissionRedirect';
import { navigateSafely } from '@/v2/router/navigateSafely';

const router = useRouter();
const authStore = useAuthStore();
const returning = ref(false);

async function returnToAllowedPage() {
  if (returning.value) return;
  returning.value = true;
  try {
    await navigateSafely(router, getFirstAllowedV2Route(authStore.user), 'replace');
  } finally {
    returning.value = false;
  }
}
</script>

<style scoped>
.v2-forbidden-page {
  display: grid;
  min-height: 100dvh;
  place-items: center;
  padding: 24px;
  overflow: auto;
  background: var(--v3-bg);
}

.v2-forbidden-card {
  display: grid;
  width: min(100%, 460px);
  justify-items: center;
  gap: 16px;
  padding: 44px 32px;
  border: 1px solid var(--v3-border);
  border-radius: var(--v3-radius-lg);
  background: var(--v3-surface);
  box-shadow: var(--v3-shadow-md);
  text-align: center;
}

.v2-forbidden-code {
  color: var(--v3-primary);
  font-size: clamp(48px, 15vw, 76px);
  font-weight: var(--v3-font-weight-bold);
  line-height: 1;
}

.v2-forbidden-card h1 {
  margin: 0;
  color: var(--v3-text);
  font-size: 24px;
}

.v2-forbidden-card p {
  max-width: 360px;
  margin: 0 0 8px;
  color: var(--v3-text-soft);
}

@media (max-width: 520px) {
  .v2-forbidden-page {
    padding: 16px;
  }

  .v2-forbidden-card {
    gap: 14px;
    padding: 36px 20px;
  }
}
</style>
