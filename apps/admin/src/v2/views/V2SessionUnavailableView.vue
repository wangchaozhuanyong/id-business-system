<template>
  <V2BootGate
    :state="authStore.session.kind === 'validating' ? 'session-checking' : 'degraded'"
    degraded-reason="session"
    @retry="retrySession"
  />
</template>

<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import V2BootGate from '@/v2/components/V2BootGate.vue';
import { navigateSafely } from '@/v2/router/navigateSafely';
import { getSafeV2Redirect } from '@/v2/router/passwordReset';

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();

async function retrySession() {
  const resolution = await authStore.ensureSessionReady({
    force: true,
    source: 'manual-retry'
  });
  if (resolution === 'ready') {
    await navigateSafely(router, getSafeV2Redirect(route.query.redirect), 'replace');
    return;
  }
  if (resolution === 'anonymous') {
    await navigateSafely(
      router,
      { path: '/login', query: { redirect: getSafeV2Redirect(route.query.redirect) } },
      'replace'
    );
    return;
  }
  if (resolution === 'blocked') {
    const target =
      authStore.session.kind === 'blocked' && authStore.session.reason === 'password-reset'
        ? '/change-password'
        : '/403';
    await navigateSafely(router, target, 'replace');
  }
}
</script>
