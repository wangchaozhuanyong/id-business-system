<template>
  <main class="v2-boot-gate">
    <section class="v2-boot-gate__panel" :aria-busy="isLoading">
      <span class="v2-boot-gate__mark" aria-hidden="true">ID</span>
      <div class="v2-boot-gate__copy" role="status" aria-live="polite">
        <strong>{{ title }}</strong>
        <p>{{ description }}</p>
      </div>
      <span v-if="isLoading" class="v2-boot-gate__progress" aria-hidden="true" />
      <button v-else class="v2-boot-gate__retry" type="button" @click="$emit('retry')">
        {{ state === 'fatal' ? '重新加载' : '重新连接' }}
      </button>
    </section>
  </main>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  state: 'booting' | 'session-checking' | 'route-loading' | 'ready' | 'degraded' | 'fatal';
  degradedReason?: 'session' | 'route';
}>();

defineEmits<{
  retry: [];
}>();

const isLoading = computed(() =>
  ['booting', 'session-checking', 'route-loading'].includes(props.state)
);
const title = computed(() => {
  if (isLoading.value) return '正在安全打开页面';
  if (props.state === 'fatal') return '应用无法继续运行';
  if (props.degradedReason === 'route') return '页面资源加载失败';
  return '暂时无法确认登录状态';
});
const description = computed(() => {
  if (isLoading.value) return '正在核验身份并准备页面，请稍候。';
  if (props.state === 'fatal') return '页面核心发生错误，请重新加载应用。';
  if (props.degradedReason === 'route') return '当前没有展示任何业务数据，请检查网络后重试。';
  return '当前没有展示任何业务数据。请检查网络后重新连接。';
});
</script>

<style scoped>
.v2-boot-gate {
  display: grid;
  min-height: 100dvh;
  place-items: center;
  padding: 24px;
  background: var(--v3-bg);
}

.v2-boot-gate__panel {
  display: grid;
  width: min(100%, 420px);
  justify-items: center;
  gap: 18px;
  padding: 40px 34px;
  border: 1px solid var(--v3-border);
  border-radius: var(--v3-radius-lg);
  background: var(--v3-surface);
  box-shadow: var(--v3-shadow-sm);
  text-align: center;
}

.v2-boot-gate__mark {
  display: grid;
  width: 42px;
  height: 42px;
  place-items: center;
  border-radius: 9px;
  background: var(--v3-primary-solid);
  color: var(--v3-on-primary-solid);
  font-weight: 800;
}

.v2-boot-gate__copy strong {
  color: var(--v3-text);
  font-size: 17px;
}

.v2-boot-gate__copy p {
  margin: 8px 0 0;
  color: var(--v3-text-soft);
  line-height: 1.65;
}

.v2-boot-gate__progress {
  width: 120px;
  height: 3px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--v3-border-soft);
}

.v2-boot-gate__progress::after {
  display: block;
  width: 45%;
  height: 100%;
  border-radius: inherit;
  animation: v2-boot-gate-progress 1s var(--v3-ease) infinite alternate;
  background: var(--v3-primary);
  content: '';
}

.v2-boot-gate__retry {
  min-height: 38px;
  padding: 0 16px;
  border: 0;
  border-radius: var(--v3-radius-sm);
  background: var(--v3-primary-solid);
  color: var(--v3-on-primary-solid);
  cursor: pointer;
  font: inherit;
  font-weight: 600;
}

.v2-boot-gate__retry:focus-visible {
  outline: none;
  box-shadow: var(--v3-focus-ring);
}

@keyframes v2-boot-gate-progress {
  from {
    transform: translateX(-70%);
  }
  to {
    transform: translateX(120%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .v2-boot-gate__progress::after {
    animation: none;
    transform: none;
  }
}
</style>
